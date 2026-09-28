import { describe, it, expect } from 'vitest';
import {
  TopicProjectionEvaluator,
  TopicProjectionResultSchema,
  TOPIC_PROJECTION_SYSTEM_PROMPT,
  isUzbekCyrillic,
  type TopicProjectionResult,
} from '../src/modules/topics/topic-projection-evaluator.js';
import type { AiGatewayPort } from '../src/modules/ai/ai-gateway.js';
import type { GenerateStructuredOptions, AiGatewayResult } from '../src/modules/ai/types.js';
import type { MahallaDailySnapshot } from '../src/modules/ai/context-snapshot.js';

describe('Story 2.5: Topic Projection Contracts & Evaluator Unit Tests', () => {
  describe('isUzbekCyrillic Validator', () => {
    it('returns true for authentic Uzbek Cyrillic text', () => {
      expect(isUzbekCyrillic('Маҳаллада электр таъминоти узилган')).toBe(true);
      expect(isUzbekCyrillic('Сув босими жуда паст, қачон тўғирланади?')).toBe(true);
      expect(isUzbekCyrillic('Чиқиндилар олиб кетилмаган')).toBe(true);
      expect(isUzbekCyrillic('Ҳоким ёрдамчисига мурожаат қилинди')).toBe(true);
    });

    it('returns false for pure Latin, English, empty, or numeric strings', () => {
      expect(isUzbekCyrillic('Mahallada elektr taminoti uzilgan')).toBe(false);
      expect(isUzbekCyrillic('Electricity outage reported in mahalla')).toBe(false);
      expect(isUzbekCyrillic('')).toBe(false);
      expect(isUzbekCyrillic('1234567890 !@#$%^&*()')).toBe(false);
    });

    it('returns false for predominantly Latin text with isolated rogue Cyrillic character', () => {
      expect(isUzbekCyrillic('Water outage in district 4 (А)')).toBe(false);
      expect(isUzbekCyrillic('Power failure occurred in mahalla а')).toBe(false);
    });
  });

  describe('TopicProjectionResultSchema Validation', () => {
    const validBase: TopicProjectionResult = {
      summary: 'Маҳаллада электр таъминотида узилишлар кузатилмоқда.',
      lanes: ['ELECTRICITY'],
      anchor_evidence_id: 'evi_1001',
      anchor_quote: 'Свет ўчди, 2 соат бўлди',
      latest_meaningful_activity_timestamp: '2026-08-22T08:30:00.000Z',
      attribution: 'Маҳалла аҳолиси хабарига кўра',
      is_hokim_related: false,
    };

    it('validates a correct single-lane projection result', () => {
      const parsed = TopicProjectionResultSchema.parse(validBase);
      expect(parsed.is_hokim_related).toBe(false);
      expect(parsed.lanes).toEqual(['ELECTRICITY']);
    });

    it('deduplicates duplicate lanes array items', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['ELECTRICITY', 'ELECTRICITY'],
      });
      expect(parsed.lanes).toEqual(['ELECTRICITY']);
    });

    it('validates a multi-lane projection with HOKIM_RELATED and is_hokim_related = true', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['WATER', 'HOKIM_RELATED'],
        is_hokim_related: true,
      });
      expect(parsed.is_hokim_related).toBe(true);
      expect(parsed.lanes).toEqual(['WATER', 'HOKIM_RELATED']);
    });

    it('validates Hokim-only projection with lanes: [HOKIM_RELATED]', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['HOKIM_RELATED'],
        is_hokim_related: true,
      });
      expect(parsed.is_hokim_related).toBe(true);
    });

    it('fails when lanes array is empty', () => {
      expect(() =>
        TopicProjectionResultSchema.parse({
          ...validBase,
          lanes: [],
          is_hokim_related: false,
        }),
      ).toThrow();
    });

    // L3-P05-02: ai-gateway.ts used to overwrite is_hokim_related from lanes BEFORE
    // safeParse, which made the refine below unreachable in production. The schema now
    // owns that derivation, so the model's disagreement is coerced here instead.
    it('derives is_hokim_related = true when HOKIM_RELATED is present but the model said false', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['WATER', 'HOKIM_RELATED'],
        is_hokim_related: false,
      });
      expect(parsed.is_hokim_related).toBe(true);
    });

    it('derives is_hokim_related = false when HOKIM_RELATED is absent but the model said true', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['WATER'],
        is_hokim_related: true,
      });
      expect(parsed.is_hokim_related).toBe(false);
    });

    it('derives is_hokim_related from deduplicated lanes', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['HOKIM_RELATED', 'HOKIM_RELATED'],
        is_hokim_related: false,
      });
      expect(parsed.lanes).toEqual(['HOKIM_RELATED']);
      expect(parsed.is_hokim_related).toBe(true);
    });

    it('still rejects an empty lanes array after coercion', () => {
      expect(() =>
        TopicProjectionResultSchema.parse({
          ...validBase,
          lanes: [],
          is_hokim_related: true,
        }),
      ).toThrow();
    });

    // Follow-up to L3-P05-02. `is_hokim_related` is a pure function of `lanes`, so it
    // is no longer model-facing: the prompt does not request it and the schema derives
    // it. These two payloads OMIT the field entirely and must still parse -- under the
    // previous schema they FAILED, because the field was a required boolean and a
    // `.refine` policed its agreement with `lanes`.
    it('derives is_hokim_related = true from lanes when the model omits the field', () => {
      const parsed = TopicProjectionResultSchema.parse({
        summary: validBase.summary,
        lanes: ['WATER', 'HOKIM_RELATED'],
        anchor_evidence_id: validBase.anchor_evidence_id,
        anchor_quote: validBase.anchor_quote,
        latest_meaningful_activity_timestamp: validBase.latest_meaningful_activity_timestamp,
        attribution: validBase.attribution,
      });
      expect(parsed.is_hokim_related).toBe(true);
      expect(parsed.lanes).toEqual(['WATER', 'HOKIM_RELATED']);
    });

    it('derives is_hokim_related = false from lanes when the model omits the field', () => {
      const parsed = TopicProjectionResultSchema.parse({
        summary: validBase.summary,
        lanes: ['WATER'],
        anchor_evidence_id: validBase.anchor_evidence_id,
        anchor_quote: validBase.anchor_quote,
        latest_meaningful_activity_timestamp: validBase.latest_meaningful_activity_timestamp,
        attribution: validBase.attribution,
      });
      expect(parsed.is_hokim_related).toBe(false);
    });

    // The field is not merely optional -- it is ignored. A model that echoes a stale or
    // wrong value cannot influence the derived one, and cannot cause a rejection either.
    it('ignores a model-supplied is_hokim_related rather than validating it', () => {
      const parsed = TopicProjectionResultSchema.parse({
        ...validBase,
        lanes: ['WATER'],
        is_hokim_related: true,
      });
      expect(parsed.is_hokim_related).toBe(false);
    });

    it('fails when timestamp is not valid ISO-8601 datetime', () => {
      expect(() =>
        TopicProjectionResultSchema.parse({
          ...validBase,
          latest_meaningful_activity_timestamp: 'invalid-date',
        }),
      ).toThrow();
    });
  });

  describe('TopicProjectionEvaluator Guardrails & Execution', () => {
    const createMockAiGateway = (returnData: TopicProjectionResult): AiGatewayPort => {
      return {
        generateStructured: async <T>(
          _options: GenerateStructuredOptions<T>,
        ): Promise<AiGatewayResult<T>> => {
          return {
            data: returnData as unknown as T,
            profileId: 'prof_proj_2026_08_v1',
            provider: 'OPENAI',
            modelId: 'gpt-4o-mini-2024-07-18',
            providerRequestId: 'req_test_1',
            durationMs: 120,
            tokens: { inputTokens: 250, outputTokens: 60 },
            estimatedCostUsd: 0.0001,
            attempts: [],
          };
        },
      } as unknown as AiGatewayPort;
    };

    const sampleSnapshot: MahallaDailySnapshot = {
      districtId: 'dist_tashkent_chilanzar',
      mahallaName: 'Guliston',
      calendarDay: '2026-08-22',
      contextRevision: 2,
      snapshotFingerprint: 'fp_123',
      evidence: [
        {
          id: 'evi_target_1',
          topicId: 'top_elec_1',
          telegramMessageId: '101',
          originalTimestamp: '2026-08-22T08:00:00.000Z',
          verbatimText: 'Свет ўчди, 1-домда умуман йўқ',
          lane: 'ELECTRICITY',
        },
        {
          id: 'evi_target_2',
          topicId: 'top_elec_1',
          telegramMessageId: '102',
          originalTimestamp: '2026-08-22T08:30:00.000Z',
          verbatimText: 'Бизда ҳам ўчди',
          lane: 'ELECTRICITY',
        },
        {
          id: 'evi_other_1',
          topicId: 'top_water_2',
          telegramMessageId: '103',
          originalTimestamp: '2026-08-22T08:45:00.000Z',
          verbatimText: 'Сув босими пасайиб кетди',
          lane: 'WATER',
        },
      ],
    };

    it('builds clear user prompt with target topic and context separation', () => {
      const evaluator = new TopicProjectionEvaluator(createMockAiGateway({} as any));
      const prompt = evaluator.buildUserPrompt({
        topicId: 'top_elec_1',
        primaryLane: 'ELECTRICITY',
        generation: 1,
        snapshot: sampleSnapshot,
      });

      expect(prompt).toContain('### TARGET TOPIC TO RECALCULATE');
      expect(prompt).toContain('Topic ID: top_elec_1');
      expect(prompt).toContain('Primary Lane (Immutable): ELECTRICITY');
      expect(prompt).toContain('### ACCEPTED EVIDENCE FOR TARGET TOPIC (top_elec_1)');
      expect(prompt).toContain('evi_target_1');
      expect(prompt).toContain('### OTHER SAME-DAY TOPICS IN MAHALLA (Context Only)');
      expect(prompt).toContain('top_water_2');
    });

    it('formats single-citizen multi-message topic with Citizen #1 and Same citizen labels', () => {
      const singleCitizenSnapshot: MahallaDailySnapshot = {
        districtId: 'dist_tashkent_chilanzar',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-11',
        contextRevision: 2,
        snapshotFingerprint: 'fp_same_author',
        evidence: [
          {
            id: 'evi_416',
            topicId: 'top_water_1',
            telegramMessageId: '416',
            telegramUserId: 'user_zubaydulla_751',
            authorHandle: '@ZubaydullaOkhunboboyev',
            originalTimestamp: '2026-09-11T16:03:10.000Z',
            verbatimText: 'suv quridimi hammada',
            lane: 'WATER',
          },
          {
            id: 'evi_417',
            topicId: 'top_water_1',
            telegramMessageId: '417',
            telegramUserId: 'user_zubaydulla_751',
            authorHandle: '@ZubaydullaOkhunboboyev',
            originalTimestamp: '2026-09-11T16:03:25.000Z',
            verbatimText: 'yoki bizdami faqat',
            lane: 'WATER',
          },
        ],
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway({} as any));
      const prompt = evaluator.buildUserPrompt({
        topicId: 'top_water_1',
        primaryLane: 'WATER',
        generation: 1,
        snapshot: singleCitizenSnapshot,
      });

      expect(prompt).toContain('- Distinct Reporting Residents: 1 unique citizen (Citizen #1)');
      expect(prompt).toContain('- Total Evidence Items: 2 message(s)');
      expect(prompt).toContain('Author: [Citizen #1 (@ZubaydullaOkhunboboyev)]');
      expect(prompt).toContain('Author: [Citizen #1 (Same citizen)]');
    });

    it('formats multi-citizen topic with distinct citizen indices', () => {
      const multiCitizenSnapshot: MahallaDailySnapshot = {
        districtId: 'dist_tashkent_chilanzar',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-11',
        contextRevision: 2,
        snapshotFingerprint: 'fp_multi_author',
        evidence: [
          {
            id: 'evi_1',
            topicId: 'top_water_1',
            telegramMessageId: '100',
            telegramUserId: 'user_1',
            authorHandle: '@citizen1',
            originalTimestamp: '2026-09-11T16:00:00.000Z',
            verbatimText: 'suv yo`q',
            lane: 'WATER',
          },
          {
            id: 'evi_2',
            topicId: 'top_water_1',
            telegramMessageId: '101',
            telegramUserId: 'user_2',
            authorHandle: '@citizen2',
            originalTimestamp: '2026-09-11T16:05:00.000Z',
            verbatimText: 'bizda ham yo`q',
            lane: 'WATER',
          },
        ],
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway({} as any));
      const prompt = evaluator.buildUserPrompt({
        topicId: 'top_water_1',
        primaryLane: 'WATER',
        generation: 1,
        snapshot: multiCitizenSnapshot,
      });

      expect(prompt).toContain('- Distinct Reporting Residents: 2 distinct citizens');
      expect(prompt).toContain('Author: [Citizen #1 (@citizen1)]');
      expect(prompt).toContain('Author: [Citizen #2 (@citizen2)]');
    });

    it('verifies system prompt contains author continuity invariants preventing false corroboration', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('CRITICAL AUTHOR CONTINUITY INVARIANT');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('SAME CITIZEN CONTINUATION');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('STRICTLY FORBIDDEN: "Яна бир фуқаро узилишни тасдиқлади"');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('DISTINCT CITIZEN CORROBORATION');
    });

    it('successfully evaluates and returns projection when all guardrails pass', async () => {
      const validResult: TopicProjectionResult = {
        summary: 'Маҳалла аҳолиси хабарига кўра, электр таъминотида узилиш юз берган.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_target_1',
        anchor_quote: 'Свет ўчди, 1-домда умуман йўқ',
        latest_meaningful_activity_timestamp: '2026-08-22T08:30:00.000Z',
        attribution: 'Маҳалла аҳолиси хабарига кўра',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(validResult));
      const evaluation = await evaluator.evaluateTopicProjection({
        topicId: 'top_elec_1',
        primaryLane: 'ELECTRICITY',
        generation: 1,
        snapshot: sampleSnapshot,
      });

      expect(evaluation.summary).toBe(validResult.summary);
      expect(evaluation.lanes).toEqual(['ELECTRICITY']);
      expect(evaluation.primaryLane).toBe('ELECTRICITY');
      expect(evaluation.anchorEvidenceId).toBe('evi_target_1');
      expect(evaluation.latestMeaningfulActivityTimestamp).toBe('2026-08-22T08:30:00.000Z');
      expect(evaluation.isHokimRelated).toBe(false);
      expect(evaluation.generation).toBe(1);
    });

    it('resolves anchor_evidence_index against the SAME capped list the prompt labels', async () => {
      // 20 target evidence items. buildUserPrompt caps the prompt to the LAST 15
      // and labels those survivors "Evidence #1".."Evidence #15", so the item the
      // model sees as "Evidence #1" is evi_target_6 (index 5 of the full list),
      // NOT evi_target_1 (index 0).
      const targetItems = Array.from({ length: 20 }, (_, i) => ({
        id: `evi_target_${i + 1}`,
        topicId: 'top_elec_1',
        telegramMessageId: `${100 + i}`,
        telegramUserId: 'user_1',
        originalTimestamp: `2026-08-22T08:${String(i).padStart(2, '0')}:00.000Z`,
        verbatimText: `message ${i + 1}`,
        lane: 'ELECTRICITY' as const,
      }));

      const largeSnapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-22',
        contextRevision: 20,
        snapshotFingerprint: 'fp_20_items',
        evidence: targetItems,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway({
          summary: 'Маҳаллада электр таъминотида узилишлар кузатилмоқда.',
          lanes: ['ELECTRICITY'],
          // The model cites BOTH forms, as the schema asks it to. It correctly points
          // at the item the prompt labelled "Evidence #1" and echoes that item's id.
          anchor_evidence_id: 'evi_target_6',
          anchor_evidence_index: 1,
          anchor_quote: 'message 6',
          latest_meaningful_activity_timestamp: '2026-08-22T08:19:00.000Z',
          attribution: 'Маҳалла аҳолиси хабарига кўра',
          is_hokim_related: false,
        }),
      );

      const evaluation = await evaluator.evaluateTopicProjection({
        topicId: 'top_elec_1',
        primaryLane: 'ELECTRICITY',
        generation: 1,
        snapshot: largeSnapshot,
      });

      // The resolved anchor must be the evidence the prompt presented as
      // "Evidence #1" — the first item of the capped slice — not the first item
      // of the untruncated list.
      expect(evaluation.anchorEvidenceId).toBe('evi_target_6');
    });

    it('rejects when anchor_evidence_id belongs to another topic', async () => {
      const foreignAnchorResult: TopicProjectionResult = {
        summary: 'Маҳаллада электр таъминоти узилганлиги хабар қилинди.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_other_1', // belongs to top_water_2!
        anchor_quote: 'Сув босими пасайиб кетди',
        latest_meaningful_activity_timestamp: '2026-08-22T08:00:00.000Z',
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(foreignAnchorResult));
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_elec_1',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow(
        'anchor_evidence_id "evi_other_1" does not belong to target topic top_elec_1',
      );
    });

    it('rejects when latest_meaningful_activity_timestamp does not match any target evidence timestamp', async () => {
      const invalidTimestampResult: TopicProjectionResult = {
        summary: 'Маҳаллада электр таъминоти узилганлиги хабар қилинди.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_target_1',
        anchor_quote: 'Свет ўчди',
        latest_meaningful_activity_timestamp: '2026-08-22T09:15:00.000Z', // Not in target topic!
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway(invalidTimestampResult),
      );
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_elec_1',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow(
        'latest_meaningful_activity_timestamp "2026-08-22T09:15:00.000Z" does not match any evidence timestamp in target topic top_elec_1',
      );
    });

    it('rejects when derived lanes array misses target topic immutable primaryLane', async () => {
      const missingPrimaryResult: TopicProjectionResult = {
        summary: 'Маҳаллада сув таъминоти ва ҳокимят назорати хабар қилинди.',
        lanes: ['WATER', 'HOKIM_RELATED'], // Missing ELECTRICITY!
        anchor_evidence_id: 'evi_target_1',
        anchor_quote: 'Свет ўчди',
        latest_meaningful_activity_timestamp: '2026-08-22T08:00:00.000Z',
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: true,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway(missingPrimaryResult),
      );
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_elec_1',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow(
        'Derived lanes [WATER, HOKIM_RELATED] must include target topic\'s immutable primary lane "ELECTRICITY"',
      );
    });

    it('rejects when summary is not in authentic Uzbek Cyrillic text', async () => {
      const latinSummaryResult: TopicProjectionResult = {
        summary: 'Mahallada elektr taminoti uzilganligi haqida xabar berildi.', // Pure Latin!
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_target_1',
        anchor_quote: 'Свет ўчди',
        latest_meaningful_activity_timestamp: '2026-08-22T08:00:00.000Z',
        attribution: 'Mahalla aholisi',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway(latinSummaryResult),
      );
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_elec_1',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow('Summary must contain authentic Uzbek Cyrillic characters');
    });

    it('rejects when target topic has 0 evidence in snapshot', async () => {
      const evaluator = new TopicProjectionEvaluator(createMockAiGateway({} as any));
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_non_existent',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow('Cannot calculate topic projection: target topic top_non_existent has no accepted evidence in snapshot');
    });

    it('rejects when output contains forbidden phone number patterns', async () => {
      const phoneSummaryResult: TopicProjectionResult = {
        summary: 'Маҳаллада свет ўчди, мурожаат учун +998901234567 га қўнғироқ қилинг.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_target_1',
        anchor_quote: 'Свет ўчди',
        latest_meaningful_activity_timestamp: '2026-08-22T08:00:00.000Z',
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway(phoneSummaryResult),
      );
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_elec_1',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow('Output contains forbidden phone number pattern violating privacy invariants');
    });

    it('rejects when timestamp string is invalid and cannot be parsed', async () => {
      const invalidTimestampResult: TopicProjectionResult = {
        summary: 'Маҳаллада свет ўчди.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_target_1',
        anchor_quote: 'Свет ўчди',
        latest_meaningful_activity_timestamp: 'invalid-date-string',
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway(invalidTimestampResult),
      );
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_elec_1',
          primaryLane: 'ELECTRICITY',
          generation: 1,
          snapshot: sampleSnapshot,
        }),
      ).rejects.toThrow('is not a valid ISO-8601 date string');
    });
  });

  describe('Pragmatic Core Civic Disruption & Volume-Aware Attribution Scenarios', () => {
    const createMockAiGateway = (returnData: TopicProjectionResult): AiGatewayPort => {
      return {
        generateStructured: async <T>(
          _options: GenerateStructuredOptions<T>,
        ): Promise<AiGatewayResult<T>> => {
          return {
            data: returnData as unknown as T,
            profileId: 'prof_proj_2026_08_v1',
            provider: 'OPENAI',
            modelId: 'gpt-4o-mini-2024-07-18',
            providerRequestId: 'req_test_inquiry',
            durationMs: 110,
            tokens: { inputTokens: 220, outputTokens: 50 },
            estimatedCostUsd: 0.0001,
            attempts: [],
          };
        },
      } as unknown as AiGatewayPort;
    };

    it('evaluates single-citizen inquiry message with concise disruption summary and single-citizen attribution', async () => {
      const singleInquirySnapshot: MahallaDailySnapshot = {
        districtId: 'dist_tashkent_chilanzar',
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        contextRevision: 1,
        snapshotFingerprint: 'fp_inquiry_1',
        evidence: [
          {
            id: 'evi_inquiry_1',
            topicId: 'top_elec_inquiry',
            telegramMessageId: '501',
            originalTimestamp: '2026-08-22T10:15:00.000Z',
            verbatimText: 'salom mahalladoshlar! svet hammada ucdimi yoki bizdami faqat?',
            lane: 'ELECTRICITY',
          },
        ],
      };

      const expectedProjection: TopicProjectionResult = {
        summary: 'Электр таъминотида узилиш юз бергани хабар қилинмоқда.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_inquiry_1',
        anchor_quote: 'salom mahalladoshlar! svet hammada ucdimi yoki bizdami faqat?',
        latest_meaningful_activity_timestamp: '2026-08-22T10:15:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(expectedProjection));
      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_elec_inquiry',
        primaryLane: 'ELECTRICITY',
        generation: 1,
        snapshot: singleInquirySnapshot,
      });

      expect(result.summary).toBe('Электр таъминотида узилиш юз бергани хабар қилинмоқда.');
      expect(result.attribution).toBe('Маҳалла фуқароси');
      expect(result.lanes).toEqual(['ELECTRICITY']);
      expect(isUzbekCyrillic(result.summary)).toBe(true);
      expect(isUzbekCyrillic(result.attribution)).toBe(true);
    });

    it('evaluates multi-resident corroborating topic with multi-resident attribution', async () => {
      const multiEvidenceSnapshot: MahallaDailySnapshot = {
        districtId: 'dist_tashkent_chilanzar',
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        contextRevision: 2,
        snapshotFingerprint: 'fp_multi_1',
        evidence: [
          {
            id: 'evi_multi_1',
            topicId: 'top_elec_multi',
            telegramMessageId: '601',
            originalTimestamp: '2026-08-22T10:15:00.000Z',
            verbatimText: 'svet ochdi 12-domda',
            lane: 'ELECTRICITY',
          },
          {
            id: 'evi_multi_2',
            topicId: 'top_elec_multi',
            telegramMessageId: '602',
            originalTimestamp: '2026-08-22T10:18:00.000Z',
            verbatimText: 'bizda ham yoq 14-dom',
            lane: 'ELECTRICITY',
          },
        ],
      };

      const multiProjection: TopicProjectionResult = {
        summary: 'Электр таъминотида узилиш сақланиб қолмоқда.',
        lanes: ['ELECTRICITY'],
        anchor_evidence_id: 'evi_multi_1',
        anchor_quote: 'svet ochdi 12-domda',
        latest_meaningful_activity_timestamp: '2026-08-22T10:18:00.000Z',
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(multiProjection));
      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_elec_multi',
        primaryLane: 'ELECTRICITY',
        generation: 2,
        snapshot: multiEvidenceSnapshot,
      });

      expect(result.summary).toBe('Электр таъминотида узилиш сақланиб қолмоқда.');
      expect(result.attribution).toBe('Маҳалла аҳолиси');
    });

    it('rejects summary containing prohibited bureaucratic filler placeholder (Guardrail 6)', async () => {
      const testSnapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-02',
        contextRevision: 1,
        snapshotFingerprint: 'fp_bureau_1',
        evidence: [
          {
            id: 'evi_bureau_1',
            topicId: 'top_water_bureau',
            telegramMessageId: '801',
            originalTimestamp: '2026-09-02T22:02:00.000Z',
            verbatimText: 'suv keb turgandedi',
            lane: 'WATER',
          },
        ],
      };

      const bureaucraticResult: TopicProjectionResult = {
        summary: 'Сув таъминотининг барқарорлиги ҳақида маълумот олинмоқда.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_bureau_1',
        anchor_quote: 'suv keb turgandedi',
        latest_meaningful_activity_timestamp: '2026-09-02T22:02:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(
        createMockAiGateway(bureaucraticResult),
      );
      await expect(
        evaluator.evaluateTopicProjection({
          topicId: 'top_water_bureau',
          primaryLane: 'WATER',
          generation: 1,
          snapshot: testSnapshot,
        }),
      ).rejects.toThrow(
        'Summary contains prohibited bureaucratic filler/placeholder',
      );

      const discussionResult: TopicProjectionResult = {
        ...bureaucraticResult,
        summary: 'Чиқинди муаммоси маҳаллада муҳокама қилинмоқда.',
      };
      const discussionEvaluator = new TopicProjectionEvaluator(
        createMockAiGateway(discussionResult),
      );
      await expect(
        discussionEvaluator.evaluateTopicProjection({
          topicId: 'top_water_bureau',
          primaryLane: 'WATER',
          generation: 1,
          snapshot: testSnapshot,
        }),
      ).rejects.toThrow(
        'Summary contains prohibited bureaucratic filler/placeholder',
      );
    });

    it('validates canonical disruption summary for colloquial past-continuous lamentation', async () => {
      const waterSnapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-02',
        contextRevision: 2,
        snapshotFingerprint: 'fp_water_past',
        evidence: [
          {
            id: 'evi_water_1',
            topicId: 'top_water_past',
            telegramMessageId: '701',
            originalTimestamp: '2026-09-02T22:02:00.000Z',
            verbatimText: 'hec bumasa',
            lane: 'WATER',
          },
          {
            id: 'evi_water_2',
            topicId: 'top_water_past',
            telegramMessageId: '702',
            originalTimestamp: '2026-09-02T22:02:00.000Z',
            verbatimText: 'suv keb turgandedi',
            lane: 'WATER',
          },
        ],
      };

      const validWaterProjection: TopicProjectionResult = {
        summary: 'Сув таъминотида узилиш юз бергани хабар қилинмоқда.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_water_2',
        anchor_quote: 'suv keb turgandedi',
        latest_meaningful_activity_timestamp: '2026-09-02T22:02:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      };

      const evaluator = new TopicProjectionEvaluator(createMockAiGateway(validWaterProjection));
      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_water_past',
        primaryLane: 'WATER',
        generation: 1,
        snapshot: waterSnapshot,
      });

      expect(result.summary).toBe('Сув таъминотида узилиш юз бергани хабар қилинмоқда.');
      expect(result.anchorEvidenceId).toBe('evi_water_2');
      expect(result.anchorQuote).toBe('suv keb turgandedi');
    });

    it('enforces prompt budgeting: caps target evidence to 15 items and other topics to 5 topics with 2 items each', () => {
      const mockGateway = createMockAiGateway({
        summary: 'test',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_1',
        anchor_quote: 'quote',
        latest_meaningful_activity_timestamp: '2026-09-02T22:00:00.000Z',
        attribution: 'test',
        is_hokim_related: false,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const targetItems = Array.from({ length: 20 }, (_, i) => ({
        id: `evi_target_${i + 1}`,
        topicId: 'top_target',
        telegramMessageId: `${100 + i}`,
        originalTimestamp: new Date(Date.now() + i * 1000).toISOString(),
        verbatimText: `message ${i + 1}`,
        lane: 'WATER',
      }));

      const otherItems: any[] = [];
      for (let t = 1; t <= 8; t++) {
        for (let m = 1; m <= 4; m++) {
          otherItems.push({
            id: `evi_other_${t}_${m}`,
            topicId: `top_other_${t}`,
            telegramMessageId: `${200 + t * 10 + m}`,
            originalTimestamp: new Date(Date.now() + (t * 10 + m) * 1000).toISOString(),
            verbatimText: `other topic ${t} message ${m}`,
            lane: 'ELECTRICITY',
          });
        }
      }

      const prompt = evaluator.buildUserPrompt({
        topicId: 'top_target',
        primaryLane: 'WATER',
        generation: 1,
        snapshot: {
          districtId: 'dist_1',
          mahallaName: 'Navbahor',
          calendarDay: '2026-09-02',
          contextRevision: 1,
          snapshotFingerprint: 'fp_large',
          evidence: [...targetItems, ...otherItems],
        },
      });

      expect(prompt).toContain('Evidence #15');
      expect(prompt).not.toContain('Evidence #16');
      expect(prompt).toContain('top_other_5');
      expect(prompt).toContain('additional same-day topics omitted for brevity');
      expect(prompt).toContain('other topic 1 message 4');
      expect(prompt).toContain('other topic 1 message 3');
      expect(prompt).not.toContain('other topic 1 message 2');
      expect(prompt).not.toContain('other topic 1 message 1');
    });

    it('ensures system prompt defines location and landmark policy for communal outages vs acute point hazards', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('LOCATION & LANDMARK POLICY (HIGH-LEVEL OUTAGES VS. ACUTE POINT HAZARDS)');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('DO NOT prefix or enumerate specific street names or landmarks in the summary title!');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('Электросеть орқасидаги кўчада');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('NEVER strip the landmark or street reference');
    });

    it('ensures system prompt defines HOKIM_RELATED multi-lane derivation strictly for explicit appeals', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('HOKIM_RELATED QUALIFICATION CRITERIA');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('Include HOKIM_RELATED if and only if at least one evidence item in the topic explicitly contains designated Hokim/Hokimiyat terms');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('"xokim", "hakim", "xakim", "hokimyat", "xokimyat", "hokimat", "xokimat", "hokim buva", "hokimbobo", "hokimimiz"');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('"zamhokim", "hokim yordamchisi"');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('Road defects, mud, or unpaved street issues without explicit Hokim/Hokimiyat mentions must NEVER derive HOKIM_RELATED');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('"mahalla raisi" or "oqsoqol" alone does NOT qualify for HOKIM_RELATED');
    });

    it('extracts landmark prefix into summary title for localized pipe leak (Card 1 Navbahor case)', async () => {
      const mockGateway = createMockAiGateway({
        summary: 'Электросеть орқасидаги кўчада сув қувурининг сизиши ёки оқиб кетиши хабар қилинмоқда.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_elektroset_1',
        anchor_quote: 'elektroset arqasideyi kucada suv oqib yotipti shetda. 2 kun buldi.',
        latest_meaningful_activity_timestamp: '2026-09-03T12:39:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-03',
        contextRevision: 3,
        snapshotFingerprint: 'fp_navbahor_elektroset',
        evidence: [
          {
            id: 'evi_elektroset_1',
            topicId: 'top_navbahor_pipe_elektroset',
            telegramMessageId: '123901',
            originalTimestamp: '2026-09-03T12:39:00.000Z',
            verbatimText: 'elektroset arqasideyi kucada suv oqib yotipti shetda. 2 kun buldi.',
            lane: 'WATER',
          },
          {
            id: 'evi_elektroset_2',
            topicId: 'top_navbahor_pipe_elektroset',
            telegramMessageId: '123902',
            originalTimestamp: '2026-09-03T12:39:30.000Z',
            verbatimText: 'vodokanalga aytsh kere',
            lane: 'WATER',
          },
        ],
      };

      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_navbahor_pipe_elektroset',
        primaryLane: 'WATER',
        generation: 1,
        snapshot,
        profileId: 'prof_proj_2026_08_v1',
      });

      expect(result.summary).toBe('Электросеть орқасидаги кўчада сув қувурининг сизиши ёки оқиб кетиши хабар қилинмоқда.');
      expect(result.summary).toContain('Электросеть орқасидаги кўчада');
      expect(result.anchorEvidenceId).toBe('evi_elektroset_1');
      expect(result.lanes).toEqual(['WATER']);
      expect(result.isHokimRelated).toBe(false);
    });

    it('ensures system prompt defines instructions for sarcasm, rhetorical questions, and exasperated escalations', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('RHETORICAL EXASPERATION, SARCASM & CYNICAL ESCALATIONS');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('hokimiyatga chiqish shartmi?');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('ACTIVE EXPRESSIONS OF GRIEVANCE / DISSATISFACTION');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('Ҳокимликка мурожаат қилиш зарурати юзасидан сўров қабул қилинди');
    });

    it('ensures system prompt strictly forbids bureaucratic ticketing and intake placeholders', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('...сўрови қабул қилинди');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('...мурожаати рўйхатга олинди');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('...кўриб чиқилмоқда');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('...мурожаат қайд этилди');
    });

    it('ensures system prompt defines causal grounding for HOKIM_RELATED summaries', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('HOKIM_RELATED (CAUSAL GROUNDING)');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('мутасаддилар эътиборсизлиги юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('Ҳокимлик ва мутасадди идоралар фаолияти юзасидан эътироз билдирилгани хабар қилинмоқда');
    });

    it('projects HOKIM_RELATED topic grounded in water utility inaction rather than literal procedural inquiry', async () => {
      const mockGateway = createMockAiGateway({
        summary: 'Сув таъминотидаги муаммо бўйича мутасаддилар эътиборсизлиги юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда.',
        lanes: ['HOKIM_RELATED'],
        anchor_evidence_id: 'evi_hokim_1',
        anchor_quote: 'hokimiyatga ciqish shartmi',
        latest_meaningful_activity_timestamp: '2026-09-04T08:38:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: true,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 3,
        snapshotFingerprint: 'fp_navbahor_water_hokim',
        evidence: [
          {
            id: 'evi_water_1',
            topicId: 'top_water_inaction',
            telegramMessageId: '181',
            originalTimestamp: '2026-09-04T08:36:00.000Z',
            verbatimText: 'hec kim ishi yu',
            lane: 'WATER',
          },
          {
            id: 'evi_water_2',
            topicId: 'top_water_inaction',
            telegramMessageId: '182',
            originalTimestamp: '2026-09-04T08:37:00.000Z',
            verbatimText: 'na vodokanal qaredi na boshqasi',
            lane: 'WATER',
          },
          {
            id: 'evi_hokim_1',
            topicId: 'top_hokim_appeal',
            telegramMessageId: '183',
            originalTimestamp: '2026-09-04T08:38:00.000Z',
            verbatimText: 'hokimiyatga ciqish shartmi',
            lane: 'HOKIM_RELATED',
          },
        ],
      };

      // Ensure buildUserPrompt supplies both the target topic and the other same-day topic context
      const userPrompt = evaluator.buildUserPrompt({
        topicId: 'top_hokim_appeal',
        primaryLane: 'HOKIM_RELATED',
        generation: 1,
        snapshot,
      });

      expect(userPrompt).toContain('hokimiyatga ciqish shartmi');
      expect(userPrompt).toContain('Other Topic ID: top_water_inaction');
      expect(userPrompt).toContain('na vodokanal qaredi na boshqasi');

      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_hokim_appeal',
        primaryLane: 'HOKIM_RELATED',
        generation: 1,
        snapshot,
      });

      expect(result.summary).toBe('Сув таъминотидаги муаммо бўйича мутасаддилар эътиборсизлиги юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда.');
      expect(result.summary).not.toContain('сўрови қабул қилинди');
      expect(result.summary).not.toContain('зарурати юзасидан');
      expect(result.isHokimRelated).toBe(true);
      expect(result.lanes).toEqual(['HOKIM_RELATED']);
      expect(result.anchorEvidenceId).toBe('evi_hokim_1');
      expect(isUzbekCyrillic(result.summary)).toBe(true);
    });

    it('projects topic with colloquial Hokim slang and derives HOKIM_RELATED lane', async () => {
      const mockGateway = createMockAiGateway({
        summary: 'Кўчадаги лой ва йўл таъмири бўйича ҳокимликка эътироз билдирилгани хабар қилинмоқда.',
        lanes: ['HOKIM_RELATED'],
        anchor_evidence_id: 'evi_slang_1',
        anchor_quote: "xokim buva ko'chamizdagi loyga qachon qaraysiz?",
        latest_meaningful_activity_timestamp: '2026-09-04T09:15:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: true,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'fp_hokim_slang',
        evidence: [
          {
            id: 'evi_slang_1',
            topicId: 'top_slang_road',
            telegramMessageId: '191',
            originalTimestamp: '2026-09-04T09:15:00.000Z',
            verbatimText: "xokim buva ko'chamizdagi loyga qachon qaraysiz?",
            lane: 'HOKIM_RELATED',
          },
        ],
      };

      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_slang_road',
        primaryLane: 'HOKIM_RELATED',
        generation: 1,
        snapshot,
      });

      expect(result.summary).toBe('Кўчадаги лой ва йўл таъмири бўйича ҳокимликка эътироз билдирилгани хабар қилинмоқда.');
      expect(result.isHokimRelated).toBe(true);
      expect(result.lanes).toEqual(['HOKIM_RELATED']);
      expect(result.anchorEvidenceId).toBe('evi_slang_1');
    });

    it('does not derive HOKIM_RELATED for road defect topic lacking explicit Hokim mentions', async () => {
      const mockGateway = createMockAiGateway({
        summary: 'Кўча таъмири бўйича муаммо хабар қилинмоқда.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_road_1',
        anchor_quote: "Ko'chamizda chuqurlar ko'p, mashinalar o'tolmayapti",
        latest_meaningful_activity_timestamp: '2026-09-04T09:20:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'fp_road_nohokim',
        evidence: [
          {
            id: 'evi_road_1',
            topicId: 'top_road_defect',
            telegramMessageId: '192',
            originalTimestamp: '2026-09-04T09:20:00.000Z',
            verbatimText: "Ko'chamizda chuqurlar ko'p, mashinalar o'tolmayapti",
            lane: 'WATER',
          },
        ],
      };

      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_road_defect',
        primaryLane: 'WATER',
        generation: 1,
        snapshot,
      });

      expect(result.isHokimRelated).toBe(false);
      expect(result.lanes).not.toContain('HOKIM_RELATED');
      expect(result.lanes).toEqual(['WATER']);
    });

    it('does not derive HOKIM_RELATED for mahalla raisi grievance without Hokim mention', async () => {
      const mockGateway = createMockAiGateway({
        summary: 'Маҳалла фаолияти юзасидан муҳокама билдирилди.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_raisi_1',
        anchor_quote: 'Mahalla raisi qachon hisobot beradi, qayerga qarayapti?',
        latest_meaningful_activity_timestamp: '2026-09-04T09:25:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'fp_raisi_nohokim',
        evidence: [
          {
            id: 'evi_raisi_1',
            topicId: 'top_raisi_topic',
            telegramMessageId: '193',
            originalTimestamp: '2026-09-04T09:25:00.000Z',
            verbatimText: 'Mahalla raisi qachon hisobot beradi, qayerga qarayapti?',
            lane: 'WATER',
          },
        ],
      };

      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_raisi_topic',
        primaryLane: 'WATER',
        generation: 1,
        snapshot,
      });

      expect(result.isHokimRelated).toBe(false);
      expect(result.lanes).not.toContain('HOKIM_RELATED');
    });

    it('projects multi-street communal gas outage to high-level summary without street names in title and volume attribution', async () => {
      const mockGateway = createMockAiGateway({
        summary: 'Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.',
        lanes: ['GAS'],
        anchor_evidence_id: 'evi_gas_multi_1',
        anchor_quote: "Bog'zor ko'chasida gaz yo'q, o'chib qoldi",
        latest_meaningful_activity_timestamp: '2026-09-04T10:35:00.000Z',
        attribution: 'Маҳалла аҳолиси',
        is_hokim_related: false,
      });
      const evaluator = new TopicProjectionEvaluator(mockGateway);

      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 3,
        snapshotFingerprint: 'fp_gas_multi_streets',
        evidence: [
          {
            id: 'evi_gas_multi_1',
            topicId: 'top_gas_communal_multi',
            telegramMessageId: '9001',
            originalTimestamp: '2026-09-04T10:00:00.000Z',
            verbatimText: "Bog'zor ko'chasida gaz yo'q, o'chib qoldi",
            lane: 'GAS',
          },
          {
            id: 'evi_gas_multi_2',
            topicId: 'top_gas_communal_multi',
            telegramMessageId: '9002',
            originalTimestamp: '2026-09-04T10:15:00.000Z',
            verbatimText: "Navro'z ko'chasidayam gaz o'chdi, sovuq bo'lib ketyapti",
            lane: 'GAS',
          },
          {
            id: 'evi_gas_multi_3',
            topicId: 'top_gas_communal_multi',
            telegramMessageId: '9003',
            originalTimestamp: '2026-09-04T10:35:00.000Z',
            verbatimText: 'Bizda ham gaz yoq, qachon beradi',
            lane: 'GAS',
          },
        ],
      };

      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_gas_communal_multi',
        primaryLane: 'GAS',
        generation: 1,
        snapshot,
      });

      expect(result.summary).toBe('Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.');
      expect(result.summary).not.toContain('Боғзор');
      expect(result.summary).not.toContain('Наврўз');
      expect(result.attribution).toBe('Маҳалла аҳолиси');
      expect(result.lanes).toEqual(['GAS']);
      expect(result.isHokimRelated).toBe(false);
      expect(result.anchorEvidenceId).toBe('evi_gas_multi_1');
      expect(result.anchorQuote).toBe("Bog'zor ko'chasida gaz yo'q, o'chib qoldi");
      expect(isUzbekCyrillic(result.summary)).toBe(true);
    });
    it('projects canonical outage summary for continuous grid utility inquiry without literal question titles', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-05',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_gas_inquiry_proj',
        evidence: [
          {
            id: 'evi_gas_inquiry_1',
            topicId: 'top_gas_inquiry_1',
            telegramMessageId: '9712',
            originalTimestamp: '2026-09-05T09:00:00.000Z',
            verbatimText: 'Bugun gaz keladimi?',
            lane: 'GAS',
          },
        ],
      };

      const mockGateway = createMockAiGateway({
        summary: 'Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.',
        lanes: ['GAS'],
        anchor_evidence_id: 'evi_gas_inquiry_1',
        anchor_quote: 'Bugun gaz keladimi?',
        latest_meaningful_activity_timestamp: '2026-09-05T09:00:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });

      const evaluator = new TopicProjectionEvaluator(mockGateway);
      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_gas_inquiry_1',
        primaryLane: 'GAS',
        generation: 1,
        snapshot,
        profileId: 'prof_proj_2026_08_v1',
      });

      expect(result.summary).toBe('Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.');
      expect(result.summary).not.toContain('сўралмоқда');
      expect(result.summary).not.toContain('Бугун газ');
      expect(result.lanes).toEqual(['GAS']);
      expect(result.anchorEvidenceId).toBe('evi_gas_inquiry_1');
      expect(result.anchorQuote).toBe('Bugun gaz keladimi?');
    });

    it('summarizes dialect burst ("uyam qurib yotoradimi", "pulini tulekkan busek") as water outage without construction hallucinations', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Gulbodom',
        calendarDay: '2026-09-06',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_water_dialect_proj',
        evidence: [
          {
            id: 'evi_water_dialect_1',
            topicId: 'top_water_dialect_1',
            telegramMessageId: '30',
            originalTimestamp: '2026-09-06T06:40:25.000Z',
            verbatimText: 'suvchi\nuyam qurib yotoradimi endi\npul tulamasogam mayli tekin disek pulini tulekkan busek.\nxohlagan payti bor xohlasa yu',
            lane: 'WATER',
          },
        ],
      };

      const mockGateway = createMockAiGateway({
        summary: 'Сув таъминотида узилиш ёки беқарорлик хабар қилинмоқда.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_water_dialect_1',
        anchor_quote: 'pulini tulekkan busek. xohlagan payti bor xohlasa yu',
        latest_meaningful_activity_timestamp: '2026-09-06T06:40:25.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });

      const evaluator = new TopicProjectionEvaluator(mockGateway);
      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_water_dialect_1',
        primaryLane: 'WATER',
        generation: 1,
        snapshot,
        profileId: 'prof_proj_2026_08_v1',
      });

      expect(result.summary).toBe('Сув таъминотида узилиш ёки беқарорлик хабар қилинмоқда.');
      expect(result.summary).not.toContain('қурилиш');
      expect(result.summary).not.toContain('уй қуриш');
      expect(result.summary).not.toContain('сантехник');
      expect(result.lanes).toEqual(['WATER']);
      expect(result.anchorEvidenceId).toBe('evi_water_dialect_1');
    });

    it('projects canonical water outage summary and selects "suv kemadiku" as authoritative anchor quote', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Gulbodom',
        calendarDay: '2026-09-07',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_water_kemadiku_proj',
        evidence: [
          {
            id: 'evi_water_kemadiku_1',
            topicId: 'top_water_kemadiku_1',
            telegramMessageId: '9930',
            originalTimestamp: '2026-09-07T08:00:00.000Z',
            verbatimText: 'suv kemadiku',
            lane: 'WATER',
          },
        ],
      };

      const mockGateway = createMockAiGateway({
        summary: 'Сув таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.',
        lanes: ['WATER'],
        anchor_evidence_id: 'evi_water_kemadiku_1',
        anchor_quote: 'suv kemadiku',
        latest_meaningful_activity_timestamp: '2026-09-07T08:00:00.000Z',
        attribution: 'Маҳалла фуқароси',
        is_hokim_related: false,
      });

      const evaluator = new TopicProjectionEvaluator(mockGateway);
      const result = await evaluator.evaluateTopicProjection({
        topicId: 'top_water_kemadiku_1',
        primaryLane: 'WATER',
        generation: 1,
        snapshot,
        profileId: 'prof_proj_2026_08_v1',
      });

      expect(result.summary).toBe('Сув таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.');
      expect(result.lanes).toEqual(['WATER']);
      expect(result.anchorEvidenceId).toBe('evi_water_kemadiku_1');
      expect(result.anchorQuote).toBe('suv kemadiku');
      expect(isUzbekCyrillic(result.summary)).toBe(true);
    });

    it('verifies TOPIC_PROJECTION_SYSTEM_PROMPT contains two-tier architecture (Core Invariants and Empirical Learnings)', () => {
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('PART I: CORE PROJECTION PRINCIPLES & GUARDRAILS');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('PART II: EMPIRICAL TELEGRAM FIELD LEARNINGS & DIALECT TRANSLATION KEYS');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('UZBEK DIALECT HOMONYM & TARIFF/INTERMITTENCY DISAMBIGUATION');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('CONTEXTUAL LATEST UPDATE (latest_update) DIRECTIVE');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('suv kemadiku');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('qurimoq');
      expect(TOPIC_PROJECTION_SYSTEM_PROMPT).toContain('уй қурилиши');
    });

    describe('latest_update Contextual Field Tests', () => {
      it('suppresses latestUpdate to null when topic has only 1 message, even if LLM generated a string', async () => {
        const snapshot: MahallaDailySnapshot = {
          districtId: 'dist_test_1',
          mahallaName: 'Юнусобод',
          calendarDay: '2026-09-11',
          evidence: [
            {
              id: 'evi_single_1',
              topicId: 'top_single_1',
              lane: 'WATER',
              verbatimText: 'Сув ўчди 14-уйда',
              originalTimestamp: '2026-09-11T10:00:00.000Z',
              telegramMessageId: '1001',
            },
          ],
          contextRevision: 1,
          snapshotFingerprint: 'fp_single',
        };

        const mockGateway = createMockAiGateway({
          summary: 'Сув таъминотида узилиш хабар қилинмоқда.',
          latest_update: '14-уйда сув ўчгани айтилмоқда',
          lanes: ['WATER'],
          anchor_evidence_id: 'evi_single_1',
          anchor_quote: 'Сув ўчди 14-уйда',
          latest_meaningful_activity_timestamp: '2026-09-11T10:00:00.000Z',
          attribution: 'Маҳалла фуқароси',
          is_hokim_related: false,
        });

        const evaluator = new TopicProjectionEvaluator(mockGateway);
        const result = await evaluator.evaluateTopicProjection({
          topicId: 'top_single_1',
          primaryLane: 'WATER',
          generation: 1,
          snapshot,
          profileId: 'prof_proj_2026_08_v1',
        });

        expect(result.summary).toBe('Сув таъминотида узилиш хабар қилинмоқда.');
        expect(result.latestUpdate).toBeNull();
      });

      it('preserves valid Uzbek Cyrillic latestUpdate when topic has 2 or more messages', async () => {
        const snapshot: MahallaDailySnapshot = {
          districtId: 'dist_test_1',
          mahallaName: 'Юнусобод',
          calendarDay: '2026-09-11',
          evidence: [
            {
              id: 'evi_multi_1',
              topicId: 'top_multi_1',
              lane: 'ELECTRICITY',
              verbatimText: 'Свет ўчди',
              originalTimestamp: '2026-09-11T10:00:00.000Z',
              telegramMessageId: '1001',
            },
            {
              id: 'evi_multi_2',
              topicId: 'top_multi_1',
              lane: 'ELECTRICITY',
              verbatimText: '14-уй олдида сим ёниб кетди',
              originalTimestamp: '2026-09-11T10:15:00.000Z',
              telegramMessageId: '1002',
            },
          ],
          contextRevision: 2,
          snapshotFingerprint: 'fp_multi',
        };

        const mockGateway = createMockAiGateway({
          summary: 'Электр таъминотида узилиш юз бергани хабар қилинмоқда.',
          latest_update: '14-уй олдида электр сими ёнаётгани маълум қилинди',
          lanes: ['ELECTRICITY'],
          anchor_evidence_id: 'evi_multi_1',
          anchor_quote: 'Свет ўчди',
          latest_meaningful_activity_timestamp: '2026-09-11T10:15:00.000Z',
          attribution: 'Маҳалла аҳолиси',
          is_hokim_related: false,
        });

        const evaluator = new TopicProjectionEvaluator(mockGateway);
        const result = await evaluator.evaluateTopicProjection({
          topicId: 'top_multi_1',
          primaryLane: 'ELECTRICITY',
          generation: 2,
          snapshot,
          profileId: 'prof_proj_2026_08_v1',
        });

        expect(result.summary).toBe('Электр таъминотида узилиш юз бергани хабар қилинмоқда.');
        expect(result.latestUpdate).toBe('14-уй олдида электр сими ёнаётгани маълум қилинди');
        expect(isUzbekCyrillic(result.latestUpdate!)).toBe(true);
      });

      it('rejects latest_update with non-Cyrillic text when evidence count > 1', async () => {
        const snapshot: MahallaDailySnapshot = {
          districtId: 'dist_test_1',
          mahallaName: 'Юнусобод',
          calendarDay: '2026-09-11',
          evidence: [
            {
              id: 'evi_lat_1',
              topicId: 'top_lat_1',
              lane: 'GAS',
              verbatimText: 'Gaz yoq',
              originalTimestamp: '2026-09-11T10:00:00.000Z',
              telegramMessageId: '1001',
            },
            {
              id: 'evi_lat_2',
              topicId: 'top_lat_1',
              lane: 'GAS',
              verbatimText: 'Bizda ham ochdi',
              originalTimestamp: '2026-09-11T10:15:00.000Z',
              telegramMessageId: '1002',
            },
          ],
          contextRevision: 2,
          snapshotFingerprint: 'fp_lat',
        };

        const mockGateway = createMockAiGateway({
          summary: 'Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.',
          latest_update: 'Another resident confirmed gas outage',
          lanes: ['GAS'],
          anchor_evidence_id: 'evi_lat_1',
          anchor_quote: 'Gaz yoq',
          latest_meaningful_activity_timestamp: '2026-09-11T10:15:00.000Z',
          attribution: 'Маҳалла аҳолиси',
          is_hokim_related: false,
        });

        const evaluator = new TopicProjectionEvaluator(mockGateway);
        await expect(
          evaluator.evaluateTopicProjection({
            topicId: 'top_lat_1',
            primaryLane: 'GAS',
            generation: 2,
            snapshot,
            profileId: 'prof_proj_2026_08_v1',
          }),
        ).rejects.toThrow('Latest update must contain authentic Uzbek Cyrillic characters');
      });
    });
  });
});
