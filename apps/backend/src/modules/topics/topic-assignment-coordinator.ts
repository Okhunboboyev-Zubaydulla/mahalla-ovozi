import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import {
  districts,
  telegramIntakeRecords,
  aiOperations,
  topics,
  acceptedEvidence,
} from '../../adapters/db/schema/index.js';
import {
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  withTransactionalIntake,
  JobSingletonKeys,
  extractTelegramUserMetadata,
  type TelegramTopicAssignmentJobData,
  type TelegramTopicProjectionJobData,
} from '../../adapters/jobs/boss-client.js';
import { insertAiProviderAttempts } from '../ai/ai-operation-repository.js';
import {
  TopicMatchingEvaluator,
  findDirectReplyTopic,
  type TopicMatchingResult,
} from './topic-matching-evaluator.js';
import {
  getMahallaDailySnapshot,
  groupSnapshotByTopic,
  verifySnapshotIntegrity,
  StaleSnapshotRevisionError,
  type AcceptedEvidenceItem,
} from '../ai/context-snapshot.js';
import { resolveTargetTopic } from './topic-matching-resolver.js';
import { calculateRetentionDeadline } from '../retention/index.js';
import { clearPendingRetryFlag } from '../issues/retry-service.js';
import { extractPostgresError, isPostgresError } from '../../adapters/db/client.js';

/**
 * The coordinator's one retry-signalling error mode: the Mahalla snapshot, or the
 * Topic generation, advanced underneath this assignment and it must be retried
 * against fresh context.
 *
 * Declared as a type rather than a message prefix so callers can narrow it with
 * `instanceof` — a prose contract is invisible to the compiler, and any unrelated
 * error that happens to share the prefix text would be misrouted into the retry
 * path. The `STALE_SNAPSHOT:` message prefix is preserved for operator-facing
 * pg-boss output; it is no longer the detection mechanism.
 */
export type StaleSnapshotReason = 'SNAPSHOT_REVISION' | 'GENERATION_ADVANCED';

export class StaleSnapshotError extends Error {
  readonly code = 'STALE_SNAPSHOT' as const;
  readonly status = 409;
  readonly reason: StaleSnapshotReason;

  constructor(reason: StaleSnapshotReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StaleSnapshotError';
    this.reason = reason;
  }
}

export interface TopicAssignmentDeps {
  db: DbClient;
  pool: pg.Pool;
  boss: PgBoss;
  topicMatchingEvaluator: TopicMatchingEvaluator;
  injectedEvidenceResolver?: (
    districtId: string,
    mahallaName: string,
    calendarDay: string,
  ) => Promise<AcceptedEvidenceItem[] | undefined>;
}

export type TopicAssignmentInput = TelegramTopicAssignmentJobData;

export type TopicAssignmentOutcome =
  | {
      status: 'SKIPPED_DUPLICATE';
      intakeId: string;
      districtId: string;
      mahallaName: string;
      telegramChatId: string;
      telegramMessageId: string;
      existingEvidenceId: string;
      topicId: string;
    }
  | {
      status: 'DROPPED_INACTIVE_DISTRICT';
      districtId: string;
      mahallaName: string;
      telegramChatId: string;
      telegramMessageId: string;
      districtStatus: string;
      accessEligible: boolean;
      gate: 'GATE_1' | 'GATE_2';
    }
  | {
      status: 'ASSIGNED';
      districtId: string;
      mahallaName: string;
      calendarDay: string;
      telegramChatId: string;
      telegramMessageId: string;
      topicId: string;
      isNewTopic: boolean;
      generation: number;
      evidenceCount: number;
      decision: string;
      primaryLane: string | null;
      isDirectReply: boolean;
      aiOperationId: string | null;
    }
  | {
      status: 'UNASSIGNABLE_VAGUE';
      districtId: string;
      mahallaName: string;
      calendarDay: string;
      telegramChatId: string;
      telegramMessageId: string;
      decision: 'UNASSIGNABLE_VAGUE';
      purgedIntakeIds: string[];
      isDirectReply: boolean;
      aiOperationId: string | null;
    }
  | {
      status: 'IGNORED_DUPLICATE_VIOLATION';
      intakeId: string;
      districtId: string;
      telegramChatId: string;
      telegramMessageId: string;
    };

