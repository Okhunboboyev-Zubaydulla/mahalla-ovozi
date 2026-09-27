import { describe, it, expect } from 'vitest';
import {
  JobSingletonKeys,
  TELEGRAM_CONTENT_QUALIFICATION_QUEUE,
  TELEGRAM_SEMANTIC_RELEVANCE_QUEUE,
  TELEGRAM_TOPIC_ASSIGNMENT_QUEUE,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  TELEGRAM_TOPIC_RETENTION_QUEUE,
} from '../src/adapters/jobs/boss-client.js';

describe('JobSingletonKeys and Queue Architecture (AD-3)', () => {
  it('generates consistent content qualification singleton keys', () => {
    const key = JobSingletonKeys.forContentQualification('dst_1', '-100123', '456');
    expect(key).toBe('msg:dst_1:-100123:456');
  });

  it('generates consistent semantic relevance singleton keys', () => {
    const key = JobSingletonKeys.forSemanticRelevance('dst_1', '-100123', '456');
    expect(key).toBe('rel:dst_1:-100123:456');
  });

  it('generates consistent topic assignment singleton keys', () => {
    const key = JobSingletonKeys.forTopicAssignment('dst_1', '-100123', '456');
    expect(key).toBe('topic:dst_1:-100123:456');
  });

  it('generates consistent topic projection coalescing keys (AD-7)', () => {
    const key = JobSingletonKeys.forTopicProjection('top_999', 3);
    expect(key).toBe('proj:top_999:3');
  });

  it('normalizes mahalla names in district mahalla day scope serialization keys (AD-3)', () => {
    const key1 = JobSingletonKeys.forDistrictMahallaDay('dst_1', 'Navbahor', '2026-08-25');
    const key2 = JobSingletonKeys.forDistrictMahallaDay('dst_1', '  NAVBAHOR  ', '2026-08-25');
    expect(key1).toBe('scope:dst_1:navbahor:2026-08-25');
    expect(key2).toBe('scope:dst_1:navbahor:2026-08-25');
    expect(key1).toBe(key2);
  });

  it('defines all 5 required civic processing queues', () => {
    expect(TELEGRAM_CONTENT_QUALIFICATION_QUEUE).toBe('telegram-content-qualification');
    expect(TELEGRAM_SEMANTIC_RELEVANCE_QUEUE).toBe('telegram-semantic-relevance');
    expect(TELEGRAM_TOPIC_ASSIGNMENT_QUEUE).toBe('telegram-topic-assignment');
    expect(TELEGRAM_TOPIC_PROJECTION_QUEUE).toBe('telegram-topic-projection');
    expect(TELEGRAM_TOPIC_RETENTION_QUEUE).toBe('telegram-topic-retention');
  });

  it('defines resilient retry and backoff defaults for all queues', async () => {
    const { DEFAULT_QUEUE_CONFIGS } = await import('../src/adapters/jobs/boss-client.js');
    expect(DEFAULT_QUEUE_CONFIGS[TELEGRAM_CONTENT_QUALIFICATION_QUEUE]).toEqual({
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInMinutes: 10,
      retentionDays: 1,
    });
    expect(DEFAULT_QUEUE_CONFIGS[TELEGRAM_SEMANTIC_RELEVANCE_QUEUE]).toEqual({
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInMinutes: 10,
      retentionDays: 1,
    });
    expect(DEFAULT_QUEUE_CONFIGS[TELEGRAM_TOPIC_RETENTION_QUEUE]).toEqual({
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: false,
      expireInMinutes: 30,
      retentionDays: 3,
    });
  });

  it('sendQueueJob merges default queue configuration with custom overrides', async () => {
    const { sendQueueJob } = await import('../src/adapters/jobs/boss-client.js');
    let capturedQueue = '';
    let capturedData: unknown = null;
    let capturedOptions: unknown = null;

    const mockBoss = {
      send: async (queue: string, data: unknown, options: unknown) => {
        capturedQueue = queue;
        capturedData = data;
        capturedOptions = options;
        return 'job_123';
      },
    } as any;

    const jobId = await sendQueueJob(mockBoss, TELEGRAM_CONTENT_QUALIFICATION_QUEUE, { test: 1 }, {
      singletonKey: 'msg:1',
      retryLimit: 5, // custom override
    });

    expect(jobId).toBe('job_123');
    expect(capturedQueue).toBe(TELEGRAM_CONTENT_QUALIFICATION_QUEUE);
    expect(capturedData).toEqual({ test: 1 });
    expect(capturedOptions).toEqual({
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInMinutes: 10,
      retentionDays: 1,
      singletonKey: 'msg:1',
    });
  });
});
