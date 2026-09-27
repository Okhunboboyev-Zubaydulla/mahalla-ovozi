import { describe, it, expect } from 'vitest';
import {
  TopicMatchingResultSchema,
  TopicMatchingEvaluator,
} from '../../src/modules/topics/topic-matching-evaluator.js';
import {
  TopicProjectionEvaluator,
  TopicProjectionResultSchema,
  type TopicProjectionResult,
} from '../../src/modules/topics/topic-projection-evaluator.js';
import {
  resolveTargetTopic,
  computeLevenshteinDistance,
  type CandidateTopicItem,
} from '../../src/modules/topics/topic-matching-resolver.js';
import type { MahallaDailySnapshot } from '../../src/modules/ai/context-snapshot.js';

describe('Resilient Topic Matching & Entity Resolution Tests', () => {
  describe('computeLevenshteinDistance', () => {
    it('returns 0 for identical strings', () => {
      expect(computeLevenshteinDistance('test', 'test')).toBe(0);
      expect(computeLevenshteinDistance('', '')).toBe(0);
    });

    it('detects single dropped character (the exact production bug)', () => {
      // Production bug: model dropped '9' from top_a91364f2...
      const original = 'a91364f2-4200-4f37-b93a-347420f2255b';
      const droppedChar = 'a1364f2-4200-4f37-b93a-347420f2255b';
      expect(computeLevenshteinDistance(droppedChar, original)).toBe(1);
    });

    it('computes correct edit distance for substitutions, deletions, and insertions', () => {
      expect(computeLevenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(computeLevenshteinDistance('top_123', 'top_124')).toBe(1);
    });
  });

  describe('TopicMatchingResultSchema with 1-based indexing', () => {
    it('accepts MATCH_EXISTING_TOPIC with matched_topic_index only', () => {
      const parsed = TopicMatchingResultSchema.safeParse({
        decision: 'MATCH_EXISTING_TOPIC',
        matched_topic_index: 1,
        matched_topic_id: null,
        primary_lane: null,
        reasoning: 'Matches active electricity topic via index',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts MATCH_EXISTING_TOPIC with string index coerced to number', () => {
      const parsed = TopicMatchingResultSchema.safeParse({
        decision: 'MATCH_EXISTING_TOPIC',
        matched_topic_index: '2',
        matched_topic_id: null,
        primary_lane: null,
        reasoning: 'Matches active gas topic via coerced string index',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.matched_topic_index).toBe(2);
      }
    });

    it('accepts MATCH_EXISTING_TOPIC with both matched_topic_id and matched_topic_index', () => {
      const parsed = TopicMatchingResultSchema.safeParse({
        decision: 'MATCH_EXISTING_TOPIC',
        matched_topic_id: 'top_a91364f2-4200-4f37-b93a-347420f2255b',
        matched_topic_index: 1,
        primary_lane: null,
        reasoning: 'Matches both',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts NEW_TOPIC when model outputs matched_topic_index: 0 (coerced to null)', () => {
      const parsed = TopicMatchingResultSchema.safeParse({
        decision: 'NEW_TOPIC',
        matched_topic_id: null,
        matched_topic_index: 0,
        primary_lane: 'WASTE',
        reasoning: 'First waste complaint in mahalla',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.matched_topic_index).toBeNull();
        expect(parsed.data.primary_lane).toBe('WASTE');
      }
    });

    it('accepts NEW_TOPIC when model outputs matched_topic_id as "null" or "none" (coerced to null)', () => {
      const parsed = TopicMatchingResultSchema.safeParse({
        decision: 'NEW_TOPIC',
        matched_topic_id: 'none',
        matched_topic_index: '0',
        primary_lane: 'WATER',
        reasoning: 'New water topic',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.matched_topic_id).toBeNull();
        expect(parsed.data.matched_topic_index).toBeNull();
      }
    });

    it('rejects MATCH_EXISTING_TOPIC if neither matched_topic_id nor matched_topic_index is provided', () => {
      const parsed = TopicMatchingResultSchema.safeParse({
        decision: 'MATCH_EXISTING_TOPIC',
        matched_topic_id: null,
        matched_topic_index: null,
        primary_lane: null,
        reasoning: 'No id or index provided',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('resolveTargetTopic Entity Resolver', () => {
    const candidateGas: CandidateTopicItem = {
      id: 'top_a91364f2-4200-4f37-b93a-347420f2255b',
      primaryLane: 'GAS',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date('2026-09-07T13:41:30.229Z'),
      requiredDerivedGeneration: 1,
    };

    const candidateElectricity: CandidateTopicItem = {
      id: 'top_5d27dae4-2445-4380-8574-177345f82eed',
      primaryLane: 'ELECTRICITY',
      status: 'ACTIVE',
      latestRelevantEvidenceTimestamp: new Date('2026-09-07T06:03:54.156Z'),
      requiredDerivedGeneration: 2,
    };

    const candidateTopics = [candidateGas, candidateElectricity];
    const orderedSnapshotTopicIds = [candidateGas.id, candidateElectricity.id];

    it('resolves accurately via Tier 1 (1-Based Index)', () => {
      const res = resolveTargetTopic({
        matchedTopicIndex: 1,
        orderedSnapshotTopicIds,
        candidateTopics,
        effectivePrimaryLane: 'GAS',
      });

      expect(res.status).toBe('MATCHED');
      if (res.status === 'MATCHED') {
        expect(res.method).toBe('INDEX');
        expect(res.matchedTopic.id).toBe(candidateGas.id);
      }
    });

    it('resolves accurately via Tier 2 (Exact Topic ID)', () => {
      const res = resolveTargetTopic({
        matchedTopicId: 'top_a91364f2-4200-4f37-b93a-347420f2255b',
        orderedSnapshotTopicIds,
        candidateTopics,
        effectivePrimaryLane: 'GAS',
      });

      expect(res.status).toBe('MATCHED');
      if (res.status === 'MATCHED') {
        expect(res.method).toBe('EXACT');
        expect(res.matchedTopic.id).toBe(candidateGas.id);
      }
    });

    it('recovers production failure via Tier 3 (Fuzzy Match on truncated UUID)', () => {
      // The exact error from production: model returned top_a1364f2... instead of top_a91364f2...
      const res = resolveTargetTopic({
        matchedTopicId: 'top_a1364f2-4200-4f37-b93a-347420f2255b',
        orderedSnapshotTopicIds,
        candidateTopics,
        effectivePrimaryLane: 'GAS',
      });

      expect(res.status).toBe('MATCHED');
      if (res.status === 'MATCHED') {
        expect(res.method).toBe('FUZZY');
        expect(res.matchedTopic.id).toBe('top_a91364f2-4200-4f37-b93a-347420f2255b');
      }
    });

    it('resolves via Tier 4 (Domain Lane Consolidation) when ID is completely garbled', () => {
      const res = resolveTargetTopic({
        matchedTopicId: 'top_completely_unknown_uuid_9999999999',
        orderedSnapshotTopicIds,
        candidateTopics,
        effectivePrimaryLane: 'GAS',
      });

      expect(res.status).toBe('MATCHED');
      if (res.status === 'MATCHED') {
        expect(res.method).toBe('LANE_CONSOLIDATION');
        expect(res.matchedTopic.id).toBe(candidateGas.id);
      }
    });

    it('safely returns UNRESOLVED (Tier 5 Fallback) when multiple lane candidates exist and ID is unknown', () => {
      const duplicateGasTopic: CandidateTopicItem = {
        id: 'top_second_gas_topic_1234567890123456',
        primaryLane: 'GAS',
        status: 'ACTIVE',
        latestRelevantEvidenceTimestamp: new Date(),
        requiredDerivedGeneration: 1,
      };

      const res = resolveTargetTopic({
        matchedTopicId: 'top_random_nonexistent_xyz_999999999',
        orderedSnapshotTopicIds,
        candidateTopics: [...candidateTopics, duplicateGasTopic],
        effectivePrimaryLane: 'GAS',
      });

      expect(res.status).toBe('UNRESOLVED');
      if (res.status === 'UNRESOLVED') {
        expect(res.fallbackLane).toBe('GAS');
      }
    });
  });

  describe('TopicMatchingEvaluator Prompt Generation', () => {
    it('labels candidate topics with 1-based index in buildUserPrompt', () => {
      const evaluator = new TopicMatchingEvaluator({} as any);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_test',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-07',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_mock',
        evidence: [
          {
            id: 'evi_1',
            topicId: 'top_test_gas_1234',
            telegramMessageId: '100',
            originalTimestamp: '2026-09-07T10:00:00.000Z',
            verbatimText: 'Gaz yoq',
            lane: 'GAS',
          },
        ],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: 'qoyile bugunam berishmadi',
        telegramMessageId: '257',
        originalTimestamp: '2026-09-07T16:17:03.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        relevantLanes: ['GAS'],
        relevanceReasoning: 'Gas failure report',
        snapshot,
      });

      expect(prompt).toContain('[Topic #1] ID: top_test_gas_1234');
      expect(prompt).toContain('matched_topic_index (e.g. 1) or matched_topic_id');
    });
  });

  describe('TopicProjectionResultSchema with anchor_evidence_index', () => {
    it('accepts anchor_evidence_index and coerces 0/string values safely', () => {
      const parsed = TopicProjectionResultSchema.parse({
        summary: 'Чиқиндилар олиб кетилмагани хабар қилинмоқда.',
        lanes: ['WASTE'],
        anchor_evidence_id: 'evi_123',
        anchor_evidence_index: '1',
        anchor_quote: 'Чиқинди кетмади',
        latest_meaningful_activity_timestamp: '2026-09-07T16:51:05.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });
      expect(parsed.anchor_evidence_index).toBe(1);

      const parsedZero = TopicProjectionResultSchema.parse({
        summary: 'Чиқиндилар олиб кетилмагани хабар қилинмоқда.',
        lanes: ['WASTE'],
        anchor_evidence_id: 'evi_123',
        anchor_evidence_index: 0,
        anchor_quote: 'Чиқинди кетмади',
        latest_meaningful_activity_timestamp: '2026-09-07T16:51:05.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });
      expect(parsedZero.anchor_evidence_index).toBeNull();
    });
  });

  describe('TopicProjectionEvaluator Anchor Resilience', () => {
    const sampleSnapshot: MahallaDailySnapshot = {
      districtId: 'dist_42aefae4-fdc4-4537-b524-47cddad6f2d2',
      mahallaName: 'Navbahor',
      calendarDay: '2026-09-07',
      contextRevision: 2,
      snapshotFingerprint: 'fp_resilience_test',
      evidence: [
        {
          id: 'evi_92db0cae-de79-474d-bbfc-ae0efceb0add',
          topicId: 'top_waste_1',
          telegramMessageId: '261',
          originalTimestamp: '2026-09-07T16:51:05.000Z',
          verbatimText: 'Musr kemadiku rais buva',
          lane: 'WASTE',
        },
        {
          id: 'evi_foreign_other_9999',
          topicId: 'top_other_gas',
          telegramMessageId: '257',
          originalTimestamp: '2026-09-07T16:17:03.000Z',
          verbatimText: 'qoyile bugunam berishmadi',
          lane: 'GAS',
        },
      ],
    };

    const createMockAiGateway = (returnData: TopicProjectionResult): any => ({
      generateStructured: async () => ({
        data: returnData,
        profileId: 'prof_test',
        provider: 'OPENAI',
        modelId: 'gpt-4o-mini',
        providerRequestId: 'req_1',
        durationMs: 50,
        tokens: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.0001,
        attempts: [],
      }),
    });

    it('recovers anchor_evidence_id from single-character UUID typo (e.g. 4f4d instead of 474d)', async () => {
      // Production bug: model returned 4f4d instead of 474d
      const typoResult: TopicProjectionResult = {
        summary: 'Чиқиндилар олиб кетилмагани хабар қилинмоқда.',
        lanes: ['WASTE'],
        anchor_evidence_id: 'evi_92db0cae-de79-4f4d-bbfc-ae0efceb0add', // 1 char typo!
        anchor_quote: 'Musr kemadiku rais buva',
        latest_meaningful_activity_timestamp: '2026-09-07T16:51:05.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(typoResult));
      const res = await evaluator.evaluateTopicProjection({
        topicId: 'top_waste_1',
        primaryLane: 'WASTE',
        generation: 1,
        snapshot: sampleSnapshot,
      });

      // Successfully resolved to the true database evidence ID
      expect(res.anchorEvidenceId).toBe('evi_92db0cae-de79-474d-bbfc-ae0efceb0add');
      expect(res.summary).toBe('Чиқиндилар олиб кетилмагани хабар қилинмоқда.');
    });

    it('resolves anchor evidence via 1-based index (anchor_evidence_index: 1)', async () => {
      const indexResult: TopicProjectionResult = {
        summary: 'Чиқиндилар олиб кетилмагани хабар қилинмоқда.',
        lanes: ['WASTE'],
        anchor_evidence_id: 'arbitrary_unmatched_id',
        anchor_evidence_index: 1,
        anchor_quote: 'Musr kemadiku rais buva',
        latest_meaningful_activity_timestamp: '2026-09-07T16:51:05.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(indexResult));
      const res = await evaluator.evaluateTopicProjection({
        topicId: 'top_waste_1',
        primaryLane: 'WASTE',
        generation: 1,
        snapshot: sampleSnapshot,
      });

      expect(res.anchorEvidenceId).toBe('evi_92db0cae-de79-474d-bbfc-ae0efceb0add');
    });

    it('strictly rejects when anchor_evidence_id belongs to a different topic in snapshot', async () => {
      const foreignResult: TopicProjectionResult = {
        summary: 'Чиқиндилар олиб кетилмагани хабар қилинмоқда.',
        lanes: ['WASTE'],
        anchor_evidence_id: 'evi_foreign_other_9999', // Belongs to top_other_gas!
        anchor_quote: 'Musr kemadiku rais buva',
        latest_meaningful_activity_timestamp: '2026-09-07T16:51:05.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(foreignResult));
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_waste_1',
          primaryLane: 'WASTE',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow('anchor_evidence_id "evi_foreign_other_9999" does not belong to target topic top_waste_1');
    });
  });
});