/**
 * Deep domain coordinator that encapsulates the complete topic matching and assignment pipeline:
 * 1. Idempotency check against accepted_evidence.
 * 2. District lifecycle validation (Gate 1 & Gate 2).
 * 3. Fast-path direct reply check.
 * 4. Context snapshot assembly and AI matching evaluation.
 * 5. Cryptographic CAS snapshot optimistic concurrency verification.
 * 6. Atomic PostgreSQL persistence (topic creation/update, accepted evidence insertion, AI operation log).
 * 7. Transactional downstream dispatch to pg-boss projection queue.
 */
export async function assignEvidenceToTopic(
  deps: TopicAssignmentDeps,
  input: TopicAssignmentInput,
): Promise<TopicAssignmentOutcome> {
  const { db, pool, boss, topicMatchingEvaluator } = deps;
  const {
    intakeId,
    districtId,
    mahallaName,
    calendarDay,
    telegramChatId,
    telegramMessageId,
    telegramUserId,
    originalTimestamp,
    contentType,
    replyMetadata,
    userMetadata,
    aiOperationId,
    relevantLanes,
    reasoning,
    burstMessages,
  } = input;
  let { verbatimText } = input;

  try {
    // 1. Deduplication / Idempotency Check (AC 16 / Matrix #26)
    const [existingEvidence] = await db
      .select({
        id: acceptedEvidence.id,
        topicId: acceptedEvidence.topicId,
      })
      .from(acceptedEvidence)
      .where(
        and(
          eq(acceptedEvidence.districtId, districtId),
          eq(acceptedEvidence.telegramChatId, telegramChatId),
          eq(acceptedEvidence.telegramMessageId, telegramMessageId),
        ),
      )
      .limit(1);

    if (existingEvidence) {
      return {
        status: 'SKIPPED_DUPLICATE',
        intakeId,
        districtId,
        mahallaName,
        telegramChatId,
        telegramMessageId,
        existingEvidenceId: existingEvidence.id,
        topicId: existingEvidence.topicId,
      };
    }

    // 2. Gate 1: Pre-AI District Lifecycle Verification (AC 1, 13 / AD-9 / Matrix #22)
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
      return {
        status: 'DROPPED_INACTIVE_DISTRICT',
        districtId,
        mahallaName,
        telegramChatId,
        telegramMessageId,
        districtStatus: districtGate1?.status ?? 'NOT_FOUND',
        accessEligible: districtGate1?.accessEligible ?? false,
        gate: 'GATE_1',
      };
    }

    // 3. Fast Direct Reply Evaluation (AC 2, 3 / Pure DB resolution)
    let directReplyTopicId: string | null = null;
    if (replyMetadata?.replyToMessageId && !replyMetadata.replyToIsForwarded) {
      directReplyTopicId = await findDirectReplyTopic(
        db,
        districtId,
        mahallaName,
        calendarDay,
        telegramChatId,
        replyMetadata.replyToMessageId,
      );
    }

    // 4. Topic Matching Decision (Direct Reply vs AI Snapshot Evaluation)
    let matchingDecision: TopicMatchingResult;
    let isDirectReply = false;
    let initialRevision = 0;
    let initialFingerprint = 'sha256_empty_v1';
    let matchingAiResult: any = null;
    let orderedSnapshotTopicIds: string[] = [];

    if (directReplyTopicId) {
      isDirectReply = true;
      orderedSnapshotTopicIds = [directReplyTopicId];
      matchingDecision = {
        decision: 'MATCH_EXISTING_TOPIC',
        matched_topic_id: directReplyTopicId,
        primary_lane: null,
        reasoning: 'Direct Telegram reply to existing same-day accepted evidence',
      };
    } else {
      let injectedEvidence: AcceptedEvidenceItem[] | undefined;
      if (deps.injectedEvidenceResolver) {
        injectedEvidence = await deps.injectedEvidenceResolver(
          districtId,
          mahallaName,
          calendarDay,
        );
      }

      const snapshot = await getMahallaDailySnapshot(
        db,
        districtId,
        mahallaName,
        calendarDay,
        injectedEvidence,
      );
      initialRevision = snapshot.contextRevision;
      initialFingerprint = snapshot.snapshotFingerprint;
      orderedSnapshotTopicIds = Array.from(groupSnapshotByTopic(snapshot).keys());

      const effectiveUserId = telegramUserId ?? userMetadata?.telegramUserId;
      const authorHandle = userMetadata?.username
        ? `@${userMetadata.username}`
        : userMetadata?.firstName || undefined;

      // Execute AI Gateway outside DB transaction (AD-5, AD-8 / AC 14)
      matchingAiResult = await topicMatchingEvaluator.evaluateTopicAssignment({
        candidateText: verbatimText,
        telegramMessageId,
        telegramUserId: effectiveUserId,
        authorHandle,
        originalTimestamp,
        contentType,
        replyMetadata,
        relevantLanes,
        relevanceReasoning: reasoning,
        snapshot,
      });

      matchingDecision = matchingAiResult.data;
    }

    // 5. Gate 2: Pre-Commit District Lifecycle Verification (AC 1, 13 / AD-9 / Matrix #23)
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
      return {
        status: 'DROPPED_INACTIVE_DISTRICT',
        districtId,
        mahallaName,
        telegramChatId,
        telegramMessageId,
        districtStatus: districtGate2?.status ?? 'NOT_FOUND',
        accessEligible: districtGate2?.accessEligible ?? false,
        gate: 'GATE_2',
      };
    }

    // 7. Atomic PostgreSQL Commit Block (AC 6, 7, 8, 10, 16, 17)
    //
    // NOTE (L3-P05-10): the CAS verification deliberately lives INSIDE this transaction,
    // not before it. `withTransactionalIntake` does `pool.connect()` and BEGINs on a
    // dedicated connection, while `db` is the pool-backed client. A CAS check run on `db`
    // therefore reads through a different session than the one that commits, so it can only
    // catch a snapshot that had already advanced BEFORE the check — never the window it is
    // advertised to catch. Running the re-read on `tx` puts the guard and the commit on one
    // session, and the generation predicate on the UPDATE closes the remaining gap.
    const [intakeRec] = await db
      .select({ rawPayload: telegramIntakeRecords.rawPayload })
      .from(telegramIntakeRecords)
      .where(eq(telegramIntakeRecords.id, intakeId))
      .limit(1);

    const fallbackUserMetadata = extractTelegramUserMetadata(
      intakeRec?.rawPayload,
      telegramUserId,
    );
    const defaultUserMetadata = input.userMetadata || fallbackUserMetadata;

    const candidateDate = new Date(originalTimestamp);
    const topicMatchingOpId = isDirectReply ? null : `aiop_${crypto.randomUUID()}`;

    let linkedAiOpId: string | null = topicMatchingOpId;
    if (!linkedAiOpId && aiOperationId) {
      const [existingAiOp] = await db
        .select({ id: aiOperations.id })
        .from(aiOperations)
        .where(eq(aiOperations.id, aiOperationId))
        .limit(1);
      if (existingAiOp) {
        linkedAiOpId = existingAiOp.id;
      }
    }

    let finalTopicId: string | null = null;
    let isNewTopic = false;
    let finalGeneration = 1;
    let assignedEvidenceCount = 0;
    let purgedIntakeIds: string[] = [];

    await withTransactionalIntake(pool, boss, async ({ tx, enqueueJob }) => {
      // 6. CAS Optimistic Concurrency Check (AC 12 / AD-6 / Matrix #21) — ON THIS SESSION.
      // Re-reads the Mahalla snapshot through `tx` so the verification and the commit that
      // follows observe the same transaction. Throws to trigger the pg-boss retry path.
      if (!isDirectReply) {
        const latestSnapshot = await getMahallaDailySnapshot(
          tx as unknown as DbClient,
          districtId,
          mahallaName,
          calendarDay,
          deps.injectedEvidenceResolver
            ? await deps.injectedEvidenceResolver(districtId, mahallaName, calendarDay)
            : undefined,
        );

        verifySnapshotIntegrity(latestSnapshot);

        if (
          latestSnapshot.contextRevision !== initialRevision ||
          latestSnapshot.snapshotFingerprint !== initialFingerprint
        ) {
          throw new StaleSnapshotError(
            'SNAPSHOT_REVISION',
            `STALE_SNAPSHOT: Mahalla context advanced from revision ${initialRevision} to ${latestSnapshot.contextRevision}. Retrying candidate topic assignment.`,
            {
              cause: new StaleSnapshotRevisionError(
                latestSnapshot.contextRevision,
                initialRevision,
              ),
            },
          );
        }
      }

      // Log AI operation and provider attempts if AI matching occurred
      if (topicMatchingOpId && matchingAiResult) {
        await tx.insert(aiOperations).values({
          id: topicMatchingOpId,
          districtId,
          mahallaName,
          calendarDay,
          operationType: 'TOPIC_MATCHING',
          targetId: intakeId,
          pinnedProfileId: matchingAiResult.profileId,
          contextRevision: initialRevision,
          snapshotFingerprint: initialFingerprint,
          finalStatus:
            matchingDecision.decision === 'UNASSIGNABLE_VAGUE'
              ? 'COMPLETED_IRRELEVANT'
              : 'COMPLETED_RELEVANT',
          resultPayload: matchingDecision,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx from withTransactionalIntake is structurally DbOrTx
        await insertAiProviderAttempts(tx as any, topicMatchingOpId, matchingAiResult);
      }

      const evidenceItems =
        burstMessages && burstMessages.length > 0
          ? burstMessages.map((m) => ({
              intakeRecordId: m.intakeId,
              telegramMessageId: m.telegramMessageId,
              originalTimestamp: new Date(m.originalTimestamp),
              verbatimText: m.verbatimText,
              contentType: m.contentType,
              replyMetadata: m.replyMetadata || null,
              userMetadata: m.userMetadata || defaultUserMetadata,
            }))
          : [
              {
                intakeRecordId: intakeId,
                telegramMessageId,
                originalTimestamp: candidateDate,
                verbatimText,
                contentType,
                replyMetadata,
                userMetadata: defaultUserMetadata,
              },
            ];

      assignedEvidenceCount = evidenceItems.length;

      const latestCandidateTimestamp = evidenceItems.reduce(
        (max, item) =>
          item.originalTimestamp.getTime() > max.getTime()
            ? item.originalTimestamp
            : max,
        candidateDate,
      );

      let targetTopicId: string | null = null;
      let targetTopicRecord: {
        id: string;
        latestRelevantEvidenceTimestamp: Date;
        requiredDerivedGeneration: number;
      } | null = null;

      if (matchingDecision.decision === 'MATCH_EXISTING_TOPIC') {
        const candidateTopics = await tx
          .select({
            id: topics.id,
            primaryLane: topics.primaryLane,
            status: topics.status,
            latestRelevantEvidenceTimestamp: topics.latestRelevantEvidenceTimestamp,
            requiredDerivedGeneration: topics.requiredDerivedGeneration,
          })
          .from(topics)
          .where(
            and(
              eq(topics.districtId, districtId),
              eq(topics.mahallaName, mahallaName),
              eq(topics.calendarDay, calendarDay),
              eq(topics.status, 'ACTIVE'),
            ),
          );

        const fallbackLane =
          relevantLanes && relevantLanes.length > 0 && relevantLanes[0]
            ? relevantLanes[0]
            : 'HOKIM_RELATED';

        const resolution = resolveTargetTopic({
          matchedTopicId: matchingDecision.matched_topic_id,
          matchedTopicIndex: matchingDecision.matched_topic_index,
          orderedSnapshotTopicIds,
          candidateTopics,
          effectivePrimaryLane: fallbackLane,
        });

        if (resolution.status === 'MATCHED') {
          targetTopicId = resolution.matchedTopic.id;
          targetTopicRecord = resolution.matchedTopic;

          if (resolution.method !== 'EXACT') {
            console.warn(
              JSON.stringify({
                event: 'TELEGRAM_TOPIC_ASSIGNMENT_MATCH_RECOVERED',
                recoveryMethod: resolution.method,
                districtId,
                mahallaName,
                calendarDay,
                telegramMessageId,
                aiReturnedTopicId: matchingDecision.matched_topic_id,
                aiReturnedTopicIndex: matchingDecision.matched_topic_index,
                recoveredTopicId: targetTopicId,
              }),
            );
          }
        } else {
          console.warn(
            JSON.stringify({
              event: 'TELEGRAM_TOPIC_ASSIGNMENT_UNRESOLVED_FALLBACK_NEW_TOPIC',
              districtId,
              mahallaName,
              calendarDay,
              telegramMessageId,
              aiReturnedTopicId: matchingDecision.matched_topic_id,
              aiReturnedTopicIndex: matchingDecision.matched_topic_index,
              fallbackLane: resolution.fallbackLane,
            }),
          );
        }
      }

      if (targetTopicId && targetTopicRecord) {
        // Arithmetic for retention & generation using latestCandidateTimestamp
        const latestEvidenceTime = new Date(
          Math.max(
            targetTopicRecord.latestRelevantEvidenceTimestamp.getTime(),
            latestCandidateTimestamp.getTime(),
          ),
        );
        const retentionExpiresAt = calculateRetentionDeadline(latestEvidenceTime);
        const nextGeneration = targetTopicRecord.requiredDerivedGeneration + 1;

        finalTopicId = targetTopicId;
        isNewTopic = false;
        finalGeneration = nextGeneration;

        // Update Topic — guarded by the generation we read, so a concurrent assignment
        // that already advanced it cannot be silently overwritten (lost update).
        // Under READ COMMITTED the second writer blocks on the row lock, then re-evaluates
        // this predicate against the committed value; it no longer matches, so zero rows
        // are affected and we raise the same stale signal the CAS check raises.
        const updatedTopics = await tx
          .update(topics)
          .set({
            latestRelevantEvidenceTimestamp: latestEvidenceTime,
            retentionExpiresAt,
            requiredDerivedGeneration: nextGeneration,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(topics.id, targetTopicId),
              eq(topics.requiredDerivedGeneration, targetTopicRecord.requiredDerivedGeneration),
            ),
          )
          .returning({ id: topics.id });

        if (updatedTopics.length === 0) {
          throw new StaleSnapshotError(
            'GENERATION_ADVANCED',
            `STALE_SNAPSHOT: Topic ${targetTopicId} generation advanced concurrently from ${targetTopicRecord.requiredDerivedGeneration}. Retrying candidate topic assignment.`,
          );
        }

        // Insert Accepted Evidence for each message in the burst
        for (const item of evidenceItems) {
          const evidenceId = `evi_${crypto.randomUUID()}`;
          await tx.insert(acceptedEvidence).values({
            id: evidenceId,
            topicId: targetTopicId,
            districtId,
            mahallaName,
            calendarDay,
            intakeRecordId: item.intakeRecordId,
            telegramChatId,
            telegramMessageId: item.telegramMessageId,
            telegramUserId,
            originalTimestamp: item.originalTimestamp,
            verbatimText: item.verbatimText,
            contentType: item.contentType,
            userMetadata: item.userMetadata,
            replyMetadata: item.replyMetadata,
            aiOperationId: linkedAiOpId,
          });
        }

        // Enqueue downstream projection job (AC 17)
        const projectionJobData: TelegramTopicProjectionJobData = {
          topicId: targetTopicId,
          districtId,
          mahallaName,
          calendarDay,
          generation: nextGeneration,
        };
        const singletonKey = JobSingletonKeys.forTopicProjection(targetTopicId, nextGeneration);
        await enqueueJob(TELEGRAM_TOPIC_PROJECTION_QUEUE, projectionJobData, {
          singletonKey,
          retryLimit: 5,
          retryDelay: 15,
          retryBackoff: true,
        });
      } else if (
        matchingDecision.decision === 'NEW_TOPIC' ||
        matchingDecision.decision === 'MATCH_EXISTING_TOPIC'
      ) {
        let effectivePrimaryLane =
          matchingDecision.decision === 'NEW_TOPIC' && matchingDecision.primary_lane
            ? matchingDecision.primary_lane
            : (relevantLanes && relevantLanes.length > 0 && relevantLanes[0]
                ? relevantLanes[0]
                : 'HOKIM_RELATED');

        // Programmatic Defense-in-Depth: primaryLane must align with upstream relevantLanes
        if (
          relevantLanes &&
          relevantLanes.length > 0 &&
          relevantLanes[0] &&
          !relevantLanes.includes(effectivePrimaryLane)
        ) {
          console.warn(
            JSON.stringify({
              event: 'TELEGRAM_TOPIC_ASSIGNMENT_PRIMARY_LANE_CLAMPED',
              districtId,
              mahallaName,
              telegramMessageId,
              aiReturnedLane: effectivePrimaryLane,
              clampedTo: relevantLanes[0],
              relevantLanes,
            }),
          );
          effectivePrimaryLane = relevantLanes[0];
        }

        const newTopicId = `top_${crypto.randomUUID()}`;
        const retentionExpiresAt = calculateRetentionDeadline(latestCandidateTimestamp);

        finalTopicId = newTopicId;
        isNewTopic = true;
        finalGeneration = 1;

        // Insert new Topic record
        await tx.insert(topics).values({
          id: newTopicId,
          districtId,
          mahallaName,
          calendarDay,
          primaryLane: effectivePrimaryLane,
          status: 'ACTIVE',
          latestRelevantEvidenceTimestamp: latestCandidateTimestamp,
          retentionExpiresAt,
          requiredDerivedGeneration: 1,
          appliedDerivedGeneration: 0,
        });

        // Insert Accepted Evidence for each message in the burst
        for (const item of evidenceItems) {
          const evidenceId = `evi_${crypto.randomUUID()}`;
          await tx.insert(acceptedEvidence).values({
            id: evidenceId,
            topicId: newTopicId,
            districtId,
            mahallaName,
            calendarDay,
            intakeRecordId: item.intakeRecordId,
            telegramChatId,
            telegramMessageId: item.telegramMessageId,
            telegramUserId,
            originalTimestamp: item.originalTimestamp,
            verbatimText: item.verbatimText,
            contentType: item.contentType,
            userMetadata: item.userMetadata,
            replyMetadata: item.replyMetadata,
            aiOperationId: linkedAiOpId,
          });
        }

        // Enqueue downstream projection job (AC 17)
        const projectionJobData: TelegramTopicProjectionJobData = {
          topicId: newTopicId,
          districtId,
          mahallaName,
          calendarDay,
          generation: 1,
        };
        const singletonKey = JobSingletonKeys.forTopicProjection(newTopicId, 1);
        await enqueueJob(TELEGRAM_TOPIC_PROJECTION_QUEUE, projectionJobData, {
          singletonKey,
          retryLimit: 5,
          retryDelay: 15,
          retryBackoff: true,
        });
      } else if (matchingDecision.decision === 'UNASSIGNABLE_VAGUE') {
        // Sanitize raw payload in DB and purge verbatimText from memory (AC 7 / AD-11)
        const allIntakeIds = evidenceItems.map((i) => i.intakeRecordId);
        purgedIntakeIds = allIntakeIds;
        await tx
          .update(telegramIntakeRecords)
          .set({
            rawPayload: {
              status: 'EXCLUDED',
              reason: 'UNASSIGNABLE_VAGUE',
              purgedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(inArray(telegramIntakeRecords.id, allIntakeIds));

        verbatimText = ''; // Memory purge
      }
    });

    if (matchingDecision.decision === 'UNASSIGNABLE_VAGUE') {
      return {
        status: 'UNASSIGNABLE_VAGUE',
        districtId,
        mahallaName,
        calendarDay,
        telegramChatId,
        telegramMessageId,
        decision: 'UNASSIGNABLE_VAGUE',
        purgedIntakeIds,
        isDirectReply,
        aiOperationId: linkedAiOpId,
      };
    }

    return {
      status: 'ASSIGNED',
      districtId,
      mahallaName,
      calendarDay,
      telegramChatId,
      telegramMessageId,
      topicId: finalTopicId!,
      isNewTopic,
      generation: finalGeneration,
      evidenceCount: assignedEvidenceCount,
      decision: matchingDecision.decision,
      primaryLane: matchingDecision.primary_lane,
      isDirectReply,
      aiOperationId: linkedAiOpId,
    };
  } catch (err: unknown) {
    // Handle unique violation gracefully for duplicate replays (AC 16 / Matrix #26).
    // Detection goes through the shared adapter helper rather than raw `any` field
    // reads: extractPostgresError unwraps Drizzle's Error.cause nesting, which a
    // bare `err.code` read misses, and the match keys on the constraint NAME only.
    // The previous `String(err?.detail).includes('already exists')` arm keyed on a
    // localized, driver-generated message fragment — if the driver wording changed
    // the arm silently stopped matching and a duplicate burned a retry.
    const pgErr = extractPostgresError(err);
    if (
      isPostgresError(err, '23505') &&
      (pgErr?.constraint ?? '').includes('accepted_evidence_district_chat_msg_idx')
    ) {
      return {
        status: 'IGNORED_DUPLICATE_VIOLATION',
        intakeId,
        districtId,
        telegramChatId,
        telegramMessageId,
      };
    }

    throw err;
  } finally {
    if (input.issueId) {
      await clearPendingRetryFlag(db, input.issueId);
    }
  }
}
