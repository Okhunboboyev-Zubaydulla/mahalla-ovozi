import { IssueCategory } from '@mahalla-ovozi/api-contracts';
import {
  JobSingletonKeys,
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  TELEGRAM_TOPIC_RETENTION_QUEUE,
  DISTRICT_LIVE_DELETION_QUEUE,
  DISTRICT_BACKUP_EXPIRY_QUEUE,
} from '../../adapters/jobs/boss-client.js';

export const RETRY_ELIGIBLE_CATEGORIES: ReadonlySet<IssueCategory> = new Set([
  'MESSAGE_INTAKE_DELAY',
  'TOPIC_PROCESSING_DELAY',
  'AI_SERVICE_DEGRADED',
  'RETENTION_JOB_DELAY',
  'DISTRICT_RETENTION_DELAY',
  'LIFECYCLE_DELETION',
  'BACKUP_EXPIRY_DELAY',
]);

export interface RetryJobSpec {
  queueName: string;
  payload: Record<string, unknown>;
  singletonKey: string;
  operationType: string;
  targetId: string;
}

export interface RetryEligibilityResult {
  eligible: boolean;
  rejectionReason?: string;
  rejectionCode?: string;
}

/**
 * Pure predicate evaluating if an operational issue is eligible for manual retry (Story 4.3 AC 1, AC 2).
 */
export function isIssueRetryEligible(
  issueCategory: IssueCategory,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (!RETRY_ELIGIBLE_CATEGORIES.has(issueCategory)) {
    return false;
  }

  // Explicit permanent failures (e.g. invalid bot token or corrupt non-retryable payloads) cannot be retried
  if (metadata?.permanentFailure === true) {
    return false;
  }

  return true;
}

/**
 * Classifies whether a target operation can be retried based on current status and pending flags (Story 4.3 AC 1, AC 2).
 */
export function classifyRetryEligibility(
  status: string,
  metadata?: Record<string, unknown> | null,
): RetryEligibilityResult {
  if (status !== 'ACTIVE') {
    return {
      eligible: false,
      rejectionReason: 'Бартараф этилган муаммони қайта ижро этиб бўлмайди.',
      rejectionCode: 'OPERATION_ALREADY_COMPLETED',
    };
  }

  if (metadata?.pendingRetry === true) {
    return {
      eligible: false,
      rejectionReason: 'Ушбу муаммо учун қайта ижро этиш жараёни аллақачон навбатда.',
      rejectionCode: 'DUPLICATE_RETRY_IN_PROGRESS',
    };
  }

  if (metadata?.permanentFailure === true) {
    return {
      eligible: false,
      rejectionReason: 'Ушбу муаммо қайта уриниш орқали ҳал қилинмайди.',
      rejectionCode: 'OPERATION_INELIGIBLE',
    };
  }

  return { eligible: true };
}

