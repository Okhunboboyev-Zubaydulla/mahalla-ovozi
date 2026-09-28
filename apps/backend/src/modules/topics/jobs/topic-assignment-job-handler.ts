import type PgBoss from 'pg-boss';
import {
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  type TelegramTopicAssignmentJobData,
} from '../../../adapters/jobs/boss-client.js';
import {
  assignEvidenceToTopic,
  StaleSnapshotError,
  type TopicAssignmentDeps,
  type TopicAssignmentOutcome,
} from '../topic-assignment-coordinator.js';

export type TopicAssignmentJobDeps = TopicAssignmentDeps;

/**
 * Thin queue adapter for pg-boss topic assignment worker.
 * Unpacks job batches, delegates domain logic to assignEvidenceToTopic,
 * and emits privacy-safe telemetry events.
 */
export async function processTopicAssignmentJobs(
  jobs: PgBoss.Job<TelegramTopicAssignmentJobData>[],
  deps: TopicAssignmentJobDeps,
): Promise<void> {
  for (const job of jobs) {
    const { intakeId, districtId, mahallaName, calendarDay, telegramChatId, telegramMessageId } =
      job.data;
    const startTime = performance.now();

    try {
      const outcome: TopicAssignmentOutcome = await assignEvidenceToTopic(deps, job.data);
      const durationMs = Math.round(performance.now() - startTime);

      switch (outcome.status) {
        case 'SKIPPED_DUPLICATE':
          console.log(
            JSON.stringify({
              event: 'TELEGRAM_TOPIC_ASSIGNMENT_SKIPPED_DUPLICATE',
              intakeId,
              districtId,
              mahallaName,
              telegramChatId,
              telegramMessageId,
              existingEvidenceId: outcome.existingEvidenceId,
              topicId: outcome.topicId,
              durationMs,
            }),
          );
          break;

        case 'DROPPED_INACTIVE_DISTRICT':
          console.log(
            JSON.stringify({
              event:
                outcome.gate === 'GATE_1'
                  ? 'TELEGRAM_TOPIC_ASSIGNMENT_DROPPED_INACTIVE_DISTRICT'
                  : 'TELEGRAM_TOPIC_ASSIGNMENT_COMMIT_ABORTED_INACTIVE_DISTRICT',
              districtId,
              mahallaName,
              telegramChatId,
              telegramMessageId,
              districtStatus: outcome.districtStatus,
              accessEligible: outcome.accessEligible,
              durationMs,
            }),
          );
          break;

        case 'IGNORED_DUPLICATE_VIOLATION':
          console.log(
            JSON.stringify({
              event: 'TELEGRAM_TOPIC_ASSIGNMENT_IGNORED_DUPLICATE_VIOLATION',
              intakeId,
              districtId,
              telegramChatId,
              telegramMessageId,
            }),
          );
          break;

        case 'UNASSIGNABLE_VAGUE':
          console.log(
            JSON.stringify({
              event: 'TELEGRAM_TOPIC_ASSIGNMENT_VAGUE_DISCARDED',
              districtId,
              mahallaName,
              calendarDay,
              telegramChatId,
              telegramMessageId,
              decision: outcome.decision,
              matchedTopicId: null,
              primaryLane: null,
              isDirectReply: outcome.isDirectReply,
              durationMs,
            }),
          );
          break;

        case 'ASSIGNED':
          console.log(
            JSON.stringify({
              event: 'TELEGRAM_TOPIC_ASSIGNMENT_COMMITTED',
              districtId,
              mahallaName,
              calendarDay,
              telegramChatId,
              telegramMessageId,
              decision: outcome.decision,
              matchedTopicId: outcome.topicId,
              primaryLane: outcome.primaryLane,
              isDirectReply: outcome.isDirectReply,
              durationMs,
            }),
          );
          break;
      }
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startTime);

      // Narrow on the declared type, not on a message prefix. The coordinator's
      // stale mode is the one failure that is expected and retryable; everything
      // else is a hard error. A string prefix cannot make that distinction — an
      // unrelated error carrying the same text was misrouted here as benign.
      if (err instanceof StaleSnapshotError) {
        console.warn(
          JSON.stringify({
            event: 'TELEGRAM_TOPIC_ASSIGNMENT_STALE_SNAPSHOT',
            staleReason: err.reason,
            districtId,
            mahallaName,
            calendarDay,
            telegramChatId,
            telegramMessageId,
            durationMs,
          }),
        );
      } else {
        console.error(
          JSON.stringify({
            event: 'TELEGRAM_TOPIC_ASSIGNMENT_ERROR',
            intakeId,
            districtId,
            telegramChatId,
            telegramMessageId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      throw err; // Trigger pg-boss retry policy
    }
  }
}

export async function registerTopicAssignmentJobHandler(
  boss: PgBoss,
  deps: TopicAssignmentJobDeps,
): Promise<void> {
  await boss.work<TelegramTopicAssignmentJobData>(
    TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
    { newJobCheckInterval: 50, batchSize: 1 } as any,
    (jobs) => processTopicAssignmentJobs(jobs, deps),
  );
}
