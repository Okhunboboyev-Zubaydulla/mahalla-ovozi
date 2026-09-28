import { describe, it, expect } from 'vitest';
import { IssueCategory } from '@mahalla-ovozi/api-contracts';
import {
  isIssueRetryEligible,
  classifyRetryEligibility,
  deriveRetryJobSpec,
  RETRY_ELIGIBLE_CATEGORIES,
} from '../src/modules/issues/retry-evaluator.js';
import {
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  TELEGRAM_TOPIC_RETENTION_QUEUE,
} from '../src/adapters/jobs/boss-client.js';

describe('Story 4.3: Pure Retry Evaluator Unit Tests (AC 1, AC 2, AC 8)', () => {
  const allCategories: IssueCategory[] = [
    'DATABASE_CONNECTION_ERROR',
    'QUEUE_UNAVAILABLE',
    'QUEUE_BACKLOG_DELAY',
    'STORAGE_UNAVAILABLE',
    'WEB_APP_UNAVAILABLE',
    'BOT_TOKEN_INVALID',
    'BOT_DISCONNECTED',
    'TELEGRAM_GROUP_DISCONNECTED',
    'MESSAGE_INTAKE_DELAY',
    'TOPIC_PROCESSING_DELAY',
    'AI_SERVICE_DEGRADED',
    'RETENTION_JOB_DELAY',
    'DISTRICT_RETENTION_DELAY',
    'SUBSCRIPTION_PAUSED_NOTICE',
    'OPERATIONAL_MAINTENANCE_NOTICE',
  ];

  describe('isIssueRetryEligible', () => {
    it('covers all 15 system issue categories with correct classification', () => {
      expect(allCategories.length).toBe(15);
      const eligible = allCategories.filter((c) => isIssueRetryEligible(c));
      const nonEligible = allCategories.filter((c) => !isIssueRetryEligible(c));
      expect(eligible.length).toBe(5);
      expect(nonEligible.length).toBe(10);
    });

    it('returns true for all 5 retry-eligible issue categories', () => {
      const eligibleList: IssueCategory[] = [
        'MESSAGE_INTAKE_DELAY',
        'TOPIC_PROCESSING_DELAY',
        'AI_SERVICE_DEGRADED',
        'RETENTION_JOB_DELAY',
        'DISTRICT_RETENTION_DELAY',
      ];

      for (const cat of eligibleList) {
        expect(isIssueRetryEligible(cat)).toBe(true);
        expect(RETRY_ELIGIBLE_CATEGORIES.has(cat)).toBe(true);
      }
    });

    it('returns false for non-retryable operational issue categories', () => {
      const nonRetryable: IssueCategory[] = [
        'DATABASE_CONNECTION_ERROR',
        'QUEUE_UNAVAILABLE',
        'QUEUE_BACKLOG_DELAY',
        'STORAGE_UNAVAILABLE',
        'WEB_APP_UNAVAILABLE',
        'BOT_TOKEN_INVALID',
        'BOT_DISCONNECTED',
        'TELEGRAM_GROUP_DISCONNECTED',
        'SUBSCRIPTION_PAUSED_NOTICE',
        'OPERATIONAL_MAINTENANCE_NOTICE',
      ];

      for (const cat of nonRetryable) {
        expect(isIssueRetryEligible(cat)).toBe(false);
      }
    });

    it('returns false if permanentFailure flag is set to true in metadata', () => {
      expect(
        isIssueRetryEligible('MESSAGE_INTAKE_DELAY', { permanentFailure: true }),
      ).toBe(false);
      expect(
        isIssueRetryEligible('RETENTION_JOB_DELAY', { permanentFailure: true }),
      ).toBe(false);
    });

    it('returns true when metadata has normal error data without permanentFailure flag', () => {
      expect(
        isIssueRetryEligible('MESSAGE_INTAKE_DELAY', { errorCode: 'TIMEOUT', retryCount: 1 }),
      ).toBe(true);
    });
  });

  describe('classifyRetryEligibility', () => {
    it('rejects resolved operations with OPERATION_ALREADY_COMPLETED', () => {
      const result = classifyRetryEligibility('RESOLVED');
      expect(result.eligible).toBe(false);
      expect(result.rejectionCode).toBe('OPERATION_ALREADY_COMPLETED');
      expect(result.rejectionReason).toContain('Бартараф этилган');
    });

    it('rejects active operations with pendingRetry=true with DUPLICATE_RETRY_IN_PROGRESS', () => {
      const result = classifyRetryEligibility('ACTIVE', { pendingRetry: true });
      expect(result.eligible).toBe(false);
      expect(result.rejectionCode).toBe('DUPLICATE_RETRY_IN_PROGRESS');
      expect(result.rejectionReason).toContain('аллақачон навбатда');
    });

    it('rejects active operations with permanentFailure=true with OPERATION_INELIGIBLE', () => {
      const result = classifyRetryEligibility('ACTIVE', { permanentFailure: true });
      expect(result.eligible).toBe(false);
      expect(result.rejectionCode).toBe('OPERATION_INELIGIBLE');
      expect(result.rejectionReason).toContain('қайта уриниш орқали ҳал қилинмайди');
    });

    it('allows active operations with no pending flags', () => {
      const result = classifyRetryEligibility('ACTIVE', { retryCount: 2 });
      expect(result.eligible).toBe(true);
      expect(result.rejectionCode).toBeUndefined();
    });
  });

  describe('deriveRetryJobSpec', () => {
    it('derives correct job spec for global RETENTION_JOB_DELAY', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-ret-global',
        scope: 'GLOBAL',
        districtId: null,
        component: 'retention_job',
        issueCategory: 'RETENTION_JOB_DELAY',
      });

      expect(spec).not.toBeNull();
      expect(spec?.queueName).toBe(TELEGRAM_TOPIC_RETENTION_QUEUE);
      expect(spec?.singletonKey).toBe('retention:global');
      expect(spec?.operationType).toBe('TELEGRAM_TOPIC_RETENTION');
      expect(spec?.targetId).toBe('global');
      expect(spec?.payload).toEqual({ issueId: 'issue-ret-global' });
    });

    it('derives correct job spec for district DISTRICT_RETENTION_DELAY', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-ret-dist',
        scope: 'DISTRICT',
        districtId: 'dist-chilonzor-1',
        component: 'retention_job',
        issueCategory: 'DISTRICT_RETENTION_DELAY',
      });

      expect(spec).not.toBeNull();
      expect(spec?.queueName).toBe(TELEGRAM_TOPIC_RETENTION_QUEUE);
      expect(spec?.singletonKey).toBe('retention:dist-chilonzor-1');
      expect(spec?.operationType).toBe('TELEGRAM_TOPIC_RETENTION');
      expect(spec?.targetId).toBe('dist-chilonzor-1');
      expect(spec?.payload).toEqual({
        districtId: 'dist-chilonzor-1',
        issueId: 'issue-ret-dist',
      });
    });

    it('derives correct job spec for MESSAGE_INTAKE_DELAY with message coordinates', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-intake-1',
        scope: 'DISTRICT',
        districtId: 'dist-chilonzor-1',
        component: 'telegram_intake',
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        metadata: {
          intakeId: 'intake-rec-123',
          mahallaName: 'Бўстон',
          calendarDay: '2026-08-26',
          telegramChatId: '-10012345678',
          telegramMessageId: '9876',
          originalTimestamp: '2026-08-26T05:00:00.000Z',
        },
      });

      expect(spec).not.toBeNull();
      expect(spec?.queueName).toBe(TELEGRAM_CONTENT_QUALIFICATION_QUEUE);
      expect(spec?.singletonKey).toBe('msg:dist-chilonzor-1:-10012345678:9876');
      expect(spec?.operationType).toBe('TELEGRAM_CONTENT_QUALIFICATION');
      expect(spec?.targetId).toBe('intake-rec-123');
      expect(spec?.payload).toEqual({
        intakeId: 'intake-rec-123',
        districtId: 'dist-chilonzor-1',
        mahallaName: 'Бўстон',
        calendarDay: '2026-08-26',
        telegramChatId: '-10012345678',
        telegramMessageId: '9876',
        originalTimestamp: '2026-08-26T05:00:00.000Z',
        issueId: 'issue-intake-1',
      });
    });

    it('derives correct job spec for TOPIC_PROCESSING_DELAY with topic coordinates', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-proj-1',
        scope: 'DISTRICT',
        districtId: 'dist-chilonzor-1',
        component: 'topic_projection',
        issueCategory: 'TOPIC_PROCESSING_DELAY',
        metadata: {
          topicId: 'topic-infra-456',
          mahallaName: 'Бўстон',
          calendarDay: '2026-08-26',
          generation: 3,
        },
      });

      expect(spec).not.toBeNull();
      expect(spec?.queueName).toBe(TELEGRAM_TOPIC_PROJECTION_QUEUE);
      expect(spec?.singletonKey).toBe('proj:topic-infra-456:3');
      expect(spec?.operationType).toBe('TELEGRAM_TOPIC_PROJECTION');
      expect(spec?.targetId).toBe('topic-infra-456');
      expect(spec?.payload).toEqual({
        topicId: 'topic-infra-456',
        districtId: 'dist-chilonzor-1',
        mahallaName: 'Бўстон',
        calendarDay: '2026-08-26',
        generation: 3,
        issueId: 'issue-proj-1',
      });
    });

    it('safely defaults corrupt non-numeric generation to 1 in topic projection spec', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-proj-corrupt',
        scope: 'DISTRICT',
        districtId: 'dist-chilonzor-1',
        component: 'topic_projection',
        issueCategory: 'TOPIC_PROCESSING_DELAY',
        metadata: {
          topicId: 'topic-infra-789',
          generation: 'invalid_generation_string',
        },
      });

      expect(spec).not.toBeNull();
      expect(spec?.singletonKey).toBe('proj:topic-infra-789:1');
      expect((spec?.payload as any).generation).toBe(1);
    });

    it('derives correct job spec for AI_SERVICE_DEGRADED semantic relevance job', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-ai-rel',
        scope: 'DISTRICT',
        districtId: 'dist-chilonzor-1',
        component: 'ai_relevance',
        issueCategory: 'AI_SERVICE_DEGRADED',
        metadata: {
          operationType: 'TELEGRAM_SEMANTIC_RELEVANCE',
          intakeId: 'intake-rec-999',
          telegramChatId: '-100999',
          telegramMessageId: '111',
        },
      });

      expect(spec).not.toBeNull();
      expect(spec?.queueName).toBe(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE);
      expect(spec?.singletonKey).toBe('rel:dist-chilonzor-1:-100999:111');
      expect(spec?.operationType).toBe('TELEGRAM_SEMANTIC_RELEVANCE');
      expect(spec?.targetId).toBe('intake-rec-999');
    });

    it('derives correct job spec for AI_SERVICE_DEGRADED topic assignment job', () => {
      const spec = deriveRetryJobSpec({
        id: 'issue-ai-topic',
        scope: 'DISTRICT',
        districtId: 'dist-chilonzor-1',
        component: 'ai_topic',
        issueCategory: 'AI_SERVICE_DEGRADED',
        metadata: {
          operationType: 'TELEGRAM_TOPIC_ASSIGNMENT',
          intakeId: 'intake-rec-888',
          telegramChatId: '-100888',
          telegramMessageId: '222',
        },
      });

      expect(spec).not.toBeNull();
      expect(spec?.queueName).toBe(TELEGRAM_TOPIC_ASSIGNMENT_QUEUE);
      expect(spec?.singletonKey).toBe('topic:dist-chilonzor-1:-100888:222');
      expect(spec?.operationType).toBe('TELEGRAM_TOPIC_ASSIGNMENT');
      expect(spec?.targetId).toBe('intake-rec-888');
    });

    it('returns null for non-retryable issues (e.g. DATABASE_CONNECTION_ERROR, BOT_TOKEN_INVALID)', () => {
      expect(
        deriveRetryJobSpec({
          id: 'issue-db-fail',
          scope: 'GLOBAL',
          districtId: null,
          component: 'database',
          issueCategory: 'DATABASE_CONNECTION_ERROR',
        }),
      ).toBeNull();

      expect(
        deriveRetryJobSpec({
          id: 'issue-bot-invalid',
          scope: 'DISTRICT',
          districtId: 'dist-1',
          component: 'telegram_bot',
          issueCategory: 'BOT_TOKEN_INVALID',
        }),
      ).toBeNull();
    });
  });
});