export interface IssueSpecInput {
  id: string;
  scope: string;
  districtId: string | null;
  component: string;
  issueCategory: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Pure resolver that derives the pg-boss queue, job payload, singleton key, and tracking metadata (Story 4.3 AC 2).
 */
export function deriveRetryJobSpec(issue: IssueSpecInput): RetryJobSpec | null {
  if (!isIssueRetryEligible(issue.issueCategory as IssueCategory, issue.metadata)) {
    return null;
  }

  const cat = issue.issueCategory as IssueCategory;

  if (cat === 'RETENTION_JOB_DELAY') {
    return {
      queueName: TELEGRAM_TOPIC_RETENTION_QUEUE,
      payload: { issueId: issue.id },
      singletonKey: JobSingletonKeys.forRetention(),
      operationType: 'TELEGRAM_TOPIC_RETENTION',
      targetId: 'global',
    };
  }

  if (cat === 'DISTRICT_RETENTION_DELAY') {
    const targetDistrictId = issue.districtId || 'global';
    return {
      queueName: TELEGRAM_TOPIC_RETENTION_QUEUE,
      payload: {
        districtId: issue.districtId || undefined,
        issueId: issue.id,
      },
      singletonKey: JobSingletonKeys.forRetention(issue.districtId || undefined),
      operationType: 'TELEGRAM_TOPIC_RETENTION',
      targetId: targetDistrictId,
    };
  }

  if (cat === 'MESSAGE_INTAKE_DELAY') {
    const intakeId = issue.metadata?.intakeId
      ? String(issue.metadata.intakeId)
      : null;
    const districtId =
      issue.districtId ||
      (issue.metadata?.districtId ? String(issue.metadata.districtId) : '');
    const chatId = issue.metadata?.telegramChatId
      ? String(issue.metadata.telegramChatId)
      : '';
    const messageId = issue.metadata?.telegramMessageId
      ? String(issue.metadata.telegramMessageId)
      : '';

    if (intakeId && chatId && messageId) {
      return {
        queueName: TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
        payload: {
          intakeId,
          districtId,
          mahallaName: String(issue.metadata?.mahallaName || ''),
          calendarDay: String(issue.metadata?.calendarDay || ''),
          telegramChatId: chatId,
          telegramMessageId: messageId,
          originalTimestamp: String(
            issue.metadata?.originalTimestamp || new Date().toISOString(),
          ),
          issueId: issue.id,
        },
        singletonKey: JobSingletonKeys.forContentQualification(
          districtId,
          chatId,
          messageId,
        ),
        operationType: 'TELEGRAM_CONTENT_QUALIFICATION',
        targetId: intakeId,
      };
    }
    return null;
  }

  if (cat === 'TOPIC_PROCESSING_DELAY') {
    const topicId = issue.metadata?.topicId
      ? String(issue.metadata.topicId)
      : null;
    const rawGen = Number(issue.metadata?.generation);
    const generation = Number.isInteger(rawGen) && rawGen > 0 ? rawGen : 1;

    if (topicId) {
      return {
        queueName: TELEGRAM_TOPIC_PROJECTION_QUEUE,
        payload: {
          topicId,
          districtId:
            issue.districtId || String(issue.metadata?.districtId || ''),
          mahallaName: String(issue.metadata?.mahallaName || ''),
          calendarDay: String(issue.metadata?.calendarDay || ''),
          generation,
          issueId: issue.id,
        },
        singletonKey: JobSingletonKeys.forTopicProjection(topicId, generation),
        operationType: 'TELEGRAM_TOPIC_PROJECTION',
        targetId: topicId,
      };
    }
    return null;
  }

  if (cat === 'AI_SERVICE_DEGRADED') {
    const opType = issue.metadata?.operationType;
    const districtId =
      issue.districtId || String(issue.metadata?.districtId || '');
    const chatId = String(issue.metadata?.telegramChatId || '');
    const messageId = String(issue.metadata?.telegramMessageId || '');
    const intakeId = String(issue.metadata?.intakeId || issue.id);

    if (opType === 'TELEGRAM_SEMANTIC_RELEVANCE' && chatId && messageId) {
      return {
        queueName: TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
        payload: { ...issue.metadata, issueId: issue.id },
        singletonKey: JobSingletonKeys.forSemanticRelevance(
          districtId,
          chatId,
          messageId,
        ),
        operationType: 'TELEGRAM_SEMANTIC_RELEVANCE',
        targetId: intakeId,
      };
    }

    if (opType === 'TELEGRAM_TOPIC_ASSIGNMENT' && chatId && messageId) {
      return {
        queueName: TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
        payload: { ...issue.metadata, issueId: issue.id },
        singletonKey: JobSingletonKeys.forTopicAssignment(
          districtId,
          chatId,
          messageId,
        ),
        operationType: 'TELEGRAM_TOPIC_ASSIGNMENT',
        targetId: intakeId,
      };
    }
    return null;
  }

  if (cat === 'LIFECYCLE_DELETION') {
    const targetDistrictId =
      issue.districtId ||
      (issue.metadata?.deletedDistrictId
        ? String(issue.metadata.deletedDistrictId)
        : '') ||
      (issue.metadata?.districtId ? String(issue.metadata.districtId) : '');

    if (!targetDistrictId || targetDistrictId === 'global') {
      return null;
    }

    return {
      queueName: DISTRICT_LIVE_DELETION_QUEUE,
      payload: {
        districtId: targetDistrictId,
        issueId: issue.id,
      },
      singletonKey: JobSingletonKeys.forLiveDeletion(targetDistrictId),
      operationType: 'DISTRICT_LIVE_DELETION',
      targetId: targetDistrictId,
    };
  }

  if (cat === 'BACKUP_EXPIRY_DELAY') {
    const targetDistrictId =
      issue.districtId ||
      (issue.metadata?.deletedDistrictId
        ? String(issue.metadata.deletedDistrictId)
        : '') ||
      (issue.metadata?.districtId ? String(issue.metadata.districtId) : '');

    if (!targetDistrictId || targetDistrictId === 'global') {
      return null;
    }

    return {
      queueName: DISTRICT_BACKUP_EXPIRY_QUEUE,
      payload: {
        districtId: targetDistrictId,
        issueId: issue.id,
      },
      singletonKey: JobSingletonKeys.forBackupExpiry(targetDistrictId),
      operationType: 'DISTRICT_BACKUP_EXPIRY',
      targetId: targetDistrictId,
    };
  }

  return null;
}
