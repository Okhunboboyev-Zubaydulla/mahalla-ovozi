import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, inArray, sql, gt, lt, desc, isNotNull, ne } from 'drizzle-orm';
import { findUniqueViolation, type DbClient } from '../../../adapters/db/client.js';
import {
  districts,
  telegramIntakeRecords,
  aiOperations,
  aiProfiles,
} from '../../../adapters/db/schema/index.js';
import {
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  withTransactionalIntake,
  JobSingletonKeys,
  type TelegramSemanticRelevanceJobData,
  type TelegramTopicAssignmentJobData,
  type ForwardMetadata,
} from '../../../adapters/jobs/boss-client.js';
import { insertAiProviderAttempts } from '../ai-operation-repository.js';
import {
  getMahallaDailySnapshot,
  type AcceptedEvidenceItem,
} from '../context-snapshot.js';
import type {
  SemanticRelevanceEvaluator,
  PrecedingMessageContext,
  ChatContinuityContext,
  ParentReplyContext,
  ExclusionReason,
  ReplyChainAncestor,
  ChatTranscriptMessage,
} from '../semantic-relevance-evaluator.js';
import {
  hasSelfContainedCivicSignal,
  matchesCivicLaneKeyword,
  hasContextualFollowUpSignal,
  extractForwardOriginMetadata,
  extractReplyMetadata,
} from '../../telegram-intake/telegram-content-qualification.js';
import { districtAnalysisSettingsService } from '../district-analysis-settings-service.js';
import {
  extractVerbatimDisplayText,
  resolveTelegramMessageObject,
} from '../../telegram-intake/telegram-payload-text.js';
import type { TelegramMessage } from '../../../adapters/telegram/telegram-types.js';
import { clearPendingRetryFlag } from '../../issues/retry-service.js';
import { DEBUG_PAYLOAD_RETENTION_MS } from '../../retention/debug-payload-retention.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isTelegramForumTopicRoot(raw: Record<string, unknown> | null): boolean {
  if (!raw) return false;
  if (raw.forumTopic === true || raw.forum_topic_created != null) return true;
  const msg = resolveTelegramMessageObject(raw) ?? (raw.message_id ? raw : null);
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    if (m.forum_topic_created != null || (m as any).forumTopic === true) return true;
  }
  return false;
}

interface ResolvedAncestor {
  intakeId: string;
  messageId: string;
  status: 'RELEVANT' | 'EXCLUDED' | 'PENDING' | 'NOT_FOUND';
  exclusionReason?: ExclusionReason | null;
  text?: string | null;
  lanes?: string[] | null;
}

async function resolveReplyChain(
  db: DbClient,
  districtId: string,
  telegramChatId: string,
  startReplyToMessageId: string,
): Promise<{
  ancestors: ResolvedAncestor[];
  isInitialReplyForumTopic: boolean;
}> {
  const ancestors: ResolvedAncestor[] = [];
  let currentMsgId: string | null = startReplyToMessageId;
  const visited = new Set<string>();

  for (let hop = 0; hop < 3 && currentMsgId; hop++) {
    if (visited.has(currentMsgId)) break;
    visited.add(currentMsgId);

    const [intake] = await db
      .select({
        id: telegramIntakeRecords.id,
        status: telegramIntakeRecords.status,
        rawPayload: telegramIntakeRecords.rawPayload,
        telegramMessageId: telegramIntakeRecords.telegramMessageId,
      })
      .from(telegramIntakeRecords)
      .where(
        and(
          eq(telegramIntakeRecords.districtId, districtId),
          eq(telegramIntakeRecords.telegramChatId, telegramChatId),
          eq(telegramIntakeRecords.telegramMessageId, currentMsgId),
        ),
      )
      .limit(1);

    if (!intake) {
      ancestors.push({
        intakeId: '',
        messageId: currentMsgId,
        status: 'NOT_FOUND',
      });
      break;
    }

    const raw = asRecord(intake.rawPayload);
    if (isTelegramForumTopicRoot(raw)) {
      if (hop === 0) {
        return { ancestors: [], isInitialReplyForumTopic: true };
      }
      break;
    }

    const parentVerbatimText = extractVerbatimDisplayText(null, raw);
    const isExcludedAtQualification = raw?.status === 'EXCLUDED' || intake.status === 'EXCLUDED';
    const qualificationReason =
      typeof raw?.exclusionReason === 'string' ? raw.exclusionReason : null;

    const [parentOp] = await db
      .select({
        id: aiOperations.id,
        finalStatus: aiOperations.finalStatus,
        resultPayload: aiOperations.resultPayload,
      })
      .from(aiOperations)
      .where(
        and(
          eq(aiOperations.districtId, districtId),
          eq(aiOperations.operationType, 'SEMANTIC_RELEVANCE'),
          eq(aiOperations.targetId, intake.id),
        ),
      )
      .limit(1);

    const isExcludedAtAi = parentOp?.finalStatus === 'COMPLETED_IRRELEVANT';
    const isRelevantAtAi = parentOp?.finalStatus === 'COMPLETED_RELEVANT';
    const aiPayload = asRecord(parentOp?.resultPayload);
    const aiExclusionReason =
      typeof aiPayload?.exclusion_reason === 'string' ? aiPayload.exclusion_reason : null;

    const lanes = Array.isArray(aiPayload?.relevant_lanes)
      ? (aiPayload?.relevant_lanes as string[])
      : null;

    let status: 'RELEVANT' | 'EXCLUDED' | 'PENDING' = 'PENDING';
    let exclusionReason: ExclusionReason | null = null;

    if (isRelevantAtAi) {
      status = 'RELEVANT';
    } else if (isExcludedAtQualification || isExcludedAtAi) {
      status = 'EXCLUDED';
      exclusionReason = (aiExclusionReason || qualificationReason || 'GENERAL_CHATTER') as ExclusionReason;
    }

    ancestors.push({
      intakeId: intake.id,
      messageId: currentMsgId,
      status,
      exclusionReason,
      text: parentVerbatimText,
      lanes,
    });

    const msgObj = resolveTelegramMessageObject(raw) ?? (raw?.message_id ? raw : null);
    let nextReplyToId: string | null = null;
    if (msgObj && typeof msgObj === 'object') {
      const meta = extractReplyMetadata(msgObj as TelegramMessage);
      nextReplyToId = meta?.replyToMessageId ?? null;
      if (!nextReplyToId && (msgObj as any).reply_to_message?.message_id != null) {
        nextReplyToId = String((msgObj as any).reply_to_message.message_id);
      }
    }

    currentMsgId = nextReplyToId;
  }

  return { ancestors, isInitialReplyForumTopic: false };
}

export interface SemanticRelevanceJobDeps {
  db: DbClient;
  pool: pg.Pool;
  boss: PgBoss;
  relevanceEvaluator: SemanticRelevanceEvaluator;
  injectedEvidenceResolver?: (
    districtId: string,
    mahallaName: string,
    calendarDay: string,
  ) => Promise<AcceptedEvidenceItem[] | undefined>;
}

