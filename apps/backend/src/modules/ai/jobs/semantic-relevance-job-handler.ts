import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, inArray, sql, gt, lt, desc } from 'drizzle-orm';
import type { DbClient } from '../../../adapters/db/client.js';
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
} from '../semantic-relevance-evaluator.js';
import { hasSelfContainedCivicSignal } from '../../telegram-intake/telegram-content-qualification.js';
import { extractVerbatimDisplayText } from '../../telegram-intake/telegram-payload-text.js';
import { clearPendingRetryFlag } from '../../issues/retry-service.js';

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

          // Layer 1: Deterministic Parent-Reply Fast-Fail Gate
          let parentReplyContext: ParentReplyContext | null = null;
          let shouldFastFailExcludedParent = false;
          let parentExclusionReason: ExclusionReason | null = null;

          if (replyMetadata?.replyToMessageId) {
            try {
              const [parentIntake] = await db
                .select({
                  id: telegramIntakeRecords.id,
                  rawPayload: telegramIntakeRecords.rawPayload,
                  telegramMessageId: telegramIntakeRecords.telegramMessageId,
                })
                .from(telegramIntakeRecords)
                .where(
                  and(
                    eq(telegramIntakeRecords.districtId, districtId),
                    eq(telegramIntakeRecords.telegramChatId, telegramChatId),
                    eq(telegramIntakeRecords.telegramMessageId, replyMetadata.replyToMessageId),
                  ),
                )
                .limit(1);

              if (parentIntake) {
                const raw = parentIntake.rawPayload as Record<string, unknown> | null;
                const parentVerbatimText = extractVerbatimDisplayText(null, raw);

                const isExcludedAtQualification = raw?.status === 'EXCLUDED';
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
                      eq(aiOperations.targetId, parentIntake.id),
                    ),
                  )
                  .limit(1);

                const isExcludedAtAi = parentOp?.finalStatus === 'COMPLETED_IRRELEVANT';
                const isRelevantAtAi = parentOp?.finalStatus === 'COMPLETED_RELEVANT';
                const aiPayload = parentOp?.resultPayload as Record<string, unknown> | null;
                const aiExclusionReason =
                  typeof aiPayload?.exclusion_reason === 'string' ? aiPayload.exclusion_reason : null;

                const isParentExcluded = isExcludedAtQualification || isExcludedAtAi;
                const effectiveParentExclusionReason =
                  (aiExclusionReason || qualificationReason || 'GENERAL_CHATTER') as ExclusionReason;

                if (isParentExcluded) {
                  const candidateHasCivicSignal =
                    (burstMessages && burstMessages.length > 0
                      ? burstMessages.some((m) => hasSelfContainedCivicSignal(m.verbatimText))
                      : false) || hasSelfContainedCivicSignal(verbatimText);

                  if (!candidateHasCivicSignal) {
                    shouldFastFailExcludedParent = true;
                    parentExclusionReason = effectiveParentExclusionReason;
                  } else {
                    parentReplyContext = {
                      parentMessageId: replyMetadata.replyToMessageId,
                      parentStatus: 'EXCLUDED',
                      parentExclusionReason: effectiveParentExclusionReason,
                      parentVerbatimText,
                    };
                  }
                } else if (isRelevantAtAi) {
                  parentReplyContext = {
                    parentMessageId: replyMetadata.replyToMessageId,
                    parentStatus: 'RELEVANT',
                    parentVerbatimText,
                  };
                } else {
                  parentReplyContext = {
                    parentMessageId: replyMetadata.replyToMessageId,
                    parentStatus: 'PENDING',
                    parentVerbatimText,
                  };
                }
              } else {
                parentReplyContext = {
                  parentMessageId: replyMetadata.replyToMessageId,
                  parentStatus: 'NOT_FOUND',
                };
              }
            } catch (parentErr) {
              console.warn(
                JSON.stringify({
                  event: 'TELEGRAM_SEMANTIC_PARENT_REPLY_LOOKUP_FAILED',
                  districtId,
                  telegramChatId,
                  replyToMessageId: replyMetadata.replyToMessageId,
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
              const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
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
                  rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
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
            const candidateTimeMs = new Date(originalTimestamp).getTime();
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

          // Layer 2: Resolve Immediate Preceding Message & Chat Continuity in this chat
          let immediatePrecedingMessage: PrecedingMessageContext | null = null;
          let chatContinuity: ChatContinuityContext | null = null;
          const candidateTimestamp = new Date(originalTimestamp);
          const candidateTimeMs = candidateTimestamp.getTime();
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

                if (interveningCount === 0 && isWithin15Min) {
                  immediatePrecedingMessage = precedingCtx;
                  chatContinuity = {
                    interveningCount: 0,
                    precedingRelevantMessage: precedingCtx,
                  };
                } else {
                  chatContinuity = {
                    interveningCount: Math.max(interveningCount, isWithin15Min ? 0 : 1),
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
          const finalStatus = isRelevant ? 'COMPLETED_RELEVANT' : 'COMPLETED_IRRELEVANT';

          const acceptedIds = new Set(
            Array.isArray(aiResult.data.accepted_message_ids) &&
            aiResult.data.accepted_message_ids.length > 0
              ? aiResult.data.accepted_message_ids
              : burstMessages && burstMessages.length > 0
                ? burstMessages.map((m) => m.telegramMessageId)
                : [telegramMessageId],
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

            if (isRelevant) {
              // 3. Enqueue Story 2.4 Topic Assignment job (AC 3, 9)
              const filteredBurstMessages = burstMessages
                ? burstMessages.filter((m) => acceptedIds.has(m.telegramMessageId))
                : undefined;

              const excludedBurstItems = burstMessages
                ? burstMessages.filter((m) => !acceptedIds.has(m.telegramMessageId))
                : [];

              if (excludedBurstItems.length > 0) {
                const excludedIntakeIds = excludedBurstItems.map((m) => m.intakeId);
                const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
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
                    rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                    updatedAt: new Date(),
                  })
                  .where(inArray(telegramIntakeRecords.id, excludedIntakeIds));
              }

              const primaryAcceptedItem =
                filteredBurstMessages && filteredBurstMessages.length > 0
                  ? filteredBurstMessages[0]!
                  : null;

              const effectiveIntakeId = primaryAcceptedItem ? primaryAcceptedItem.intakeId : intakeId;
              const effectiveMessageId = primaryAcceptedItem
                ? primaryAcceptedItem.telegramMessageId
                : telegramMessageId;
              const effectiveUserMetadata =
                primaryAcceptedItem?.userMetadata ?? job.data.userMetadata ?? null;

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
                verbatimText,
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
            } else {
              // 4. Retain bounded debug payload in DB for 14 days and purge memory (Decision 1 / Bounded Debug Retention)
              const allIntakeIds =
                burstMessages && burstMessages.length > 0
                  ? burstMessages.map((m) => m.intakeId)
                  : [intakeId];

              const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
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
                  rawPayload: sql`COALESCE(${telegramIntakeRecords.rawPayload}, '{}'::jsonb) || ${exclusionMeta}::jsonb`,
                  updatedAt: new Date(),
                })
                .where(inArray(telegramIntakeRecords.id, allIntakeIds));

              verbatimText = ''; // Memory purge
            }
          });

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
        } catch (err: any) {
          // Handle unique violation gracefully for duplicate replays (AC 8 / Matrix #25)
          if (err?.code === '23505' && String(err?.constraint).includes('ai_ops_district_op_target_idx')) {
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