export async function processSemanticRelevanceJobs(
  jobs: PgBoss.Job<TelegramSemanticRelevanceJobData>[],
  deps: SemanticRelevanceJobDeps,
): Promise<void> {
  const { db, pool, boss, relevanceEvaluator } = deps;
  const options = deps;
      for (const job of jobs) {
        let {
          intakeId,
          districtId,
          mahallaName,
          calendarDay,
          telegramChatId,
          telegramMessageId,
          telegramUserId,
          originalTimestamp,
          contentType,
          verbatimText,
          replyMetadata,
          forwardMetadata,
          userMetadata,
          burstMessages,
        } = job.data;

        telegramUserId = telegramUserId ?? userMetadata?.telegramUserId;
        const authorHandle = userMetadata?.username
          ? `@${userMetadata.username}`
          : userMetadata?.firstName || undefined;

        const startTime = performance.now();

        try {
          // Idempotency check: if this intake already has a completed AI relevance decision, skip
          const [existingOp] = await db
            .select({
              id: aiOperations.id,
              finalStatus: aiOperations.finalStatus,
            })
            .from(aiOperations)
            .where(
              and(
                eq(aiOperations.districtId, districtId),
                eq(aiOperations.operationType, 'SEMANTIC_RELEVANCE'),
                eq(aiOperations.targetId, intakeId),
              ),
            )
            .limit(1);

          if (existingOp) {
            const durationMs = Math.round(performance.now() - startTime);
            console.log(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_RELEVANCE_SKIPPED_DUPLICATE',
                intakeId,
                districtId,
                mahallaName,
                telegramChatId,
                telegramMessageId,
                existingOperationId: existingOp.id,
                finalStatus: existingOp.finalStatus,
                durationMs,
              }),
            );
            continue;
          }

          // Gate 1: Pre-AI District Lifecycle Verification (AC 13 / Matrix #20)
          const [districtGate1] = await db
            .select({
              id: districts.id,
              status: districts.status,
              accessEligible: districts.accessEligible,
            })
            .from(districts)
            .where(eq(districts.id, districtId))
            .limit(1);

          if (
            !districtGate1 ||
            (districtGate1.status !== 'ACTIVE' && districtGate1.status !== 'GRACE') ||
            districtGate1.accessEligible === false
          ) {
            const durationMs = Math.round(performance.now() - startTime);
            console.log(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_DROPPED_INACTIVE_DISTRICT',
                districtId,
                mahallaName,
                telegramChatId,
                telegramMessageId,
                districtStatus: districtGate1?.status ?? 'NOT_FOUND',
                accessEligible: districtGate1?.accessEligible ?? false,
                durationMs,
              }),
            );
            continue;
          }

          // Layer 1: Forward-Origin Deduplication Gate
          let effectiveForwardMetadata: ForwardMetadata | null = forwardMetadata ?? null;

          if (!effectiveForwardMetadata) {
            try {
              const [candidateRec] = await db
                .select({
                  id: telegramIntakeRecords.id,
                  rawPayload: telegramIntakeRecords.rawPayload,
                })
                .from(telegramIntakeRecords)
                .where(eq(telegramIntakeRecords.id, intakeId))
                .limit(1);

              if (candidateRec?.rawPayload) {
                const rawRecord = asRecord(candidateRec.rawPayload);
                const msgObj =
                  resolveTelegramMessageObject(rawRecord) ??
                  (rawRecord?.message_id ? rawRecord : null);
                if (msgObj) {
                  effectiveForwardMetadata = extractForwardOriginMetadata(
                    msgObj as TelegramMessage,
                  );
                }
              }
            } catch (lookupErr) {
              console.warn(
                JSON.stringify({
                  event: 'TELEGRAM_SEMANTIC_FORWARD_METADATA_LOOKUP_FAILED',
                  intakeId,
                  districtId,
                  error: (lookupErr as Error).message,
                }),
              );
            }
          }

          if (
            effectiveForwardMetadata?.originChatId &&
            effectiveForwardMetadata?.originMessageId
          ) {
            const targetOriginChatId = effectiveForwardMetadata.originChatId;
            const targetOriginMessageId = effectiveForwardMetadata.originMessageId;

            let isDuplicateForward = false;
            try {
              const previousRecords = await db
                .select({
                  id: telegramIntakeRecords.id,
                  rawPayload: telegramIntakeRecords.rawPayload,
                })
                .from(telegramIntakeRecords)
                .where(
                  and(
                    eq(telegramIntakeRecords.districtId, districtId),
                    eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                    eq(telegramIntakeRecords.calendarDay, calendarDay),
                    ne(telegramIntakeRecords.id, intakeId),
                    isNotNull(telegramIntakeRecords.processedAt),
                  ),
                );

              for (const prev of previousRecords) {
                const prevRaw = asRecord(prev.rawPayload);
                if (!prevRaw) continue;

                // 1. Direct forwardMetadata if stamped
                const prevMetaDirect = prevRaw.forwardMetadata as ForwardMetadata | undefined;
                if (
                  prevMetaDirect &&
                  prevMetaDirect.originChatId === targetOriginChatId &&
                  prevMetaDirect.originMessageId === targetOriginMessageId
                ) {
                  isDuplicateForward = true;
                  break;
                }

                // 2. Direct forwardOrigin object if stamped in exclusionMeta
                const prevForwardOrigin = prevRaw.forwardOrigin as
                  | { chatId?: string; messageId?: string }
                  | undefined;
                if (
                  prevForwardOrigin &&
                  String(prevForwardOrigin.chatId) === targetOriginChatId &&
                  String(prevForwardOrigin.messageId) === targetOriginMessageId
                ) {
                  isDuplicateForward = true;
                  break;
                }

                // 3. Extract from raw Telegram message envelope
                const prevMsg =
                  resolveTelegramMessageObject(prevRaw) ??
                  (prevRaw.message_id ? prevRaw : null);
                if (prevMsg) {
                  const prevMeta = extractForwardOriginMetadata(prevMsg as TelegramMessage);
                  if (
                    prevMeta &&
                    prevMeta.originChatId === targetOriginChatId &&
                    prevMeta.originMessageId === targetOriginMessageId
                  ) {
                    isDuplicateForward = true;
                    break;
                  }
                }
              }
            } catch (dedupErr) {
              console.warn(
                JSON.stringify({
                  event: 'TELEGRAM_SEMANTIC_FORWARD_DEDUP_QUERY_FAILED',
                  intakeId,
                  districtId,
                  telegramChatId,
                  error: (dedupErr as Error).message,
                }),
              );
            }

            if (isDuplicateForward) {
              const [activeProfile] = await db
                .select({ id: aiProfiles.id })
                .from(aiProfiles)
                .where(
                  and(
                    eq(aiProfiles.operationType, 'SEMANTIC_RELEVANCE'),
                    eq(aiProfiles.isActive, true),
                  ),
                )
                .orderBy(desc(aiProfiles.version))
                .limit(1);

              const fallbackProfileId = activeProfile?.id ?? 'prof_rel_default';
              const finalExclusionReason: ExclusionReason = 'DUPLICATE_FORWARD_ORIGIN';
              const fastFailReasoning = `Deterministic deduplication: Channel post (${targetOriginChatId}:${targetOriginMessageId}) already processed in this chat today`;

              const allBurstIntakes =
                burstMessages && burstMessages.length > 0
                  ? burstMessages
                  : [{ intakeId, telegramMessageId }];

              const aiOperationId = `aiop_${crypto.randomUUID()}`;

              await withTransactionalIntake(pool, boss, async ({ tx }) => {
                for (const item of allBurstIntakes) {
                  const opId =
                    item.intakeId === intakeId ? aiOperationId : `aiop_${crypto.randomUUID()}`;
                  await tx
                    .insert(aiOperations)
                    .values({
                      id: opId,
                      districtId,
                      mahallaName,
                      calendarDay,
                      operationType: 'SEMANTIC_RELEVANCE',
                      targetId: item.intakeId,
                      pinnedProfileId: fallbackProfileId,
                      contextRevision: 0,
                      snapshotFingerprint: 'fast_fail_duplicate_forward',
                      finalStatus: 'COMPLETED_IRRELEVANT',
                      resultPayload: {
                        is_relevant: false,
                        relevant_lanes: [],
                        exclusion_reason: finalExclusionReason,
                        accepted_message_ids: [],
                        reasoning: fastFailReasoning,
                      },
                    })
                    .onConflictDoNothing();
                }

                const allIntakeIds = allBurstIntakes.map((m) => m.intakeId);
                const expiresAt = new Date(Date.now() + DEBUG_PAYLOAD_RETENTION_MS).toISOString();
                const exclusionMeta = JSON.stringify({
                  status: 'EXCLUDED',
                  exclusionReason: finalExclusionReason,
                  forwardOrigin: {
                    chatId: targetOriginChatId,
                    messageId: targetOriginMessageId,
                  },
                  verbatimText,
                  reasoning: fastFailReasoning,
                  expiresAt,
                  purgedAt: null,
                });

                await tx
                  .update(telegramIntakeRecords)
                  .set({
                    status: 'EXCLUDED',
                    rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                    processedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(inArray(telegramIntakeRecords.id, allIntakeIds));

                verbatimText = '';
              });

              const durationMs = Math.round(performance.now() - startTime);
              console.log(
                JSON.stringify({
                  event: 'TELEGRAM_SEMANTIC_EXCLUDED_DUPLICATE_FORWARD',
                  districtId,
                  mahallaName,
                  calendarDay,
                  telegramChatId,
                  telegramMessageId,
                  aiOperationId,
                  originChatId: targetOriginChatId,
                  originMessageId: targetOriginMessageId,
                  durationMs,
                }),
              );
              continue;
            }
          }

          const candidateTimestamp = new Date(originalTimestamp);
          const candidateTimeMs = candidateTimestamp.getTime();
          const twentyMinMs = 20 * 60 * 1000;
          const twentyMinutesAgo = new Date(candidateTimeMs - twentyMinMs);

          let hasActiveOutageWindow = false;
          let activeOutageRelevantOp: {
            id: string;
            originalTimestamp: Date;
            resultPayload: unknown;
            rawPayload: unknown;
            telegramMessageId: string;
            telegramUserId: string | null;
          } | null = null;

          try {
            const recentOutages = await db
              .select({
                id: aiOperations.id,
                originalTimestamp: telegramIntakeRecords.originalTimestamp,
                resultPayload: aiOperations.resultPayload,
                rawPayload: telegramIntakeRecords.rawPayload,
                telegramMessageId: telegramIntakeRecords.telegramMessageId,
                telegramUserId: telegramIntakeRecords.telegramUserId,
              })
              .from(aiOperations)
              .innerJoin(telegramIntakeRecords, eq(aiOperations.targetId, telegramIntakeRecords.id))
              .where(
                and(
                  eq(telegramIntakeRecords.districtId, districtId),
                  eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                  eq(telegramIntakeRecords.calendarDay, calendarDay),
                  eq(aiOperations.finalStatus, 'COMPLETED_RELEVANT'),
                  gt(telegramIntakeRecords.originalTimestamp, twentyMinutesAgo),
                  lt(telegramIntakeRecords.originalTimestamp, candidateTimestamp),
                ),
              )
              .orderBy(desc(telegramIntakeRecords.originalTimestamp))
              .limit(10);

            const keyedOutage = recentOutages.find((op) => {
              const text = extractVerbatimDisplayText(null, op.rawPayload);
              return text && (matchesCivicLaneKeyword(text) || hasSelfContainedCivicSignal(text));
            });

            if (keyedOutage) {
              hasActiveOutageWindow = true;
              activeOutageRelevantOp = keyedOutage;
            }
          } catch (outageErr) {
            console.warn(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_ACTIVE_OUTAGE_LOOKUP_FAILED',
                districtId,
                telegramChatId,
                error: (outageErr as Error).message,
              }),
            );
          }

          // Layer 1: Multi-Hop Reply Resolution & Poison-Pill Excluded Parent Gate
          let parentReplyContext: ParentReplyContext | null = null;
          let replyChainForAi: ReplyChainAncestor[] | null = null;
          let shouldFastFailExcludedParent = false;
          let parentExclusionReason: ExclusionReason | null = null;

          if (replyMetadata?.replyToMessageId) {
            const currentReplyToMessageId = replyMetadata.replyToMessageId;
            try {
              const { ancestors, isInitialReplyForumTopic } = await resolveReplyChain(
                db,
                districtId,
                telegramChatId,
                currentReplyToMessageId,
              );

              if (isInitialReplyForumTopic) {
                replyMetadata = null;
                parentReplyContext = null;
              } else if (ancestors.length > 0) {
                replyChainForAi = ancestors.map((a) => ({
                  messageId: a.messageId,
                  text: a.text ?? null,
                  status: a.status,
                  lanes: a.lanes ?? null,
                }));

                const immediateParent = ancestors[0]!;
                const relevantAncestor = ancestors.find((a) => a.status === 'RELEVANT');
                const anyAncestorRelevant = Boolean(relevantAncestor);
                const parentLanes = relevantAncestor?.lanes ?? immediateParent.lanes ?? null;

                if (immediateParent.status === 'EXCLUDED') {
                  const candidateHasCivicSignal =
                    (burstMessages && burstMessages.length > 0
                      ? burstMessages.some((m) => hasSelfContainedCivicSignal(m.verbatimText))
                      : false) || hasSelfContainedCivicSignal(verbatimText);

                  const candidateMatchesCivic =
                    (burstMessages && burstMessages.length > 0
                      ? burstMessages.some((m) => matchesCivicLaneKeyword(m.verbatimText))
                      : false) || matchesCivicLaneKeyword(verbatimText);

                  const candidateHasFollowUp =
                    (burstMessages && burstMessages.length > 0
                      ? burstMessages.some((m) => hasContextualFollowUpSignal(m.verbatimText))
                      : false) || hasContextualFollowUpSignal(verbatimText);

                  const activeOutageWithFollowUp = hasActiveOutageWindow && candidateHasFollowUp;

                  if (
                    candidateHasCivicSignal ||
                    candidateMatchesCivic ||
                    anyAncestorRelevant ||
                    activeOutageWithFollowUp
                  ) {
                    parentReplyContext = {
                      parentMessageId: immediateParent.messageId,
                      parentStatus: anyAncestorRelevant ? 'RELEVANT' : 'EXCLUDED',
                      parentExclusionReason: anyAncestorRelevant
                        ? null
                        : immediateParent.exclusionReason,
                      parentVerbatimText: anyAncestorRelevant
                        ? (relevantAncestor?.text ?? immediateParent.text)
                        : immediateParent.text,
                      parentLanes,
                    };
                  } else {
                    shouldFastFailExcludedParent = true;
                    parentExclusionReason = immediateParent.exclusionReason || 'GENERAL_CHATTER';
                  }
                } else if (immediateParent.status === 'RELEVANT') {
                  parentReplyContext = {
                    parentMessageId: immediateParent.messageId,
                    parentStatus: 'RELEVANT',
                    parentVerbatimText: immediateParent.text,
                    parentLanes: immediateParent.lanes ?? null,
                  };
                } else if (immediateParent.status === 'PENDING') {
                  parentReplyContext = {
                    parentMessageId: immediateParent.messageId,
                    parentStatus: 'PENDING',
                    parentVerbatimText: immediateParent.text,
                    parentLanes: null,
                  };
                } else {
                  parentReplyContext = {
                    parentMessageId: immediateParent.messageId,
                    parentStatus: 'NOT_FOUND',
                  };
                }
              } else {
                parentReplyContext = {
                  parentMessageId: currentReplyToMessageId,
                  parentStatus: 'NOT_FOUND',
                };
              }
            } catch (parentErr) {
              console.warn(
                JSON.stringify({
                  event: 'TELEGRAM_SEMANTIC_PARENT_REPLY_LOOKUP_FAILED',
                  districtId,
                  telegramChatId,
                  replyToMessageId: currentReplyToMessageId,
                  error: (parentErr as Error).message,
                }),
              );
            }
          }

          if (shouldFastFailExcludedParent) {
            const [activeProfile] = await db
              .select({ id: aiProfiles.id })
              .from(aiProfiles)
              .where(and(eq(aiProfiles.operationType, 'SEMANTIC_RELEVANCE'), eq(aiProfiles.isActive, true)))
              .orderBy(desc(aiProfiles.version))
              .limit(1);

            const fallbackProfileId = activeProfile?.id ?? 'prof_rel_default';
            const finalExclusionReason = parentExclusionReason || 'GENERAL_CHATTER';
            const fastFailReasoning = `Deterministic fast-fail: Reply to excluded parent (${finalExclusionReason}) without independent civic signal`;

            const allBurstIntakes =
              burstMessages && burstMessages.length > 0
                ? burstMessages
                : [{ intakeId, telegramMessageId }];

            const aiOperationId = `aiop_${crypto.randomUUID()}`;

            await withTransactionalIntake(pool, boss, async ({ tx }) => {
              for (const item of allBurstIntakes) {
                const opId = item.intakeId === intakeId ? aiOperationId : `aiop_${crypto.randomUUID()}`;
                await tx
                  .insert(aiOperations)
                  .values({
                    id: opId,
                    districtId,
                    mahallaName,
                    calendarDay,
                    operationType: 'SEMANTIC_RELEVANCE',
                    targetId: item.intakeId,
                    pinnedProfileId: fallbackProfileId,
                    contextRevision: 0,
                    snapshotFingerprint: 'fast_fail_parent_excluded',
                    finalStatus: 'COMPLETED_IRRELEVANT',
                    resultPayload: {
                      is_relevant: false,
                      relevant_lanes: [],
                      exclusion_reason: finalExclusionReason,
                      accepted_message_ids: [],
                      reasoning: fastFailReasoning,
                    },
                  })
                  .onConflictDoNothing();
              }

              const allIntakeIds = allBurstIntakes.map((m) => m.intakeId);
              const expiresAt = new Date(Date.now() + DEBUG_PAYLOAD_RETENTION_MS).toISOString();
              const exclusionMeta = JSON.stringify({
                status: 'EXCLUDED',
                exclusionReason: finalExclusionReason,
                verbatimText,
                reasoning: fastFailReasoning,
                expiresAt,
                purgedAt: null,
              });

              await tx
                .update(telegramIntakeRecords)
                .set({
                  status: 'EXCLUDED',
                  rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, allIntakeIds));

              verbatimText = '';
            });

            const durationMs = Math.round(performance.now() - startTime);
            console.log(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_EXCLUDED_REPLY_TO_NON_CIVIC_PARENT',
                districtId,
                mahallaName,
                calendarDay,
                telegramChatId,
                telegramMessageId,
                aiOperationId,
                parentMessageId: replyMetadata?.replyToMessageId,
                parentExclusionReason: finalExclusionReason,
                durationMs,
              }),
            );
            continue;
          }

          // Fetch injected evidence if provided (e.g. In tests), otherwise query DB
          let injectedEvidence: AcceptedEvidenceItem[] | undefined;
          if (options?.injectedEvidenceResolver) {
            injectedEvidence = await options.injectedEvidenceResolver(
              districtId,
              mahallaName,
              calendarDay,
            );
          }

          // Assemble same-day Mahalla context snapshot (AC 5, 14)
          const snapshot = await getMahallaDailySnapshot(
            db,
            districtId,
            mahallaName,
            calendarDay,
            injectedEvidence,
          );
          const initialRevision = snapshot.contextRevision;
          const initialFingerprint = snapshot.snapshotFingerprint;

          // Extract author's prior same-day accepted civic evidence in this Mahalla
          let authorPriorEvidence: AcceptedEvidenceItem[] | undefined;
          if (telegramUserId) {
            const priorItems = snapshot.evidence.filter(
              (item) =>
                item.telegramUserId === telegramUserId &&
                item.telegramMessageId !== telegramMessageId &&
                new Date(item.originalTimestamp).getTime() <= candidateTimeMs,
            );
            if (priorItems.length > 0) {
              authorPriorEvidence = priorItems;
            }
          }

          // ───────────────────────────────────────────────────────────────────
          // 3-Tier Deterministic Pre-Filtering Gate (Token Efficiency)
          // ───────────────────────────────────────────────────────────────────
          // Gate 1 (Direct Reply to Accepted Evidence / Topic / Prior Context)
          const isGate1Match = Boolean(
            replyMetadata?.replyToMessageId &&
              parentReplyContext?.parentStatus !== 'EXCLUDED',
          );

          // Gate 2 (Civic Keyword Match or Self-Contained Civic Signal)
          const isGate2Match =
            matchesCivicLaneKeyword(verbatimText) ||
            hasSelfContainedCivicSignal(verbatimText) ||
            Boolean(
              burstMessages &&
                burstMessages.length > 0 &&
                burstMessages.some(
                  (m) =>
                    matchesCivicLaneKeyword(m.verbatimText) ||
                    hasSelfContainedCivicSignal(m.verbatimText),
                ),
            );

          // Gate 3 (Active Outage Window & Zero-Intervention Same-Calendar-Day Follow-up Chain)
          let isGate3Match = false;

          if (!isGate1Match && !isGate2Match) {
            try {
              const candidateHasFollowUp =
                hasContextualFollowUpSignal(verbatimText) ||
                Boolean(burstMessages?.some((m) => hasContextualFollowUpSignal(m.verbatimText)));

              if (hasActiveOutageWindow && candidateHasFollowUp) {
                const [interveningSinceOutage] = await db
                  .select({ count: sql<number>`count(*)::int` })
                  .from(telegramIntakeRecords)
                  .where(
                    and(
                      eq(telegramIntakeRecords.districtId, districtId),
                      eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                      gt(
                        telegramIntakeRecords.originalTimestamp,
                        activeOutageRelevantOp!.originalTimestamp,
                      ),
                      lt(telegramIntakeRecords.originalTimestamp, candidateTimestamp),
                      ne(telegramIntakeRecords.id, intakeId),
                    ),
                  );

                const interveningCount = interveningSinceOutage?.count ?? 0;
                if (interveningCount <= 4) {
                  isGate3Match = true;
                }
              }

              if (!isGate3Match) {
                const recentChatRecords = await db
                  .select({
                    id: telegramIntakeRecords.id,
                    telegramMessageId: telegramIntakeRecords.telegramMessageId,
                    originalTimestamp: telegramIntakeRecords.originalTimestamp,
                    rawPayload: telegramIntakeRecords.rawPayload,
                    aiFinalStatus: aiOperations.finalStatus,
                    aiResultPayload: aiOperations.resultPayload,
                  })
                  .from(telegramIntakeRecords)
                  .leftJoin(
                    aiOperations,
                    and(
                      eq(aiOperations.targetId, telegramIntakeRecords.id),
                      eq(aiOperations.operationType, 'SEMANTIC_RELEVANCE'),
                    ),
                  )
                  .where(
                    and(
                      eq(telegramIntakeRecords.districtId, districtId),
                      eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                      eq(telegramIntakeRecords.calendarDay, calendarDay),
                      lt(telegramIntakeRecords.originalTimestamp, candidateTimestamp),
                      ne(telegramIntakeRecords.id, intakeId),
                    ),
                  )
                  .orderBy(desc(telegramIntakeRecords.originalTimestamp))
                  .limit(50);

                const isTrivial = (raw: unknown): boolean => {
                  if (!raw || typeof raw !== 'object') return true;
                  const p = raw as Record<string, unknown>;
                  const reason = typeof p.exclusionReason === 'string' ? p.exclusionReason : null;
                  if (
                    reason === 'SERVICE_MESSAGE' ||
                    reason === 'BOT_MESSAGE' ||
                    reason === 'EMPTY_CONTENT' ||
                    reason === 'CAPTIONLESS_MEDIA' ||
                    reason === 'BOT_COMMAND'
                  ) {
                    return true;
                  }
                  const text = extractVerbatimDisplayText(null, raw);
                  return !text || text.trim().length === 0;
                };

                const nonTrivial = recentChatRecords.filter((r) => !isTrivial(r.rawPayload));

                if (nonTrivial.length > 0) {
                  const isRelevantRecord = (r: (typeof nonTrivial)[0]): boolean => {
                    if (r.aiFinalStatus === 'COMPLETED_RELEVANT') return true;
                    const aiPayload = r.aiResultPayload as Record<string, unknown> | null;
                    if (aiPayload?.is_relevant === true) return true;
                    const raw = r.rawPayload as Record<string, unknown> | null;
                    if (raw?.status === 'ACCEPTED') return true;
                    return false;
                  };

                  const isExcludedRecord = (r: (typeof nonTrivial)[0]): boolean => {
                    if (r.aiFinalStatus === 'COMPLETED_IRRELEVANT') return true;
                    const aiPayload = r.aiResultPayload as Record<string, unknown> | null;
                    if (aiPayload?.is_relevant === false) return true;
                    const raw = r.rawPayload as Record<string, unknown> | null;
                    if (raw?.status === 'EXCLUDED') return true;
                    return false;
                  };

                  const immediatelyPreceding = nonTrivial[0]!;

                  if (isRelevantRecord(immediatelyPreceding) && !isExcludedRecord(immediatelyPreceding)) {
                    const immText = extractVerbatimDisplayText(null, immediatelyPreceding.rawPayload) || '';
                    const immHasKey = matchesCivicLaneKeyword(immText) || hasSelfContainedCivicSignal(immText);

                    if (immHasKey) {
                      isGate3Match = true;
                    } else {
                      const candidateGapMs =
                        candidateTimestamp.getTime() - immediatelyPreceding.originalTimestamp.getTime();

                      if (candidateGapMs <= 3 * 60 * 1000) {
                        let consecutiveUnkeyedCount = 1;
                        let chainValid = true;
                        let foundRootAnchor = false;
                        let previousTimestamp = immediatelyPreceding.originalTimestamp;

                        for (let i = 1; i < nonTrivial.length; i++) {
                          const rec = nonTrivial[i]!;

                          if (isExcludedRecord(rec) || !isRelevantRecord(rec)) {
                            chainValid = false;
                            break;
                          }

                          const stepGapMs =
                            previousTimestamp.getTime() - rec.originalTimestamp.getTime();
                          if (stepGapMs > 3 * 60 * 1000) {
                            chainValid = false;
                            break;
                          }
                          previousTimestamp = rec.originalTimestamp;

                          const recText = extractVerbatimDisplayText(null, rec.rawPayload) || '';
                          const hasKey =
                            matchesCivicLaneKeyword(recText) || hasSelfContainedCivicSignal(recText);

                          if (hasKey) {
                            foundRootAnchor = true;
                            break;
                          } else {
                            consecutiveUnkeyedCount++;
                            if (consecutiveUnkeyedCount >= 5) {
                              chainValid = false;
                              break;
                            }
                          }
                        }

                        if (chainValid && foundRootAnchor && consecutiveUnkeyedCount <= 5) {
                          isGate3Match = true;
                        }
                      }
                    }
                  }
                }
              }
            } catch (gate3Err) {
              console.warn(
                JSON.stringify({
                  event: 'TELEGRAM_SEMANTIC_GATE3_LOOKUP_FAILED',
                  districtId,
                  telegramChatId,
                  error: (gate3Err as Error).message,
                }),
              );
            }
          }

          // Author continuity: candidate without keywords continues prior same-day accepted report
          const isAuthorContinuityMatch = Boolean(
            authorPriorEvidence && authorPriorEvidence.length > 0,
          );

          if (!isGate1Match && !isGate2Match && !isGate3Match && !isAuthorContinuityMatch) {
            const [activeProfile] = await db
              .select({ id: aiProfiles.id })
              .from(aiProfiles)
              .where(
                and(
                  eq(aiProfiles.operationType, 'SEMANTIC_RELEVANCE'),
                  eq(aiProfiles.isActive, true),
                ),
              )
              .orderBy(desc(aiProfiles.version))
              .limit(1);

            const fallbackProfileId = activeProfile?.id ?? 'prof_rel_default';
            const finalExclusionReason: ExclusionReason = 'GENERAL_CHATTER';
            const fastFailReasoning =
              'Deterministic prefilter: No civic keywords, direct evidence reply, or active corroboration chain';

            const allBurstIntakes =
              burstMessages && burstMessages.length > 0
                ? burstMessages
                : [{ intakeId, telegramMessageId }];

            const aiOperationId = `aiop_${crypto.randomUUID()}`;

            await withTransactionalIntake(pool, boss, async ({ tx }) => {
              for (const item of allBurstIntakes) {
                const opId =
                  item.intakeId === intakeId ? aiOperationId : `aiop_${crypto.randomUUID()}`;
                await tx
                  .insert(aiOperations)
                  .values({
                    id: opId,
                    districtId,
                    mahallaName,
                    calendarDay,
                    operationType: 'SEMANTIC_RELEVANCE',
                    targetId: item.intakeId,
                    pinnedProfileId: fallbackProfileId,
                    contextRevision: initialRevision,
                    snapshotFingerprint: initialFingerprint,
                    finalStatus: 'COMPLETED_IRRELEVANT',
                    resultPayload: {
                      is_relevant: false,
                      relevant_lanes: [],
                      exclusion_reason: finalExclusionReason,
                      accepted_message_ids: [],
                      reasoning: fastFailReasoning,
                    },
                  })
                  .onConflictDoNothing();
              }

              const allIntakeIds = allBurstIntakes.map((m) => m.intakeId);
              const expiresAt = new Date(Date.now() + DEBUG_PAYLOAD_RETENTION_MS).toISOString();
              const exclusionMeta = JSON.stringify({
                status: 'EXCLUDED',
                exclusionReason: finalExclusionReason,
                verbatimText,
                reasoning: fastFailReasoning,
                expiresAt,
                purgedAt: null,
              });

              await tx
                .update(telegramIntakeRecords)
                .set({
                  status: 'EXCLUDED',
                  rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, allIntakeIds));

              verbatimText = '';
            });

            const durationMs = Math.round(performance.now() - startTime);
            console.log(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_EXCLUDED_COMMITTED',
                districtId,
                mahallaName,
                calendarDay,
                telegramChatId,
                telegramMessageId,
                aiOperationId,
                finalStatus: 'COMPLETED_IRRELEVANT',
                relevantLanes: [],
                exclusionReason: finalExclusionReason,
                inputTokens: 0,
                outputTokens: 0,
                durationMs,
                prefilterShortCircuit: true,
              }),
            );
            continue;
          }

          // Layer 2: Resolve Immediate Preceding Message & Chat Continuity in this chat
          let immediatePrecedingMessage: PrecedingMessageContext | null = null;
          let chatContinuity: ChatContinuityContext | null = null;
          const twoHoursAgo = new Date(candidateTimeMs - 2 * 60 * 60 * 1000);

          try {
            // 1. Look back up to 2 hours for the most recent COMPLETED_RELEVANT message in this chat
            const [recentRelevantOp] = await db
              .select({
                id: aiOperations.id,
                resultPayload: aiOperations.resultPayload,
                rawPayload: telegramIntakeRecords.rawPayload,
                telegramMessageId: telegramIntakeRecords.telegramMessageId,
                telegramUserId: telegramIntakeRecords.telegramUserId,
                originalTimestamp: telegramIntakeRecords.originalTimestamp,
              })
              .from(aiOperations)
              .innerJoin(telegramIntakeRecords, eq(aiOperations.targetId, telegramIntakeRecords.id))
              .where(
                and(
                  eq(telegramIntakeRecords.districtId, districtId),
                  eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                  eq(aiOperations.finalStatus, 'COMPLETED_RELEVANT'),
                  gt(telegramIntakeRecords.originalTimestamp, twoHoursAgo),
                  lt(telegramIntakeRecords.originalTimestamp, candidateTimestamp),
                ),
              )
              .orderBy(desc(telegramIntakeRecords.originalTimestamp))
              .limit(1);

            if (recentRelevantOp) {
              const prevText = extractVerbatimDisplayText(null, recentRelevantOp.rawPayload);
              const payload = recentRelevantOp.resultPayload as Record<string, unknown> | null;
              const lanes = payload?.relevant_lanes as string[] | undefined;
              const prevLane = lanes && lanes.length > 0 ? lanes[0] : null;

              if (prevText) {
                const precedingCtx: PrecedingMessageContext = {
                  telegramMessageId: recentRelevantOp.telegramMessageId,
                  telegramUserId: recentRelevantOp.telegramUserId,
                  originalTimestamp: recentRelevantOp.originalTimestamp.toISOString(),
                  verbatimText: prevText,
                  lane: prevLane,
                };

                // 2. Count intervening messages between earlier relevant message and candidate
                const [interveningResult] = await db
                  .select({ count: sql<number>`count(*)::int` })
                  .from(telegramIntakeRecords)
                  .where(
                    and(
                      eq(telegramIntakeRecords.districtId, districtId),
                      eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                      gt(telegramIntakeRecords.originalTimestamp, recentRelevantOp.originalTimestamp),
                      lt(telegramIntakeRecords.originalTimestamp, candidateTimestamp),
                    ),
                  );

                const interveningCount = interveningResult?.count ?? 0;

                const timeDiffMs = candidateTimeMs - recentRelevantOp.originalTimestamp.getTime();
                const isWithin15Min = timeDiffMs <= 15 * 60 * 1000;

                if (interveningCount === 0 && (isWithin15Min || isGate3Match)) {
                  immediatePrecedingMessage = precedingCtx;
                  chatContinuity = {
                    interveningCount: 0,
                    precedingRelevantMessage: precedingCtx,
                  };
                } else {
                  chatContinuity = {
                    interveningCount: Math.max(interveningCount, isWithin15Min || isGate3Match ? 0 : 1),
                    precedingRelevantMessage: precedingCtx,
                  };
                }
              }
            }
          } catch (queryErr) {
            console.warn(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_PRECEDING_MESSAGE_LOOKUP_FAILED',
                districtId,
                telegramChatId,
                error: (queryErr as Error).message,
              }),
            );
          }

          // Query district analysis configuration for local recognition vocabulary guidance
          let vocabularyGuidance: string[] | undefined;
          try {
            const activeSettings = await districtAnalysisSettingsService.getActiveConfiguration(
              db,
              districtId,
            );
            if (activeSettings) {
              const terms = [
                ...(activeSettings.hokimRecognitionTerms || []),
                ...(activeSettings.localVocabularyAdditions || []).map((item) => item.term),
              ].filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
              if (terms.length > 0) {
                vocabularyGuidance = Array.from(new Set(terms.map((t) => t.trim())));
              }
            }
          } catch (settingsErr) {
            console.warn(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_SETTINGS_LOOKUP_FAILED',
                districtId,
                error: (settingsErr as Error).message,
              }),
            );
          }

          // Build sliding-window chronological transcript of recent chat messages (up to 10)
          let recentChatTranscript: ChatTranscriptMessage[] | undefined;
          try {
            const recentChatRows = await db
              .select({
                id: telegramIntakeRecords.id,
                telegramMessageId: telegramIntakeRecords.telegramMessageId,
                telegramUserId: telegramIntakeRecords.telegramUserId,
                originalTimestamp: telegramIntakeRecords.originalTimestamp,
                rawPayload: telegramIntakeRecords.rawPayload,
                aiFinalStatus: aiOperations.finalStatus,
                aiResultPayload: aiOperations.resultPayload,
              })
              .from(telegramIntakeRecords)
              .leftJoin(
                aiOperations,
                and(
                  eq(aiOperations.targetId, telegramIntakeRecords.id),
                  eq(aiOperations.operationType, 'SEMANTIC_RELEVANCE'),
                ),
              )
              .where(
                and(
                  eq(telegramIntakeRecords.districtId, districtId),
                  eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                  eq(telegramIntakeRecords.calendarDay, calendarDay),
                  lt(telegramIntakeRecords.originalTimestamp, candidateTimestamp),
                  ne(telegramIntakeRecords.id, intakeId),
                ),
              )
              .orderBy(desc(telegramIntakeRecords.originalTimestamp))
              .limit(10);

            if (recentChatRows.length > 0) {
              recentChatTranscript = recentChatRows
                .reverse()
                .map((r) => {
                  const raw = asRecord(r.rawPayload);
                  const text = extractVerbatimDisplayText(null, raw) || '';
                  const msgObj = resolveTelegramMessageObject(raw) ?? (raw?.message_id ? raw : null);
                  let replyToId: string | undefined;
                  if (msgObj && typeof msgObj === 'object') {
                    const meta = extractReplyMetadata(msgObj as TelegramMessage);
                    replyToId = meta?.replyToMessageId ?? undefined;
                  }
                  const aiPayload = asRecord(r.aiResultPayload);
                  const lanes = Array.isArray(aiPayload?.relevant_lanes)
                    ? (aiPayload.relevant_lanes as string[])
                    : undefined;
                  return {
                    messageId: r.telegramMessageId,
                    senderId: r.telegramUserId ?? undefined,
                    text,
                    status: r.aiFinalStatus ?? (raw?.status === 'EXCLUDED' ? 'EXCLUDED' : undefined),
                    lanes,
                    timestamp: r.originalTimestamp,
                    replyToId,
                  };
                })
                .filter((m) => m.text.trim().length > 0);
            }
          } catch (transcriptErr) {
            console.warn(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_TRANSCRIPT_LOOKUP_FAILED',
                districtId,
                telegramChatId,
                error: (transcriptErr as Error).message,
              }),
            );
          }

          // Execute AI Gateway outside DB transaction (AD-5, AD-8 / AC 1, 9)
          const aiResult = await relevanceEvaluator.evaluateRelevance({
            candidateText: verbatimText,
            telegramMessageId,
            telegramUserId,
            authorHandle,
            originalTimestamp,
            contentType,
            replyMetadata,
            snapshot,
            burstMessages,
            authorPriorEvidence,
            immediatePrecedingMessage,
            chatContinuity,
            parentReplyContext,
            replyChain: replyChainForAi ?? undefined,
            recentChatTranscript,
            vocabularyGuidance,
          });

          // Gate 2: Pre-Commit District Lifecycle Verification (AC 13 / Matrix #21)
          const [districtGate2] = await db
            .select({
              id: districts.id,
              status: districts.status,
              accessEligible: districts.accessEligible,
            })
            .from(districts)
            .where(eq(districts.id, districtId))
            .limit(1);

          if (
            !districtGate2 ||
            (districtGate2.status !== 'ACTIVE' && districtGate2.status !== 'GRACE') ||
            districtGate2.accessEligible === false
          ) {
            const durationMs = Math.round(performance.now() - startTime);
            console.log(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_COMMIT_ABORTED_INACTIVE_DISTRICT',
                districtId,
                mahallaName,
                telegramChatId,
                telegramMessageId,
                districtStatus: districtGate2?.status ?? 'NOT_FOUND',
                accessEligible: districtGate2?.accessEligible ?? false,
                durationMs,
              }),
            );
            continue;
          }

          // CAS Check: Verify context has not advanced during AI evaluation (AD-6 / AC 10 / Matrix #19)
          const latestSnapshot = await getMahallaDailySnapshot(
            db,
            districtId,
            mahallaName,
            calendarDay,
            options?.injectedEvidenceResolver
              ? await options.injectedEvidenceResolver(districtId, mahallaName, calendarDay)
              : undefined,
          );

          if (
            latestSnapshot.contextRevision !== initialRevision ||
            latestSnapshot.snapshotFingerprint !== initialFingerprint
          ) {
            const durationMs = Math.round(performance.now() - startTime);
            console.warn(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_STALE_SNAPSHOT',
                districtId,
                mahallaName,
                calendarDay,
                telegramChatId,
                telegramMessageId,
                initialRevision,
                currentRevision: latestSnapshot.contextRevision,
                durationMs,
              }),
            );
            throw new Error(
              `STALE_SNAPSHOT: Mahalla context advanced from revision ${initialRevision} to ${latestSnapshot.contextRevision}. Retrying candidate analysis.`,
            );
          }

          const aiOperationId = `aiop_${crypto.randomUUID()}`;
          const isRelevant = aiResult.data.is_relevant;
          const isBurst = Boolean(burstMessages && burstMessages.length > 0);

          const acceptedIds = new Set(
            isBurst
              ? Array.isArray(aiResult.data.accepted_message_ids)
                ? aiResult.data.accepted_message_ids
                : []
              : Array.isArray(aiResult.data.accepted_message_ids) &&
                  aiResult.data.accepted_message_ids.length > 0
                ? aiResult.data.accepted_message_ids
                : isRelevant
                  ? [telegramMessageId]
                  : [],
          );

          // Atomic PostgreSQL commit + downstream enqueue via withTransactionalIntake
          await withTransactionalIntake(pool, boss, async ({ tx, enqueueJob }) => {
            // 1. Insert ai_operations record for all messages in the burst
            const allBurstIntakes =
              burstMessages && burstMessages.length > 0
                ? burstMessages
                : [{ intakeId, telegramMessageId }];

            for (const item of allBurstIntakes) {
              const opId =
                item.intakeId === intakeId ? aiOperationId : `aiop_${crypto.randomUUID()}`;
              const isItemAccepted =
                isRelevant &&
                (item.telegramMessageId ? acceptedIds.has(item.telegramMessageId) : true);
              const itemFinalStatus = isItemAccepted ? 'COMPLETED_RELEVANT' : 'COMPLETED_IRRELEVANT';

              await tx
                .insert(aiOperations)
                .values({
                  id: opId,
                  districtId,
                  mahallaName,
                  calendarDay,
                  operationType: 'SEMANTIC_RELEVANCE',
                  targetId: item.intakeId,
                  pinnedProfileId: aiResult.profileId,
                  contextRevision: initialRevision,
                  snapshotFingerprint: initialFingerprint,
                  finalStatus: itemFinalStatus,
                  resultPayload: aiResult.data,
                })
                .onConflictDoNothing();
            }

            // 2. Insert ai_provider_attempts records (persisting all attempts & retry lineage)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx from withTransactionalIntake is structurally DbOrTx; module-identity mismatch in TS
            await insertAiProviderAttempts(tx as any, aiOperationId, aiResult);

            const allIntakeIds = allBurstIntakes.map((m) => m.intakeId);
            const acceptedIntakeIds = allBurstIntakes
              .filter((m) => (m.telegramMessageId ? acceptedIds.has(m.telegramMessageId) : isRelevant))
              .map((m) => m.intakeId);

            if (acceptedIntakeIds.length > 0) {
              await tx
                .update(telegramIntakeRecords)
                .set({
                  status: 'ACCEPTED',
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, acceptedIntakeIds));
            }

            const unacceptedIntakeIds = allIntakeIds.filter((id) => !acceptedIntakeIds.includes(id));
            if (unacceptedIntakeIds.length > 0) {
              await tx
                .update(telegramIntakeRecords)
                .set({
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, unacceptedIntakeIds));
            }

            const filteredBurstMessages = burstMessages
              ? burstMessages.filter((m) => acceptedIds.has(m.telegramMessageId))
              : undefined;

            const excludedBurstItems = burstMessages
              ? burstMessages.filter((m) => !acceptedIds.has(m.telegramMessageId))
              : [];

            if (excludedBurstItems.length > 0) {
              const excludedIntakeIds = excludedBurstItems.map((m) => m.intakeId);
              const expiresAt = new Date(Date.now() + DEBUG_PAYLOAD_RETENTION_MS).toISOString();
              const exclusionMeta = JSON.stringify({
                status: 'EXCLUDED',
                exclusionReason: 'GENERAL_CHATTER',
                reasoning:
                  'Кетма-кет ёзилган хабарлардан ушбу қисмда соҳага оид муаммо ёки манзил аниқланмади',
                expiresAt,
                purgedAt: null,
              });
              await tx
                .update(telegramIntakeRecords)
                .set({
                  status: 'EXCLUDED',
                  rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, excludedIntakeIds));
            }

            const primaryAcceptedItem =
              filteredBurstMessages && filteredBurstMessages.length > 0
                ? filteredBurstMessages[0]!
                : null;

            const shouldEnqueueTopic =
              isRelevant && (!isBurst || (filteredBurstMessages && filteredBurstMessages.length > 0));

            if (shouldEnqueueTopic) {
              // 3. Enqueue Story 2.4 Topic Assignment job (AC 3, 9)
              const effectiveIntakeId = primaryAcceptedItem ? primaryAcceptedItem.intakeId : intakeId;
              const effectiveMessageId = primaryAcceptedItem
                ? primaryAcceptedItem.telegramMessageId
                : telegramMessageId;
              const effectiveUserMetadata =
                primaryAcceptedItem?.userMetadata ?? job.data.userMetadata ?? null;
              const effectiveVerbatimText = primaryAcceptedItem
                ? primaryAcceptedItem.verbatimText
                : verbatimText;

              const topicJobData: TelegramTopicAssignmentJobData = {
                intakeId: effectiveIntakeId,
                districtId,
                mahallaName,
                calendarDay,
                telegramChatId,
                telegramMessageId: effectiveMessageId,
                telegramUserId,
                originalTimestamp: primaryAcceptedItem
                  ? primaryAcceptedItem.originalTimestamp
                  : originalTimestamp,
                contentType: primaryAcceptedItem ? primaryAcceptedItem.contentType : contentType,
                verbatimText: effectiveVerbatimText,
                replyMetadata,
                userMetadata: effectiveUserMetadata,
                aiOperationId,
                relevantLanes: aiResult.data.relevant_lanes,
                reasoning: aiResult.data.reasoning,
                burstMessages:
                  filteredBurstMessages && filteredBurstMessages.length > 0
                    ? filteredBurstMessages
                    : undefined,
              };

              const singletonKey = JobSingletonKeys.forTopicAssignment(
                districtId,
                telegramChatId,
                effectiveMessageId,
              );
              await enqueueJob(TELEGRAM_TOPIC_ASSIGNMENT_QUEUE, topicJobData, {
                singletonKey,
                retryLimit: 3,
                retryDelay: 5,
                retryBackoff: true,
              });
            } else if (!isRelevant) {
              // 4. Retain bounded debug payload in DB for 48 hours (2 days) and purge memory (Decision 1 / Bounded Debug Retention)
              const allIntakeIds =
                burstMessages && burstMessages.length > 0
                  ? burstMessages.map((m) => m.intakeId)
                  : [intakeId];

              const expiresAt = new Date(Date.now() + DEBUG_PAYLOAD_RETENTION_MS).toISOString();
              const exclusionMeta = JSON.stringify({
                status: 'EXCLUDED',
                exclusionReason: aiResult.data.exclusion_reason,
                verbatimText,
                reasoning: aiResult.data.reasoning,
                expiresAt,
                purgedAt: null,
              });

              await tx
                .update(telegramIntakeRecords)
                .set({
                  status: 'EXCLUDED',
                  rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, allIntakeIds));

              verbatimText = ''; // Memory purge
            } else {
              verbatimText = ''; // Memory purge for burst with no accepted messages
            }
          });

          const finalStatus =
            isRelevant && (!isBurst || (acceptedIds.size > 0))
              ? 'COMPLETED_RELEVANT'
              : 'COMPLETED_IRRELEVANT';
          const durationMs = Math.round(performance.now() - startTime);

          // Privacy-safe telemetry log (AD-11 / AC 12)
          console.log(
            JSON.stringify({
              event: isRelevant
                ? 'TELEGRAM_SEMANTIC_RELEVANT_COMMITTED'
                : 'TELEGRAM_SEMANTIC_EXCLUDED_COMMITTED',
              districtId,
              mahallaName,
              calendarDay,
              telegramChatId,
              telegramMessageId,
              aiOperationId,
              finalStatus,
              relevantLanes: aiResult.data.relevant_lanes,
              exclusionReason: aiResult.data.exclusion_reason,
              inputTokens: aiResult.tokens.inputTokens,
              outputTokens: aiResult.tokens.outputTokens,
              durationMs,
            }),
          );
        } catch (err: unknown) {
          // Handle unique violation gracefully for duplicate replays (AC 8 / Matrix #25)
          if (findUniqueViolation(err, 'ai_ops_district_op_target_idx')) {
            console.log(
              JSON.stringify({
                event: 'TELEGRAM_SEMANTIC_RELEVANCE_IGNORED_DUPLICATE_VIOLATION',
                intakeId,
                districtId,
                telegramChatId,
                telegramMessageId,
              }),
            );
            continue;
          }

          console.error(
            JSON.stringify({
              event: 'TELEGRAM_SEMANTIC_RELEVANCE_ERROR',
              intakeId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err; // Trigger pg-boss retry policy
        } finally {
          if (job.data?.issueId) {
            await clearPendingRetryFlag(db, job.data.issueId);
          }
        }
      }
    }





export async function registerSemanticRelevanceJobHandler(
  boss: PgBoss,
  deps: SemanticRelevanceJobDeps,
): Promise<void> {
  await boss.work<TelegramSemanticRelevanceJobData>(
    TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
    { newJobCheckInterval: 50, batchSize: 1 } as any,
    (jobs) => processSemanticRelevanceJobs(jobs, deps),
  );
}
