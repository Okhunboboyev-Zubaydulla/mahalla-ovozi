import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SemanticRelevanceEvaluator,
  SemanticRelevanceResultSchema,
  SEMANTIC_RELEVANCE_SYSTEM_PROMPT,
  type SemanticRelevanceResult,
} from '../src/modules/ai/semantic-relevance-evaluator.js';
import {
  computeSnapshotFingerprint,
  type AcceptedEvidenceItem,
  type MahallaDailySnapshot,
} from '../src/modules/ai/context-snapshot.js';
import { MockProviderAdapter } from '../src/adapters/ai-providers/mock-provider-adapter.js';
import { AiGateway } from '../src/modules/ai/ai-gateway.js';
import type { AiProfile } from '../src/adapters/db/schema/ai.js';

describe('Semantic Relevance Domain Evaluator & Contracts Unit Tests', () => {
  describe('SemanticRelevanceResultSchema Invariants', () => {
    it('accepts valid relevant result with lanes and null exclusion reason', () => {
      const validRelevant: SemanticRelevanceResult = {
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        accepted_message_ids: ['101'],
        reasoning: 'Tap water outage reported',
      };

      const result = SemanticRelevanceResultSchema.safeParse(validRelevant);
      expect(result.success).toBe(true);
    });

    it('accepts valid relevant result with multi-lane overlap (WATER + HOKIM_RELATED)', () => {
      const validOverlap: SemanticRelevanceResult = {
        is_relevant: true,
        relevant_lanes: ['WATER', 'HOKIM_RELATED'],
        exclusion_reason: null,
        accepted_message_ids: ['102'],
        reasoning: 'Direct Hokim appeal regarding water pipe repair',
      };

      const result = SemanticRelevanceResultSchema.safeParse(validOverlap);
      expect(result.success).toBe(true);
    });

    it('accepts valid irrelevant result with empty lanes and non-null exclusion reason', () => {
      const validIrrelevant: SemanticRelevanceResult = {
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'PLANNED_ANNOUNCEMENT',
        accepted_message_ids: [],
        reasoning: 'Official electricity maintenance announcement',
      };

      const result = SemanticRelevanceResultSchema.safeParse(validIrrelevant);
      expect(result.success).toBe(true);
    });

    // L3-P05-02: ai-gateway.ts used to repair these contradictions BEFORE safeParse, which
    // made the refine below unreachable in production. The schema now owns the repair, so
    // it is observable from here.
    it('coerces exclusion_reason to null when is_relevant is true', () => {
      const result = SemanticRelevanceResultSchema.safeParse({
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: 'GENERAL_CHATTER',
        reasoning: 'Model volunteered a reason despite marking it relevant',
      });

      expect(result.success).toBe(true);
      expect(result.success && result.data.exclusion_reason).toBeNull();
    });

    it('coerces relevant_lanes to an empty array when is_relevant is false', () => {
      const result = SemanticRelevanceResultSchema.safeParse({
        is_relevant: false,
        relevant_lanes: ['ELECTRICITY'],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Excluded message with leftover lanes',
      });

      expect(result.success).toBe(true);
      expect(result.success && result.data.relevant_lanes).toEqual([]);
    });

    it('truncates reasoning longer than 300 characters', () => {
      const result = SemanticRelevanceResultSchema.safeParse({
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        reasoning: 'x'.repeat(450),
      });

      expect(result.success).toBe(true);
      expect(result.success && result.data.reasoning).toHaveLength(300);
    });

    // Guards against over-coercion: repair must not manufacture a satisfiable payload.
    it('still rejects is_relevant: true when relevant_lanes is empty', () => {
      const result = SemanticRelevanceResultSchema.safeParse({
        is_relevant: true,
        relevant_lanes: [],
        exclusion_reason: null,
        reasoning: 'Relevant but no lane named',
      });

      expect(result.success).toBe(false);
    });

    it('still rejects is_relevant: false when exclusion_reason is null', () => {
      const result = SemanticRelevanceResultSchema.safeParse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: null,
        reasoning: 'Excluded without stating why',
      });

      expect(result.success).toBe(false);
    });

    it('coerces relevant_lanes to an empty array when is_relevant is false', () => {
      const coerced = {
        is_relevant: false,
        relevant_lanes: ['ELECTRICITY'],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Contradictory output',
      };

      const result = SemanticRelevanceResultSchema.safeParse(coerced);
      expect(result.success).toBe(true);
      expect(result.success && result.data.relevant_lanes).toEqual([]);
      expect(result.success && result.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');
    });
  });

  describe('Deterministic Snapshot Fingerprinting', () => {
    it('produces sha256_empty_v1 for empty evidence', () => {
      const fingerprint = computeSnapshotFingerprint([]);
      expect(fingerprint).toBe('sha256_empty_v1');
    });

    it('produces stable sha256 hash for identical evidence items', () => {
      const evidence: AcceptedEvidenceItem[] = [
        {
          id: 'ev_1',
          telegramMessageId: '101',
          originalTimestamp: '2026-08-22T08:00:00.000Z',
          verbatimText: "Svet o'chdi",
        },
      ];

      const hash1 = computeSnapshotFingerprint(evidence);
      const hash2 = computeSnapshotFingerprint(evidence);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('Prompt Assembly & Reply Forward Isolation', () => {
    let evaluator: SemanticRelevanceEvaluator;
    let mockAdapter: MockProviderAdapter;

    beforeEach(() => {
      mockAdapter = new MockProviderAdapter({
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        reasoning: 'Valid water complaint',
      });

      const customAdapters = new Map<string, any>();
      customAdapters.set('MOCK', mockAdapter);

      const defaultProfiles = new Map<string, AiProfile>();
      defaultProfiles.set('prof_rel_2026_08_v1', {
        id: 'prof_rel_2026_08_v1',
        version: 1,
        operationType: 'SEMANTIC_RELEVANCE',
        provider: 'MOCK',
        modelId: 'mock-v1',
        promptVersion: 'prom_v1',
        schemaVersion: 'sch_v1',
        temperature: 0.0,
        maxOutputTokens: 500,
        timeoutMs: 5000,
        retryPolicy: { maxAttempts: 1, backoffFactor: 1, initialDelayMs: 0 },
        capabilities: { structuredOutputs: true },
        isActive: true,
        createdAt: new Date(),
      });

      const gateway = new AiGateway({ customAdapters, defaultProfiles });
      evaluator = new SemanticRelevanceEvaluator(gateway);
    });

    it('builds user prompt with candidate message verbatim', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        evidence: [],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: "12-uyda suv to'xtab qoldi",
        telegramMessageId: '54321',
        originalTimestamp: '2026-08-22T08:30:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
      });

      expect(prompt).toContain('12-uyda suv to\'xtab qoldi');
      expect(prompt).toContain('54321');
      expect(prompt).toContain('(No accepted evidence recorded yet today for this Mahalla)');
    });

    it('isolates reply to forwarded parent by omitting parent text and adding isolation rule (AC 6)', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        evidence: [],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: 'Shuni qachon tozalaysizlar?',
        telegramMessageId: '54322',
        originalTimestamp: '2026-08-22T08:31:00.000Z',
        contentType: 'TEXT',
        replyMetadata: {
          replyToMessageId: '1001',
          replyToIsForwarded: true,
          replyToIsBot: false,
        },
        snapshot,
      });

      expect(prompt).toContain('This message is a reply to a Telegram-forwarded parent message.');
      expect(prompt).toContain('Isolation Rule: The parent message is excluded and not provided.');
    });

    it('formats multiple chronological evidence items in context (AC 5)', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navbahor',
        calendarDay: '2026-08-22',
        contextRevision: 2,
        snapshotFingerprint: 'mock_hash',
        evidence: [
          {
            id: 'ev_1',
            telegramMessageId: '101',
            originalTimestamp: '2026-08-22T08:00:00.000Z',
            verbatimText: "Svet o'chdi 14-domda",
            lane: 'ELECTRICITY',
          },
          {
            id: 'ev_2',
            telegramMessageId: '102',
            originalTimestamp: '2026-08-22T08:15:00.000Z',
            verbatimText: 'Bizda ham chiroq yoq',
            lane: 'ELECTRICITY',
          },
        ],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: 'Bizdayam ochdi',
        telegramMessageId: '103',
        originalTimestamp: '2026-08-22T08:20:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        vocabularyGuidance: ['elektr', 'chiroq', 'svet'],
      });

      expect(prompt).toContain('[#1] Timestamp: 2026-08-22T08:00:00.000Z | MsgID: 101 | Lane: [ELECTRICITY] | Text: "Svet o\'chdi 14-domda"');
      expect(prompt).toContain('[#2] Timestamp: 2026-08-22T08:15:00.000Z (+15m from previous) | MsgID: 102 | Lane: [ELECTRICITY] | Text: "Bizda ham chiroq yoq"');
      expect(prompt).toContain('[elektr, chiroq, svet]');
    });

    it('evaluates candidate successfully through AI Gateway', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Guliston',
        calendarDay: '2026-08-22',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        evidence: [],
      };

      const result = await evaluator.evaluateRelevance({
        candidateText: "12-uyda suv to'xtab qoldi",
        telegramMessageId: '54321',
        originalTimestamp: '2026-08-22T08:30:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(result.data.is_relevant).toBe(true);
      expect(result.data.relevant_lanes).toEqual(['WATER']);
      expect(result.data.exclusion_reason).toBeNull();
    });

    it('builds prompt containing Uzbek contracted suffix message', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Guliston',
        calendarDay: '2026-09-01',
        contextRevision: 2,
        snapshotFingerprint: 'mock_hash',
        evidence: [
          {
            id: 'ev_1',
            telegramMessageId: '101',
            originalTimestamp: '2026-09-01T13:43:00.000Z',
            verbatimText: 'salom mahalladoshlar! svet hammada ucdimi yoki bizdami faqat?',
            lane: 'ELECTRICITY',
          },
          {
            id: 'ev_2',
            telegramMessageId: '102',
            originalTimestamp: '2026-09-01T13:44:00.000Z',
            verbatimText: 'Cherez den uciroriw odat bub qoldi ln.',
            lane: 'ELECTRICITY',
          },
        ],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: 'Suvam ucdi mana. Xalq cidoradi',
        telegramMessageId: '103',
        originalTimestamp: '2026-09-01T14:36:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
      });

      expect(prompt).toContain('Suvam ucdi mana. Xalq cidoradi');
      expect(prompt).toContain('103');
      expect(prompt).toContain('[#2] Timestamp: 2026-09-01T13:44:00.000Z (+1m from previous) | MsgID: 102 | Lane: [ELECTRICITY]');
    });

    it('injects explicit Immediate Preceding Message (N-1) block for subjectless follow-up', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Guliston',
        calendarDay: '2026-09-01',
        contextRevision: 2,
        snapshotFingerprint: 'mock_hash_seq',
        evidence: [
          {
            id: 'ev_1',
            telegramMessageId: '101',
            originalTimestamp: '2026-09-01T15:50:00.000Z',
            verbatimText: 'salom mahalladoshlar! gaz hammada ucdimi yoki bizdami faqat?',
            lane: 'GAS',
          },
          {
            id: 'ev_2',
            telegramMessageId: '102',
            originalTimestamp: '2026-09-01T15:50:30.000Z',
            verbatimText: 'kamiga svetam yu',
            lane: 'ELECTRICITY',
          },
        ],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: 'Cherez den uciroriw odat bub qoldi ln. Remon diyiladi.',
        telegramMessageId: '103',
        originalTimestamp: '2026-09-01T15:51:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
      });

      expect(prompt).toContain('### IMMEDIATE PRECEDING MESSAGE (N-1 IN CHAT)');
      expect(prompt).toContain('Message ID: 102 (+1m before candidate) (Lane: [ELECTRICITY])');
      expect(prompt).toContain('Text: "kamiga svetam yu"');
    });

    it('ensures system prompt defines the public municipal vs private peer-to-peer boundary', () => {
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('CRITICAL BOUNDARY: PUBLIC MUNICIPAL SERVICE VS. PRIVATE PEER-TO-PEER TRANSACTIONS');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('bakalashka');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('muravey');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('santexnik');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('musor mashinasi kelmadi');
    });

    it('evaluates private transactions (Shahob & Dildora cases) as excluded ADVERTISEMENT_OR_SPAM', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: "Navro'z",
        calendarDay: '2026-09-03',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_navroz_v1',
        evidence: [],
      };

      // 1. Shahob case: private bottle recycling inquiry
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Private inquiry asking for contact numbers of scrap plastic bottle buyers',
      });

      const shahobResult = await evaluator.evaluateRelevance({
        candidateText: 'Bakalashka olekkanlani nomerini aytvorila',
        telegramMessageId: '9001',
        originalTimestamp: '2026-09-03T13:58:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(shahobResult.data.is_relevant).toBe(false);
      expect(shahobResult.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');
      expect(shahobResult.data.relevant_lanes).toEqual([]);

      // 2. Dildora case: private vehicle hire for renovation rubble
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Inquiry seeking to hire a private motorized tricycle for home renovation debris removal',
      });

      const dildoraResult = await evaluator.evaluateRelevance({
        candidateText: 'Ассалому алайкум ремонтдан кейинги чикиндини олиб кетишга муравейча борми',
        telegramMessageId: '9002',
        originalTimestamp: '2026-09-03T14:00:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(dildoraResult.data.is_relevant).toBe(false);
      expect(dildoraResult.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');
      expect(dildoraResult.data.relevant_lanes).toEqual([]);

      // 3. Municipal Waste True Positive: Scheduled collection truck missed
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WASTE'],
        exclusion_reason: null,
        reasoning: 'Report of scheduled municipal waste truck failing to service residential street',
      });

      const truckResult = await evaluator.evaluateRelevance({
        candidateText: 'МУСОР. МАШИНАСИ. КЕЛМАДИ. ОЛДИНГИ. ХАФТАДА. ПАЛЬИКЛИНИКАНИ. ОРКА. КУЧАСИГА КЕЛСИН.',
        telegramMessageId: '9003',
        originalTimestamp: '2026-09-03T14:05:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(truckResult.data.is_relevant).toBe(true);
      expect(truckResult.data.relevant_lanes).toEqual(['WASTE']);
      expect(truckResult.data.exclusion_reason).toBeNull();
    });

    it('verifies 5-lane paired boundaries: Private Domestic Transactions vs Public Municipal Failures', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Istiqlol',
        calendarDay: '2026-09-03',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_istiqlol_v1',
        evidence: [],
      };

      // 1. WATER: Private plumber inquiry (Exclude) vs Public main pipe burst (Include)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Private household request for a plumber to fix indoor leaky tap',
      });
      const waterPrivate = await evaluator.evaluateRelevance({
        candidateText: 'Santexnik bormi kran oqib ketdi uyda',
        telegramMessageId: '9101',
        originalTimestamp: '2026-09-03T10:00:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(waterPrivate.data.is_relevant).toBe(false);
      expect(waterPrivate.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');

      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        reasoning: 'Public main drinking water pipe rupture on residential street',
      });
      const waterPublic = await evaluator.evaluateRelevance({
        candidateText: "Ko'chada markaziy vodoprovod trubasi yorilib ketdi, suv toshib yotibdi",
        telegramMessageId: '9102',
        originalTimestamp: '2026-09-03T10:05:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(waterPublic.data.is_relevant).toBe(true);
      expect(waterPublic.data.relevant_lanes).toEqual(['WATER']);

      // 2. ELECTRICITY: Private electrician inquiry (Exclude) vs Public transformer outage (Include)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Private request for an electrician to install household light fixture and socket',
      });
      const elecPrivate = await evaluator.evaluateRelevance({
        candidateText: "Uyga yangi lyustra va rozetka o'rnatadigan elektrik kerak",
        telegramMessageId: '9103',
        originalTimestamp: '2026-09-03T10:10:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(elecPrivate.data.is_relevant).toBe(false);
      expect(elecPrivate.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');

      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['ELECTRICITY'],
        exclusion_reason: null,
        reasoning: 'Public neighborhood transformer sparked causing neighborhood power cut',
      });
      const elecPublic = await evaluator.evaluateRelevance({
        candidateText: "Ko'chamizdagi transformator tutab ketdi, butun mahalla qorong'uda qoldi",
        telegramMessageId: '9104',
        originalTimestamp: '2026-09-03T10:15:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(elecPublic.data.is_relevant).toBe(true);
      expect(elecPublic.data.relevant_lanes).toEqual(['ELECTRICITY']);

      // 3. GAS: Private stove repair (Exclude) vs Public low pressure crisis (Include)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Private appliance repair inquiry for a household gas stove',
      });
      const gasPrivate = await evaluator.evaluateRelevance({
        candidateText: 'Gaz plitamni gorelkalari yaxshi yonmayapti, usta bormi?',
        telegramMessageId: '9105',
        originalTimestamp: '2026-09-03T10:20:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(gasPrivate.data.is_relevant).toBe(false);
      expect(gasPrivate.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');

      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['GAS'],
        exclusion_reason: null,
        reasoning: 'Public municipal gas supply pressure collapse in winter',
      });
      const gasPublic = await evaluator.evaluateRelevance({
        candidateText: "Gaz bosimi judayam past, kotyollar o'chib qolyapti sovuqda",
        telegramMessageId: '9106',
        originalTimestamp: '2026-09-03T10:25:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(gasPublic.data.is_relevant).toBe(true);
      expect(gasPublic.data.relevant_lanes).toEqual(['GAS']);

      // 4. HOKIM_RELATED: Private mason hire (Exclude) vs Public road potholes / streetlights (Include)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Private request to hire laborers for personal house construction',
      });
      const hokimPrivate = await evaluator.evaluateRelevance({
        candidateText: "Xususiy hovlimga g'isht teradigan mardikor yoki usta kerak",
        telegramMessageId: '9107',
        originalTimestamp: '2026-09-03T10:30:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(hokimPrivate.data.is_relevant).toBe(false);
      expect(hokimPrivate.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');

      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['HOKIM_RELATED'],
        exclusion_reason: null,
        reasoning: 'Public street infrastructure defect addressed directly to Hokim',
      });
      const hokimPublic = await evaluator.evaluateRelevance({
        candidateText: "Ko'chamizdagi chuqurlardan mashinalar o'tolmayapti, tuman hokimi qachon asfalt qilib beradi?",
        telegramMessageId: '9108',
        originalTimestamp: '2026-09-03T10:35:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(hokimPublic.data.is_relevant).toBe(true);
      expect(hokimPublic.data.relevant_lanes).toEqual(['HOKIM_RELATED']);
    });

    it('ensures system prompt defines official municipal entities vs informal scavengers across all 5 lanes', () => {
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('CRITICAL BOUNDARY: PUBLIC MUNICIPAL SERVICE VS. PRIVATE PEER-TO-PEER TRANSACTIONS');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('musr yigib yuredigan lulilar');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Toza Hudud, Maxsustrans, musor mashinasi');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain("lo'lilar, aravakashlar, xashakchilar");
    });

    it('ensures system prompt defines HOKIM_RELATED strictly for problem-toned appeals to the Hokim or Hokimiyat', () => {
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('HOKIM_RELATED (Ҳокимга оид): STRICTLY AND ONLY civic complaints');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('explicitly addressed to or concerning the District Hokim or Hokimiyat');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('If a message does NOT explicitly appeal to, criticize, or demand action from the Hokim or Hokimiyat, it MUST NEVER be assigned to HOKIM_RELATED');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('MANDATORY KEYWORD / APPARATUS PREREQUISITE');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('"xokim", "hakim", "xakim", "hokimyat", "xokimyat", "hokimat", "xokimat", "hokim buva", "hokimbobo", "hokimimiz"');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('"zamhokim", "hokim yordamchisi"');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('"mahalla raisi" or "oqsoqol" do NOT qualify unless "hokim" or "hokimiyat" is explicitly named');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('CONTEXTUAL FOLLOW-UP INHERITANCE');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('ROAD & GENERAL INFRASTRUCTURE EXCLUSION');
    });

    it('ensures system prompt defines communicative predicate over sentence mood and signal dominance', () => {
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Communicative Predicate over Sentence Mood');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Grammatical sentence form (declarative, interrogative, rhetorical, exclamatory) is non-binding');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Signal Dominance over Conversational Padding');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Colloquial Phonetics & Dialect Normalization');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('ARCHITECTURAL DICHOTOMY: 24/7 CONTINUOUS GRID UTILITIES VS. PERIODIC ROUTE SERVICES');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('nme svet yu hammada shundemi');
    });

    it('evaluates interrogative failure reports, conversational padding, and speculative inquiries per approved matrix', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_navbahor_interrogative',
        evidence: [],
      };

      // 1. Greeting + Interrogative Active Blackout Assertion (Navbahor user case)
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['ELECTRICITY'],
        exclusion_reason: null,
        reasoning: 'Active power outage asserted in colloquial interrogative form with group greeting',
      });
      const blackoutCheck = await evaluator.evaluateRelevance({
        candidateText: 'salom gruppadagila\nhamma yaxshimi\nnme svet yu hammada shundemi',
        telegramMessageId: '9301',
        originalTimestamp: '2026-09-04T11:59:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(blackoutCheck.data.is_relevant).toBe(true);
      expect(blackoutCheck.data.relevant_lanes).toEqual(['ELECTRICITY']);

      // 2. Rhetorical Stoppage Inquiry
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        reasoning: 'Rhetorical question asserting active water supply stoppage',
      });
      const waterStoppage = await evaluator.evaluateRelevance({
        candidateText: "Nega suv to'xtab qoldi yana, kechagacha bermaydimi endi?",
        telegramMessageId: '9302',
        originalTimestamp: '2026-09-04T12:05:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(waterStoppage.data.is_relevant).toBe(true);
      expect(waterStoppage.data.relevant_lanes).toEqual(['WATER']);

      // 3. Missed Municipal Garbage Truck Inquiry
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WASTE'],
        exclusion_reason: null,
        reasoning: 'Inquiry asserting scheduled municipal garbage truck missed collection',
      });
      const wasteInquiry = await evaluator.evaluateRelevance({
        candidateText: 'Musor mashinasi bugun nega kelmadi?',
        telegramMessageId: '9303',
        originalTimestamp: '2026-09-04T12:10:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(wasteInquiry.data.is_relevant).toBe(true);
      expect(wasteInquiry.data.relevant_lanes).toEqual(['WASTE']);

      // 4. Speculative Future Inquiry (No active disruption)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'SPECULATION_OR_RUMOR',
        reasoning: 'Speculative inquiry about future gas cut without asserting an active failure',
      });
      const futureSpeculation = await evaluator.evaluateRelevance({
        candidateText: "Bugun gaz o'chmaydimi?",
        telegramMessageId: '9304',
        originalTimestamp: '2026-09-04T12:15:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(futureSpeculation.data.is_relevant).toBe(false);
      expect(futureSpeculation.data.exclusion_reason).toBe('SPECULATION_OR_RUMOR');

      // 5. Contextless Conversational Inquiry
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'GENERAL_CHATTER',
        reasoning: 'Conversational check-in without civic disruption facts',
      });
      const generalChat = await evaluator.evaluateRelevance({
        candidateText: 'Hammada tinchlikmi, kimdir biladimi?',
        telegramMessageId: '9305',
        originalTimestamp: '2026-09-04T12:20:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(generalChat.data.is_relevant).toBe(false);
      expect(generalChat.data.exclusion_reason).toBe('GENERAL_CHATTER');

      // 6. Ultra-short Reaction Fragment on Empty Board
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'UNRESOLVED_AMBIGUOUS_FRAGMENT',
        reasoning: 'Ultra-short reaction fragment without civic facts on empty board',
      });
      const bareCheck = await evaluator.evaluateRelevance({
        candidateText: 'ha shu ahvol',
        telegramMessageId: '9306',
        originalTimestamp: '2026-09-04T12:25:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });
      expect(bareCheck.data.is_relevant).toBe(false);
      expect(bareCheck.data.exclusion_reason).toBe('UNRESOLVED_AMBIGUOUS_FRAGMENT');
    });

    it('distinguishes informal scavengers/pickers (Navbahor lulilar case) from official municipal waste services', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-03',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_navbahor_luli',
        evidence: [],
      };

      // 1. Informal scrap picker inquiry (Navbahor case): "musr yigib yuredigan lulilar kemeptimi mahallaga" -> FALSE (ADVERTISEMENT_OR_SPAM)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
        reasoning: 'Inquiry regarding roaming informal scrap/junk gatherers (lo\'lilar), not official municipal waste collection services',
      });

      const luliInquiry = await evaluator.evaluateRelevance({
        candidateText: 'musr yigib yuredigan lulilar kemeptimi mahallaga',
        telegramMessageId: '9201',
        originalTimestamp: '2026-09-03T20:07:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(luliInquiry.data.is_relevant).toBe(false);
      expect(luliInquiry.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');
      expect(luliInquiry.data.relevant_lanes).toEqual([]);

      // 2. Dependent burst fragment: "kimdir biladimi" -> FALSE (UNRESOLVED_AMBIGUOUS_FRAGMENT)
      mockAdapter.setNextResponse({
        is_relevant: false,
        relevant_lanes: [],
        exclusion_reason: 'UNRESOLVED_AMBIGUOUS_FRAGMENT',
        reasoning: 'Ambiguous conversational fragment without utility context',
      });

      const burstFragment = await evaluator.evaluateRelevance({
        candidateText: 'kimdir biladimi',
        telegramMessageId: '9202',
        originalTimestamp: '2026-09-03T20:07:05.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(burstFragment.data.is_relevant).toBe(false);
      expect(burstFragment.data.exclusion_reason).toBe('UNRESOLVED_AMBIGUOUS_FRAGMENT');

      // 3. Exception: Scavengers scatter trash across public street creating sanitation hazard -> TRUE (WASTE)
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WASTE'],
        exclusion_reason: null,
        reasoning: 'Public sanitation hazard created by trash scattered across public street from containers',
      });

      const litterHazard = await evaluator.evaluateRelevance({
        candidateText: "lo'lilar musorxonani titib hamma yoqni ko'chaga sochib ketdi",
        telegramMessageId: '9203',
        originalTimestamp: '2026-09-03T20:10:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(litterHazard.data.is_relevant).toBe(true);
      expect(litterHazard.data.relevant_lanes).toEqual(['WASTE']);
      expect(litterHazard.data.exclusion_reason).toBeNull();
    });

    it('ensures system prompt defines spatial orientir and landmark disambiguation rules', () => {
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('SPATIAL ORIENTIRS & LANDMARK DISAMBIGUATION');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Elektrosvetni orqa tarafi');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Vodokanal ro\'parasida');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Raygaz orqasidagi ko\'cha');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('IT REPRESENTS A PHYSICAL LANDMARK / ADDRESS');
    });

    it('disambiguates utility landmarks: treats "Elektrosvetni orqa tarafi" as location and binds to WASTE thread (Navro\'z case)', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navro\'z',
        calendarDay: '2026-09-04',
        contextRevision: 2,
        snapshotFingerprint: 'sha256_navroz_musor_thread',
        evidence: [
          {
            id: 'evi_navroz_1',
            topicId: 'top_navroz_waste',
            telegramMessageId: '7081',
            originalTimestamp: '2026-09-04T07:08:00.000Z',
            verbatimText: 'Musrlar yigilb kitti',
            lane: 'WASTE',
          },
          {
            id: 'evi_navroz_2',
            topicId: 'top_navroz_waste',
            telegramMessageId: '7082',
            originalTimestamp: '2026-09-04T07:08:30.000Z',
            verbatimText: 'Bizani kucaga kirmaganiga anca buldi Laziz aka',
            lane: 'WASTE',
          },
        ],
      };

      // Candidate message using "Elektrosvetni orqa tarafi" as address/orientir in a garbage truck thread
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WASTE'],
        exclusion_reason: null,
        reasoning: 'Complaint regarding missed municipal waste collection truck route for the neighborhood behind the electric utility building',
      });

      const result = await evaluator.evaluateRelevance({
        candidateText: 'Elektrosvetni orqa tarafi borku garaj tarafga ....kemaganiga anca buldi...',
        telegramMessageId: '7091',
        originalTimestamp: '2026-09-04T07:09:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(result.data.is_relevant).toBe(true);
      expect(result.data.relevant_lanes).toEqual(['WASTE']);
      expect(result.data.relevant_lanes).not.toContain('ELECTRICITY');
      expect(result.data.exclusion_reason).toBeNull();
    });

    it('correctly maps cross-utility orientirs to the actual failing utility lane', async () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_1',
        mahallaName: 'Navro\'z',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_cross_orientir',
        evidence: [],
      };

      // 1. "Vodokanal ro'parasida svet o'chdi" -> ELECTRICITY (Vodokanal is landmark, svet is outage)
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['ELECTRICITY'],
        exclusion_reason: null,
        reasoning: 'Power cut reported with Vodokanal building used as geographic landmark',
      });

      const vodokanalSvet = await evaluator.evaluateRelevance({
        candidateText: "Vodokanal ro'parasida svet o'chdi",
        telegramMessageId: '7101',
        originalTimestamp: '2026-09-04T07:15:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(vodokanalSvet.data.is_relevant).toBe(true);
      expect(vodokanalSvet.data.relevant_lanes).toEqual(['ELECTRICITY']);
      expect(vodokanalSvet.data.relevant_lanes).not.toContain('WATER');

      // 2. "Raygaz orqasidagi ko'chada truba yorilib suv oqyapti" -> WATER (Raygaz is landmark, water pipe is outage)
      mockAdapter.setNextResponse({
        is_relevant: true,
        relevant_lanes: ['WATER'],
        exclusion_reason: null,
        reasoning: 'Water pipe burst reported with Raygaz office used as geographic landmark',
      });

      const raygazSuv = await evaluator.evaluateRelevance({
        candidateText: "Raygaz orqasidagi ko'chada truba yorilib suv oqyapti",
        telegramMessageId: '7102',
        originalTimestamp: '2026-09-04T07:16:00.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot,
        profileId: 'prof_rel_2026_08_v1',
      });

      expect(raygazSuv.data.is_relevant).toBe(true);
      expect(raygazSuv.data.relevant_lanes).toEqual(['WATER']);
      expect(raygazSuv.data.relevant_lanes).not.toContain('GAS');
    });

    it('ensures system prompt defines Section 7: BURST SEQUENCES & CITIZEN MULTI-MESSAGE SCRUTINY', () => {
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('### 7. BURST SEQUENCES & CITIZEN MULTI-MESSAGE SCRUTINY');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Do NOT assume all messages belong to the same thought');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('accepted_message_ids');
      expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Katyol bor');
    });

    it('formats multi-message burst in buildUserPrompt with message enumeration and scrutiny guidance', () => {
      const emptySnapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navro\'z',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'fp_test',
        evidence: [],
      };

      const prompt = evaluator.buildUserPrompt({
        candidateText: 'Bogi baland kucamz 3 hafta kimadi...\nElektrosvetni yon tarafidegi kuca\nKatyol bor',
        telegramMessageId: '66065',
        originalTimestamp: '2026-09-04T10:20:06.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot: emptySnapshot,
        burstMessages: [
          {
            intakeId: 'intake_1',
            telegramMessageId: '66065',
            originalTimestamp: '2026-09-04T10:20:06.000Z',
            verbatimText: 'Bogi baland kucamz 3 hafta kimadi...',
            contentType: 'TEXT',
            replyMetadata: null,
          },
          {
            intakeId: 'intake_2',
            telegramMessageId: '66066',
            originalTimestamp: '2026-09-04T10:20:19.000Z',
            verbatimText: 'Elektrosvetni yon tarafidegi kuca',
            contentType: 'TEXT',
            replyMetadata: null,
          },
          {
            intakeId: 'intake_3',
            telegramMessageId: '66067',
            originalTimestamp: '2026-09-04T10:20:26.000Z',
            verbatimText: 'Katyol bor',
            contentType: 'TEXT',
            replyMetadata: null,
          },
        ],
      });

      expect(prompt).toContain('### CANDIDATE MESSAGE BURST (3 CONSECUTIVE MESSAGES FROM SAME SENDER)');
      expect(prompt).toContain('Message #1 (ID: 66065');
      expect(prompt).toContain('Message #2 (ID: 66066');
      expect(prompt).toContain('Message #3 (ID: 66067');
      expect(prompt).toContain('CRITICAL: Scrutinize each message individually. In "accepted_message_ids", list ONLY the message IDs');
    });

    it('scrutinizes burst messages and separates genuine waste failure and address from unrelated chatter (Navro\'z case)', async () => {
      const mockGateway: any = {
        generateStructured: vi.fn().mockResolvedValue({
          data: {
            is_relevant: true,
            relevant_lanes: ['WASTE'],
            exclusion_reason: null,
            accepted_message_ids: ['66065', '66066'],
            reasoning: 'Municipal waste failure reported on Bogi baland street; Katyol and Gaz girpi excluded as unrelated chatter',
          },
          profileId: 'prof_rel_2026_08_v1',
          provider: 'OLLAMA',
          modelId: 'gemma4:12b',
          providerRequestId: 'mock_req',
          durationMs: 40,
          tokens: { inputTokens: 20, outputTokens: 10, cachedTokens: 0 },
          estimatedCostUsd: '0.0001',
          attempts: [],
        }),
      };
      const customEvaluator = new SemanticRelevanceEvaluator(mockGateway);

      const emptySnapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navro\'z',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'fp_test_navroz',
        evidence: [],
      };

      const result = await customEvaluator.evaluateRelevance({
        candidateText: 'Bogi baland kucamz 3 hafta kimadi...\nElektrosvetni yon tarafidegi kuca\nKatyol bor\nGaz girpi bor',
        telegramMessageId: '66065',
        originalTimestamp: '2026-09-04T10:20:06.000Z',
        contentType: 'TEXT',
        replyMetadata: null,
        snapshot: emptySnapshot,
        burstMessages: [
          {
            intakeId: 'intake_65',
            telegramMessageId: '66065',
            originalTimestamp: '2026-09-04T10:20:06.000Z',
            verbatimText: 'Bogi baland kucamz 3 hafta kimadi...',
            contentType: 'TEXT',
            replyMetadata: null,
          },
          {
            intakeId: 'intake_66',
            telegramMessageId: '66066',
            originalTimestamp: '2026-09-04T10:20:19.000Z',
            verbatimText: 'Elektrosvetni yon tarafidegi kuca',
            contentType: 'TEXT',
            replyMetadata: null,
          },
          {
            intakeId: 'intake_67',
            telegramMessageId: '66067',
            originalTimestamp: '2026-09-04T10:20:26.000Z',
            verbatimText: 'Katyol bor',
            contentType: 'TEXT',
            replyMetadata: null,
          },
          {
            intakeId: 'intake_68',
            telegramMessageId: '66068',
            originalTimestamp: '2026-09-04T10:20:32.000Z',
            verbatimText: 'Gaz girpi bor',
            contentType: 'TEXT',
            replyMetadata: null,
          },
        ],
      });

      expect(result.data.is_relevant).toBe(true);
      expect(result.data.relevant_lanes).toEqual(['WASTE']);
      expect(result.data.accepted_message_ids).toEqual(['66065', '66066']);
      expect(result.data.accepted_message_ids).not.toContain('66067');
      expect(result.data.accepted_message_ids).not.toContain('66068');
    });

    describe('Strict Contextual Hokim/Hokimiyat Lane Qualification & Exclusion Rules', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-04',
        contextRevision: 1,
        snapshotFingerprint: 'sha256_hokim_strict_qualification',
        evidence: [],
      };

      it('qualifies colloquial, slang, and misspelled Hokim variants under HOKIM_RELATED', async () => {
        // 1. "xokim buva"
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['HOKIM_RELATED'],
          exclusion_reason: null,
          accepted_message_ids: ['9501'],
          reasoning: 'Grievance addressed colloquially to Hokim (xokim buva)',
        });
        const slang1 = await evaluator.evaluateRelevance({
          candidateText: "Xokim buva ko'chamizdagi loyga qachon qaraysiz?",
          telegramMessageId: '9501',
          originalTimestamp: '2026-09-04T12:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(slang1.data.is_relevant).toBe(true);
        expect(slang1.data.relevant_lanes).toEqual(['HOKIM_RELATED']);

        // 2. "hokimyatga" (phonetic typo)
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['HOKIM_RELATED'],
          exclusion_reason: null,
          accepted_message_ids: ['9502'],
          reasoning: 'Appeal addressed to Hokimiyat with phonetic typo',
        });
        const slang2 = await evaluator.evaluateRelevance({
          candidateText: "Hokimyatga necha marta murojaat qildik, hech kim quloq solmayapti",
          telegramMessageId: '9502',
          originalTimestamp: '2026-09-04T12:01:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(slang2.data.is_relevant).toBe(true);
        expect(slang2.data.relevant_lanes).toEqual(['HOKIM_RELATED']);

        // 3. "zamhokim" (direct apparatus title)
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['HOKIM_RELATED'],
          exclusion_reason: null,
          accepted_message_ids: ['9503'],
          reasoning: 'Complaint concerning Hokimiyat apparatus official (zamhokim)',
        });
        const slang3 = await evaluator.evaluateRelevance({
          candidateText: "Zamhokim kelib va'da berib ketuvdi, amalda hech narsa qilinmadi",
          telegramMessageId: '9503',
          originalTimestamp: '2026-09-04T12:02:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(slang3.data.is_relevant).toBe(true);
        expect(slang3.data.relevant_lanes).toEqual(['HOKIM_RELATED']);

        // 4. "hokim yordamchisi" (direct apparatus title)
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['HOKIM_RELATED'],
          exclusion_reason: null,
          accepted_message_ids: ['9504'],
          reasoning: 'Complaint concerning Hokim assistant (hokim yordamchisi)',
        });
        const slang4 = await evaluator.evaluateRelevance({
          candidateText: "Hokim yordamchisiga aytdik ko'cha masalasida, lekin qaramayapti",
          telegramMessageId: '9504',
          originalTimestamp: '2026-09-04T12:03:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(slang4.data.is_relevant).toBe(true);
        expect(slang4.data.relevant_lanes).toEqual(['HOKIM_RELATED']);
      });

      it('excludes general road and infrastructure complaints lacking Hokim terms as GENERAL_CHATTER', async () => {
        // Road potholes without Hokim mention
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Road pothole complaint lacks explicit Hokim appeal or utility breakdown',
        });
        const road1 = await evaluator.evaluateRelevance({
          candidateText: "Ko'chamizda chuqurlar ko'p, mashinalar buzilyapti",
          telegramMessageId: '9505',
          originalTimestamp: '2026-09-04T12:05:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(road1.data.is_relevant).toBe(false);
        expect(road1.data.relevant_lanes).toEqual([]);
        expect(road1.data.exclusion_reason).toBe('GENERAL_CHATTER');

        // Unpaved mud road without Hokim mention
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Unpaved road defect without Hokim appeal is excluded as non-monitored general chatter',
        });
        const road2 = await evaluator.evaluateRelevance({
          candidateText: "Ko'chamizda asfalt qilinmagan, loydan o'tib bo'lmayapti",
          telegramMessageId: '9506',
          originalTimestamp: '2026-09-04T12:06:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(road2.data.is_relevant).toBe(false);
        expect(road2.data.relevant_lanes).toEqual([]);
        expect(road2.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes mahalla raisi complaints lacking explicit Hokim mention as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Mahalla raisi grievance without Hokim/Hokimiyat apparatus mention is excluded',
        });
        const raisiCheck = await evaluator.evaluateRelevance({
          candidateText: "Mahalla raisi qachon hisobot beradi, qayerga qarayapti?",
          telegramMessageId: '9507',
          originalTimestamp: '2026-09-04T12:07:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });
        expect(raisiCheck.data.is_relevant).toBe(false);
        expect(raisiCheck.data.relevant_lanes).toEqual([]);
        expect(raisiCheck.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('inherits HOKIM_RELATED on direct contextual reply continuing a qualified Hokim appeal', async () => {
        const snapshotWithHokimAppeal: MahallaDailySnapshot = {
          ...snapshot,
          evidence: [
            {
              id: 'evi_hokim_appeal',
              topicId: 'top_hokim_road',
              telegramMessageId: '9510',
              originalTimestamp: '2026-09-04T12:10:00.000Z',
              verbatimText: "Tuman hokimi qachon 4-ko'chadagi chuqurlarni yamaydi?",
              lane: 'HOKIM_RELATED',
            },
          ],
        };

        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['HOKIM_RELATED'],
          exclusion_reason: null,
          accepted_message_ids: ['9511'],
          reasoning: 'Direct reply continuing substantive Hokim road repair complaint',
        });

        const replyResult = await evaluator.evaluateRelevance({
          candidateText: "Biz ham kutib charchadik shu masalada, hech qanday o'zgarish yo'q",
          telegramMessageId: '9511',
          originalTimestamp: '2026-09-04T12:11:00.000Z',
          contentType: 'TEXT',
          replyMetadata: {
            replyToMessageId: '9510',
            replyToIsForwarded: false,
            replyToIsBot: false,
          },
          snapshot: snapshotWithHokimAppeal,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(replyResult.data.is_relevant).toBe(true);
        expect(replyResult.data.relevant_lanes).toEqual(['HOKIM_RELATED']);
        expect(replyResult.data.accepted_message_ids).toEqual(['9511']);
      });
    });
    describe('Live Operational Tracking, Routine ETA, and Directory Inquiries Rules', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-05',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_empty_v1',
        evidence: [],
      };

      it('excludes live vehicle tracking inquiry (e.g. "Musur moshina qaysi ko\'cheda ekan aytvoringlar") as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Operational inquiry asking for the current location of the active garbage truck without asserting any failure or missed schedule',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Musur moshina qaysi ko'cheda ekan aytvoringlar",
          telegramMessageId: '9601',
          originalTimestamp: '2026-09-05T12:02:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.relevant_lanes).toEqual([]);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes water tanker location inquiry as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Routine inquiry asking where the water delivery tanker has arrived without reporting an outage',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Vodovoz mashinasi qayerga keldi?",
          telegramMessageId: '9602',
          originalTimestamp: '2026-09-05T12:05:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.relevant_lanes).toEqual([]);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes standalone directory/phone contact inquiry as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Peer-to-peer phone directory request without an explicit disruption statement is excluded',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Elektroset nomerini beringlar",
          telegramMessageId: '9603',
          originalTimestamp: '2026-09-05T12:10:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.relevant_lanes).toEqual([]);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes routine mobile schedule/ETA inquiry on empty board as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Routine morning ETA inquiry without reported delay or accumulated uncollected waste',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Bugun musor mashina soat nechada keladi?",
          telegramMessageId: '9604',
          originalTimestamp: '2026-09-05T08:30:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.relevant_lanes).toEqual([]);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes routine service arrival announcement on empty board as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Routine peer reminder that garbage truck arrived without prior complaint topic',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Musor mashina keldi, axlatlarni chiqaringlar",
          telegramMessageId: '9605',
          originalTimestamp: '2026-09-05T09:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.relevant_lanes).toEqual([]);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('qualifies genuine interrogative complaint about missed garbage truck under WASTE (substance over mood)', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['WASTE'],
          exclusion_reason: null,
          accepted_message_ids: ['9606'],
          reasoning: 'Communicative intent asserts active municipal service failure regarding uncollected waste and missed schedule',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Musor mashinasi nega kelmadi hali ham, ko'chada axlat to'planib qoldi?",
          telegramMessageId: '9606',
          originalTimestamp: '2026-09-05T14:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['WASTE']);
        expect(result.data.accepted_message_ids).toEqual(['9606']);
      });

      it('qualifies contact request coupled with explicit active failure under ELECTRICITY', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['ELECTRICITY'],
          exclusion_reason: null,
          accepted_message_ids: ['9607'],
          reasoning: 'Active power outage asserted alongside request for dispatch contact number',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Svet o'chdi, elektroset nomerini beringlar",
          telegramMessageId: '9607',
          originalTimestamp: '2026-09-05T15:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
        expect(result.data.accepted_message_ids).toEqual(['9607']);
      });

      it('qualifies fixed utility restoration ETA inquiry under ELECTRICITY (outage presupposed)', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['ELECTRICITY'],
          exclusion_reason: null,
          accepted_message_ids: ['9608'],
          reasoning: 'Inquiring when electricity will return presupposes an active power outage',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Svet qachon keladi o'zi?",
          telegramMessageId: '9608',
          originalTimestamp: '2026-09-05T15:30:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
        expect(result.data.accepted_message_ids).toEqual(['9608']);
      });
    });
    describe('Continuous 24/7 Grid Utility Inquiries vs Periodic Route Inquiries', () => {
      const snapshot: MahallaDailySnapshot = {
        districtId: 'dist_sharof_rashidov',
        mahallaName: 'Navbahor',
        calendarDay: '2026-09-05',
        contextRevision: 0,
        snapshotFingerprint: 'sha256_grid_dichotomy_v1',
        evidence: [],
      };

      it('qualifies pipeline gas presence inquiry as GAS outage (presupposition of absence)', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['GAS'],
          exclusion_reason: null,
          accepted_message_ids: ['9701'],
          reasoning: 'Asking if gas will arrive inherently communicates absence of 24/7 continuous utility',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: 'Bugun gaz keladimi?',
          telegramMessageId: '9701',
          originalTimestamp: '2026-09-05T09:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['GAS']);
        expect(result.data.accepted_message_ids).toEqual(['9701']);
      });

      it('qualifies electricity presence inquiry as ELECTRICITY blackout (presupposition of absence)', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['ELECTRICITY'],
          exclusion_reason: null,
          accepted_message_ids: ['9702'],
          reasoning: 'Asking if electricity will be available communicates active blackout',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Svet bo'ladimi bugun?",
          telegramMessageId: '9702',
          originalTimestamp: '2026-09-05T09:15:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
        expect(result.data.accepted_message_ids).toEqual(['9702']);
      });

      it('qualifies tap water presence inquiry as WATER outage (presupposition of absence)', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['WATER'],
          exclusion_reason: null,
          accepted_message_ids: ['9703'],
          reasoning: 'Asking whether water will be given communicates lack of tap water supply',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Suv beriladimi o'zi?",
          telegramMessageId: '9703',
          originalTimestamp: '2026-09-05T09:30:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['WATER']);
        expect(result.data.accepted_message_ids).toEqual(['9703']);
      });

      it('qualifies neighborhood scope check as ELECTRICITY outage', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['ELECTRICITY'],
          exclusion_reason: null,
          accepted_message_ids: ['9704'],
          reasoning: 'Checking if everyone has power signals current outage at sender location',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: 'Hammada svet bormi yoki bizdami faqat?',
          telegramMessageId: '9704',
          originalTimestamp: '2026-09-05T09:45:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
        expect(result.data.accepted_message_ids).toEqual(['9704']);
      });

      it('qualifies authentic Uzbek sarcastic holiday delivery lamentation under GAS', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['GAS'],
          exclusion_reason: null,
          accepted_message_ids: ['9705'],
          reasoning: 'Sarcastic holiday delivery question communicates active gas supply failure',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: 'Gazni bayramga berishadimi endi?',
          telegramMessageId: '9705',
          originalTimestamp: '2026-09-05T10:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['GAS']);
        expect(result.data.accepted_message_ids).toEqual(['9705']);
      });

      it('qualifies ironic New Year electricity lamentation under ELECTRICITY', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['ELECTRICITY'],
          exclusion_reason: null,
          accepted_message_ids: ['9706'],
          reasoning: 'Ironic New Year projection expresses active prolonged power outage',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Svetni yangi yilda ko'ramiz shekilli",
          telegramMessageId: '9706',
          originalTimestamp: '2026-09-05T10:15:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
        expect(result.data.accepted_message_ids).toEqual(['9706']);
      });

      it('qualifies rhetorical municipal dormancy complaint under HOKIM_RELATED', async () => {
        mockAdapter.setNextResponse({
          is_relevant: true,
          relevant_lanes: ['HOKIM_RELATED'],
          exclusion_reason: null,
          accepted_message_ids: ['9707'],
          reasoning: 'Rhetorical inquiry regarding Hokimiyat inaction expresses civic grievance against district administration',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Hokimiyatdagilar qachon uyg'onadi o'zi?",
          telegramMessageId: '9707',
          originalTimestamp: '2026-09-05T10:30:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(true);
        expect(result.data.relevant_lanes).toEqual(['HOKIM_RELATED']);
        expect(result.data.accepted_message_ids).toEqual(['9707']);
      });

      it('excludes routine periodic waste ETA check as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Routine mobile service ETA inquiry without reported delay or accumulated uncollected waste',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: 'Bugun musor keladimi?',
          telegramMessageId: '9708',
          originalTimestamp: '2026-09-05T10:45:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes bottled gas cylinder truck tracking as GENERAL_CHATTER', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'GENERAL_CHATTER',
          accepted_message_ids: [],
          reasoning: 'Periodic bottled gas cylinder delivery inquiry without failure or overdue report',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: 'Gaz balon mashinasi keldimi?',
          telegramMessageId: '9709',
          originalTimestamp: '2026-09-05T11:00:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
      });

      it('excludes future speculative shutoff inquiry as SPECULATION_OR_RUMOR', async () => {
        mockAdapter.setNextResponse({
          is_relevant: false,
          relevant_lanes: [],
          exclusion_reason: 'SPECULATION_OR_RUMOR',
          accepted_message_ids: [],
          reasoning: 'Speculative inquiry about future electricity cut without asserting an active power failure',
        });

        const result = await evaluator.evaluateRelevance({
          candidateText: "Ertaga svet o'chadimi kimdir biladimi?",
          telegramMessageId: '9710',
          originalTimestamp: '2026-09-05T11:15:00.000Z',
          contentType: 'TEXT',
          replyMetadata: null,
          snapshot,
          profileId: 'prof_rel_2026_08_v1',
        });

        expect(result.data.is_relevant).toBe(false);
        expect(result.data.exclusion_reason).toBe('SPECULATION_OR_RUMOR');
      });

      describe('Dialect, Homonym & Multi-Message Burst Invariants (Gulbodom Case)', () => {
        it('qualifies dialectal multi-message burst with payment and intermittency under WATER', async () => {
          const burstItems = [
            { intakeId: 'int_1', telegramMessageId: '30', originalTimestamp: '2026-09-06T06:39:40.000Z', verbatimText: 'suvchi', contentType: 'TEXT' as const, replyMetadata: null },
            { intakeId: 'int_2', telegramMessageId: '31', originalTimestamp: '2026-09-06T06:39:46.000Z', verbatimText: 'uyam qurib yotoradimi endi', contentType: 'TEXT' as const, replyMetadata: null },
            { intakeId: 'int_3', telegramMessageId: '32', originalTimestamp: '2026-09-06T06:40:02.000Z', verbatimText: 'pul tulamasogam mayli', contentType: 'TEXT' as const, replyMetadata: null },
            { intakeId: 'int_4', telegramMessageId: '33', originalTimestamp: '2026-09-06T06:40:07.000Z', verbatimText: 'tekin disek', contentType: 'TEXT' as const, replyMetadata: null },
            { intakeId: 'int_5', telegramMessageId: '34', originalTimestamp: '2026-09-06T06:40:18.000Z', verbatimText: 'pulini tulekkan busek.', contentType: 'TEXT' as const, replyMetadata: null },
            { intakeId: 'int_6', telegramMessageId: '35', originalTimestamp: '2026-09-06T06:40:25.000Z', verbatimText: 'xohlagan payti bor xohlasa yu', contentType: 'TEXT' as const, replyMetadata: null },
          ];

          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['30', '31', '32', '33', '34', '35'],
            reasoning: 'Citizen reports erratic tap water supply despite paying utility bills',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: burstItems.map((b) => b.verbatimText).join('\n'),
            telegramMessageId: '30',
            originalTimestamp: burstItems[0]!.originalTimestamp,
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            burstMessages: burstItems,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WATER']);
          expect(result.data.exclusion_reason).toBeNull();
          expect(result.data.accepted_message_ids).toEqual(['30', '31', '32', '33', '34', '35']);
        });

        it('excludes isolated single-word "suvchi" without burst or context as UNRESOLVED_AMBIGUOUS_FRAGMENT', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'UNRESOLVED_AMBIGUOUS_FRAGMENT',
            accepted_message_ids: [],
            reasoning: 'Isolated single-word inquiry without disruption facts or prior context',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'suvchi',
            telegramMessageId: '9801',
            originalTimestamp: '2026-09-06T07:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('UNRESOLVED_AMBIGUOUS_FRAGMENT');
          expect(result.data.accepted_message_ids).toEqual([]);
        });

        it('qualifies "kranta qurib yotibdi" under WATER (qurimoq = desiccate/no water)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['9802'],
            reasoning: 'Tap water outage reported using colloquial desiccation expression',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'Kranta suv yoq qurib yotibdi',
            telegramMessageId: '9802',
            originalTimestamp: '2026-09-06T07:15:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WATER']);
          expect(result.data.accepted_message_ids).toEqual(['9802']);
        });

        it('excludes true private plumber/craftsman hire as ADVERTISEMENT_OR_SPAM', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
            accepted_message_ids: [],
            reasoning: 'Private plumber craftsman hire for residential home renovation',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'Uyni remont qilyapmiz yaxshi santexnik bormi nomeri kerak',
            telegramMessageId: '9803',
            originalTimestamp: '2026-09-06T07:30:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');
        });

        it('verifies SEMANTIC_RELEVANCE_SYSTEM_PROMPT contains two-tier architecture (Core Invariants and Empirical Learnings)', () => {
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('PART I: CORE ARCHITECTURAL INVARIANTS & SUBSTANCE GATES');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('PART II: EMPIRICAL TELEGRAM FIELD LEARNINGS & DIALECT ADAPTATIONS');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('PREDICATE DOMINANCE & TARIFF/INTERMITTENCY DISSATISFACTION');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('UZBEK LINGUISTIC HOMONYM & DIALECT DISAMBIGUATION CONTRACT');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('MULTI-MESSAGE SYNTACTIC SPLITTING INVARIANT');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('SYNTACTIC BIPARTITE PROPOSITION CONTRACT');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('kemadi');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('-ku');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('qurimoq');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('suvchi');
        });
      });

      describe('Syntactic Bipartite Proposition Contract & Verbal Contractions', () => {
        it('qualifies minimal bipartite report "suv kemadiku" under WATER (subject + negative arrival predicate)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['9901'],
            reasoning: 'Minimal bipartite proposition asserting water utility delivery failure with emphatic particle',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'suv kemadiku',
            telegramMessageId: '9901',
            originalTimestamp: '2026-09-07T12:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WATER']);
          expect(result.data.exclusion_reason).toBeNull();
          expect(result.data.accepted_message_ids).toEqual(['9901']);
        });

        it('qualifies verbal contraction "gaz kemapti" under GAS (/l/ elision in kelmapti)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['GAS'],
            exclusion_reason: null,
            accepted_message_ids: ['9902'],
            reasoning: 'Verbal contraction kemapti (kelmapti) asserts gas failure',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'gaz kemapti',
            telegramMessageId: '9902',
            originalTimestamp: '2026-09-07T12:05:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['GAS']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('qualifies verbal contraction "svet bo\'mayapti" under ELECTRICITY (bo\'lmayapti contraction)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['ELECTRICITY'],
            exclusion_reason: null,
            accepted_message_ids: ['9903'],
            reasoning: 'Verbal contraction bo\'mayapti asserts electricity outage',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "svet bo'mayapti",
            telegramMessageId: '9903',
            originalTimestamp: '2026-09-07T12:10:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('qualifies verbal contraction "suv kegani yo\'q" under WATER (kelgani yo\'q contraction)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['9904'],
            reasoning: 'Verbal contraction kegani yo\'q asserts water failure',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "suv kegani yo'q",
            telegramMessageId: '9904',
            originalTimestamp: '2026-09-07T12:15:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WATER']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('qualifies enclitic particle variations "suv yo\'qda" and "gaz o\'chdiya"', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['9905'],
            reasoning: 'Enclitic particle -da with outage statement',
          });

          const res1 = await evaluator.evaluateRelevance({
            candidateText: "suv yo'qda",
            telegramMessageId: '9905',
            originalTimestamp: '2026-09-07T12:20:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });
          expect(res1.data.is_relevant).toBe(true);
          expect(res1.data.relevant_lanes).toEqual(['WATER']);

          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['GAS'],
            exclusion_reason: null,
            accepted_message_ids: ['9906'],
            reasoning: 'Enclitic particle -ya with outage statement',
          });

          const res2 = await evaluator.evaluateRelevance({
            candidateText: "gaz o'chdiya",
            telegramMessageId: '9906',
            originalTimestamp: '2026-09-07T12:25:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });
          expect(res2.data.is_relevant).toBe(true);
          expect(res2.data.relevant_lanes).toEqual(['GAS']);
        });

        it('excludes subjectless fragment "kemadiku" alone as UNRESOLVED_AMBIGUOUS_FRAGMENT', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'UNRESOLVED_AMBIGUOUS_FRAGMENT',
            accepted_message_ids: [],
            reasoning: 'Missing municipal subject without prior reply or burst context',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'kemadiku',
            telegramMessageId: '9907',
            originalTimestamp: '2026-09-07T12:30:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('UNRESOLVED_AMBIGUOUS_FRAGMENT');
        });

        it('excludes speculative future query "ertaga suv kemaydimi?" as SPECULATION_OR_RUMOR', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'SPECULATION_OR_RUMOR',
            accepted_message_ids: [],
            reasoning: 'Future speculative inquiry about hypothetical shutoff',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'ertaga suv kemaydimi?',
            telegramMessageId: '9908',
            originalTimestamp: '2026-09-07T12:35:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('SPECULATION_OR_RUMOR');
        });

        it('excludes private appliance issue "boylerga suv kemayapti" as ADVERTISEMENT_OR_SPAM', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'ADVERTISEMENT_OR_SPAM',
            accepted_message_ids: [],
            reasoning: 'Private appliance malfunction rather than public distribution network failure',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'boylerga suv kemayapti',
            telegramMessageId: '9909',
            originalTimestamp: '2026-09-07T12:40:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('ADVERTISEMENT_OR_SPAM');
        });

        it('excludes failure negation "svet o\'chmadi" as GENERAL_CHATTER', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning: 'Negation of outage indicates normal operation',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "svet o'chmadi",
            telegramMessageId: '9910',
            originalTimestamp: '2026-09-07T12:45:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
        });
      });

      describe('Hypothetical Conditionals, Sarcasm Boundary & Mixed Burst Lane Isolation', () => {
        it('verifies SEMANTIC_RELEVANCE_SYSTEM_PROMPT codifies State-Transition Presupposition Principle', () => {
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain(
            'STATE-TRANSITION PRESUPPOSITION PRINCIPLE',
          );
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain(
            'MIXED BURST LANE ISOLATION & HYPOTHETICAL FILTERING',
          );
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain(
            'Authentic Grievance Sarcasm regarding an EXISTING Ongoing Outage',
          );
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain(
            'Hypothetical / Counterfactual Sarcasm Imagining an UNOCCURRED Outage',
          );
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain(
            'PRESERVATION OF VALID RECURRING & TARIFF CONDITIONALS',
          );
        });

        it('excludes standalone hypothetical conditional "svettiyam ucirishsa endi" as GENERAL_CHATTER', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning:
              'Hypothetical conditional imagining an unoccurred electricity shutoff represents cynical chatter, not an active disruption report',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'svettiyam ucirishsa endi',
            telegramMessageId: '9920',
            originalTimestamp: '2026-09-10T15:25:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
          expect(result.data.accepted_message_ids).toHaveLength(0);
        });

        it('excludes speculative future shutoff conditional "agar gaz o\'chsa nima qilamiz?" as SPECULATION_OR_RUMOR', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'SPECULATION_OR_RUMOR',
            accepted_message_ids: [],
            reasoning:
              'Speculative anticipatory question about a potential future cut without an active disruption',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "agar gaz o'chsa nima qilamiz?",
            telegramMessageId: '9921',
            originalTimestamp: '2026-09-10T15:25:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('SPECULATION_OR_RUMOR');
        });

        it('strictly isolates lanes and excludes cynical hypotheticals in mixed bursts', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['165', '166', '167'],
            reasoning:
              'Candidate reports an active tap water outage. Messages 168-170 are cynical hypothetical remarks about an unoccurred electricity outage and are excluded.',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'suvam quridi',
            telegramMessageId: '165',
            originalTimestamp: '2026-09-10T15:25:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            burstMessages: [
              {
                intakeId: 'intake_165',
                telegramMessageId: '165',
                verbatimText: 'suvam quridi',
                originalTimestamp: '2026-09-10T15:25:00.000Z',
                contentType: 'TEXT',
                replyMetadata: null,
              },
              {
                intakeId: 'intake_166',
                telegramMessageId: '166',
                verbatimText: 'bir soat buldi',
                originalTimestamp: '2026-09-10T15:25:10.000Z',
                contentType: 'TEXT',
                replyMetadata: null,
              },
              {
                intakeId: 'intake_167',
                telegramMessageId: '167',
                verbatimText: 'nma bulepti',
                originalTimestamp: '2026-09-10T15:25:20.000Z',
                contentType: 'TEXT',
                replyMetadata: null,
              },
              {
                intakeId: 'intake_168',
                telegramMessageId: '168',
                verbatimText: 'svettiyam ucirishsa endi',
                originalTimestamp: '2026-09-10T15:25:30.000Z',
                contentType: 'TEXT',
                replyMetadata: null,
              },
              {
                intakeId: 'intake_169',
                telegramMessageId: '169',
                verbatimText: 'balans buladi',
                originalTimestamp: '2026-09-10T15:26:00.000Z',
                contentType: 'TEXT',
                replyMetadata: null,
              },
              {
                intakeId: 'intake_170',
                telegramMessageId: '170',
                verbatimText: 'kolxoz buladi',
                originalTimestamp: '2026-09-10T15:26:10.000Z',
                contentType: 'TEXT',
                replyMetadata: null,
              },
            ],
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WATER']);
          expect(result.data.relevant_lanes).not.toContain('ELECTRICITY');
          expect(result.data.accepted_message_ids).toEqual(['165', '166', '167']);
          expect(result.data.accepted_message_ids).not.toContain('168');
          expect(result.data.accepted_message_ids).not.toContain('169');
          expect(result.data.accepted_message_ids).not.toContain('170');
        });

        it('preserves valid recurring daily outages with conditional -sa as ELECTRICITY', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['ELECTRICITY'],
            exclusion_reason: null,
            accepted_message_ids: ['9930'],
            reasoning: 'Reports an active recurring scheduled daily power blackout pattern',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "har kuni soat 6 bo'lsa svet o'chadi",
            telegramMessageId: '9930',
            originalTimestamp: '2026-09-10T18:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('preserves valid restoration pleas "svetni yoqib berishsa bo\'lardi" as ELECTRICITY', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['ELECTRICITY'],
            exclusion_reason: null,
            accepted_message_ids: ['9931'],
            reasoning: 'Presupposes current power outage and requests municipal service restoration',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "svetni yoqib berishsa bo'lardi",
            telegramMessageId: '9931',
            originalTimestamp: '2026-09-10T18:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('preserves sarcasm regarding an ALREADY EXISTING outage "Gazni bayramga berishadimi endi?" as GAS', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['GAS'],
            exclusion_reason: null,
            accepted_message_ids: ['9932'],
            reasoning:
              'Authentic cultural grievance sarcasm lamenting an active ongoing gas outage',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'Gazni bayramga berishadimi endi?',
            telegramMessageId: '9932',
            originalTimestamp: '2026-09-10T18:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['GAS']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('preserves Uzbek modal restoration estimates "-sa kerak / -sa kere / -sa kereya" inheriting active GAS lane from preceding chat message', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['GAS'],
            exclusion_reason: null,
            accepted_message_ids: ['382'],
            reasoning:
              'Modal restoration estimate ("yonsa kereya") presupposes service absence and estimates gas flow restoration following inquiry in message 381',
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: "O'tgan safargide 8dan o'tib yonsa kereya",
            telegramMessageId: '382',
            originalTimestamp: '2026-09-10T11:11:40.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            immediatePrecedingMessage: {
              telegramMessageId: '381',
              originalTimestamp: '2026-09-10T11:11:18.000Z',
              verbatimText: 'Газ келармикан махалладошллар',
              lane: 'GAS',
            },
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['GAS']);
          expect(result.data.exclusion_reason).toBeNull();
          expect(result.data.accepted_message_ids).toEqual(['382']);

          // Verify evaluator formatted the prompt with immediate preceding message and lane
          const calls = mockAdapter.getCalls();
          const lastCall = calls[calls.length - 1];
          expect(lastCall).toBeDefined();
          expect(lastCall!.userPrompt).toContain('### IMMEDIATE PRECEDING MESSAGE (N-1 IN CHAT)');
          expect(lastCall!.userPrompt).toContain('- Message ID: 381 (+0m before candidate) (Lane: [GAS])');
          expect(lastCall!.userPrompt).toContain('Газ келармикан махалладошллар');
        });

        it('strictly contrasts modal restoration "-sa kerak" (presupposes outage) vs hypothetical shutoff "-sa" (presupposes service operational)', async () => {
          // 1. Hypothetical shutoff conditional -> REJECTED
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning: 'Hypothetical conditional imagining shutoff',
          });

          const shutoffResult = await evaluator.evaluateRelevance({
            candidateText: 'svettiyam ucirishsa endi',
            telegramMessageId: '9940',
            originalTimestamp: '2026-09-10T18:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(shutoffResult.data.is_relevant).toBe(false);
          expect(shutoffResult.data.exclusion_reason).toBe('GENERAL_CHATTER');

          // 2. Modal restoration estimate -> ACCEPTED
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['ELECTRICITY'],
            exclusion_reason: null,
            accepted_message_ids: ['9941'],
            reasoning: 'Modal restoration estimate indicating active power outage',
          });

          const restorationResult = await evaluator.evaluateRelevance({
            candidateText: 'soat 8 dan keyin yonsa kerak',
            telegramMessageId: '9941',
            originalTimestamp: '2026-09-10T18:00:10.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(restorationResult.data.is_relevant).toBe(true);
          expect(restorationResult.data.relevant_lanes).toEqual(['ELECTRICITY']);
          expect(restorationResult.data.exclusion_reason).toBeNull();
        });

        it('verifies Section 13 in SEMANTIC_RELEVANCE_SYSTEM_PROMPT governs modal restoration estimates', () => {
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('### 13. UZBEK MODAL RESTORATION ESTIMATES');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('-sa kerak / -sa kere / -sa kereya');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('VERB DIRECTIONALITY DETERMINES RELEVANCE');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('gaz yonadi / yonsa kerak');
        });

        it('verifies Section 14 and Section 6 in SEMANTIC_RELEVANCE_SYSTEM_PROMPT govern negative verbal polarity & preservation idioms', () => {
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('### 14. NEGATIVE VERBAL POLARITY & SERVICE PRESERVATION ASSERTIONS');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain("o'chmagan");
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain("yonmagan");
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('bitta [X] qoldi [fe\'l-magan]');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('bitta svet qoldi ucmagan');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('uniyam ucirishsa begi kolxoz buladi');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain("Vowel, Cyrillic & Informal Letter Substitutions (o' -> u, sh -> w, ch -> c)");
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('uciriwsa');
        });

        it('rejects "bitta svet qoldi ucmagan" and cynical conditional burst as GENERAL_CHATTER', async () => {
          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_tashkent_01',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-10',
            evidence: [],
            contextRevision: 1,
            snapshotFingerprint: 'fp_123',
          };

          // 1. Single candidate "bitta svet qoldi ucmagan"
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning:
              "The candidate 'bitta svet qoldi ucmagan' states that electricity has NOT shut off and remains operational. Per Section 14, this is service preservation rather than an outage report.",
          });

          const singleResult = await evaluator.evaluateRelevance({
            candidateText: 'bitta svet qoldi ucmagan',
            telegramMessageId: '9951',
            originalTimestamp: '2026-09-10T15:02:54.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(singleResult.data.is_relevant).toBe(false);
          expect(singleResult.data.exclusion_reason).toBe('GENERAL_CHATTER');
          expect(singleResult.data.relevant_lanes).toEqual([]);

          // 2. Burst candidate: "bitta svet qoldi ucmagan" + "uniyam ucirishsa begi kolxoz buladi"
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning:
              "Message 1 states electricity is still running ('bitta svet qoldi ucmagan'), and Message 2 is a cynical hypothetical conditional ('uniyam ucirishsa begi kolxoz buladi'). Per Section 14, both fail the Substance Gate.",
          });

          const burstResult = await evaluator.evaluateRelevance({
            candidateText: 'bitta svet qoldi ucmagan\nuniyam ucirishsa begi kolxoz buladi',
            telegramMessageId: '9951',
            originalTimestamp: '2026-09-10T15:02:54.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            burstMessages: [
              {
                intakeId: 'int_1',
                telegramMessageId: '9951',
                verbatimText: 'bitta svet qoldi ucmagan',
                originalTimestamp: '2026-09-10T15:02:54.000Z',
                contentType: 'TEXT',
              },
              {
                intakeId: 'int_2',
                telegramMessageId: '9952',
                verbatimText: 'uniyam ucirishsa begi kolxoz buladi',
                originalTimestamp: '2026-09-10T15:03:04.000Z',
                contentType: 'TEXT',
              },
            ],
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(burstResult.data.is_relevant).toBe(false);
          expect(burstResult.data.exclusion_reason).toBe('GENERAL_CHATTER');
          expect(burstResult.data.accepted_message_ids).toEqual([]);
        });

        it('verifies Section 15 in SEMANTIC_RELEVANCE_SYSTEM_PROMPT governs communal maintenance shutoffs & resident grievances', () => {
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('### 15. COMMUNAL MAINTENANCE SHUTOFFS, SEASONAL PREPARATIONS & RESIDENT GRIEVANCES');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('remont');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('kuz-qish mavsumiga tayyorgarlik');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('Yana qish kuz mavsumiga tayyorgarlikmikan');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('remont qilorib charchamaskanda bu gazdegila');
          expect(SEMANTIC_RELEVANCE_SYSTEM_PROMPT).toContain('gazdegila');
        });

        it('accepts maintenance inquiry "Yana qish kuz mavsumiga tayyorgarlikmikan" with preceding same-day gas outage context', async () => {
          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_tashkent_01',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-11',
            evidence: [
              {
                id: 'evi_409',
                telegramMessageId: '409',
                verbatimText: 'Ertalabdan gaz yumi',
                originalTimestamp: '2026-09-11T01:34:57.000Z',
                lane: 'GAS',
                topicSummary: 'Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.',
              },
            ],
            contextRevision: 1,
            snapshotFingerprint: 'fp_409',
          };

          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['GAS'],
            exclusion_reason: null,
            accepted_message_ids: ['411'],
            reasoning:
              "The candidate message 'Yana qish kuz mavsumiga tayyorgarlikmikan' is an inquiry attributing the ongoing morning gas outage to seasonal maintenance. Per Section 15, it inherits the active GAS lane.",
          });

          const result = await evaluator.evaluateRelevance({
            candidateText: 'Yana qish kuz mavsumiga tayyorgarlikmikan',
            telegramMessageId: '411',
            originalTimestamp: '2026-09-11T04:11:44.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            immediatePrecedingMessage: {
              telegramMessageId: '410',
              originalTimestamp: '2026-09-11T01:35:05.000Z',
              verbatimText: 'Hammada ucganmi',
              lane: 'GAS',
            },
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['GAS']);
          expect(result.data.exclusion_reason).toBeNull();
          expect(result.data.accepted_message_ids).toEqual(['411']);
        });

        it('accepts maintenance shutoff grievance burst "remont qilorib charchamaskanda bu gazdegila" under GAS lane', async () => {
          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_tashkent_01',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-11',
            evidence: [
              {
                id: 'evi_409',
                telegramMessageId: '409',
                verbatimText: 'Ertalabdan gaz yumi',
                originalTimestamp: '2026-09-11T01:34:57.000Z',
                lane: 'GAS',
                topicSummary: 'Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.',
              },
            ],
            contextRevision: 1,
            snapshotFingerprint: 'fp_409',
          };

          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['GAS'],
            exclusion_reason: null,
            accepted_message_ids: ['412', '413', '414', '415'],
            reasoning:
              "The burst expresses citizen grievance against the gas utility ('bu gazdegila') for persistent maintenance shutoffs ('remont qilorib charchamaskanda'). Per Section 15, this satisfies the Substance Gate for GAS.",
          });

          const burstResult = await evaluator.evaluateRelevance({
            candidateText:
              'remont qilorib charchamaskanda bu gazdegila\nremon digan narsa bir marta bumedimi\nhadeb har yili qilinorsa\ngalati',
            telegramMessageId: '412',
            originalTimestamp: '2026-09-11T14:40:28.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            burstMessages: [
              {
                intakeId: 'int_412',
                telegramMessageId: '412',
                verbatimText: 'remont qilorib charchamaskanda bu gazdegila',
                originalTimestamp: '2026-09-11T14:40:28.000Z',
                contentType: 'TEXT',
              },
              {
                intakeId: 'int_413',
                telegramMessageId: '413',
                verbatimText: 'remon digan narsa bir marta bumedimi',
                originalTimestamp: '2026-09-11T14:40:39.000Z',
                contentType: 'TEXT',
              },
              {
                intakeId: 'int_414',
                telegramMessageId: '414',
                verbatimText: 'hadeb har yili qilinorsa',
                originalTimestamp: '2026-09-11T14:40:51.000Z',
                contentType: 'TEXT',
              },
              {
                intakeId: 'int_415',
                telegramMessageId: '415',
                verbatimText: 'galati',
                originalTimestamp: '2026-09-11T14:40:54.000Z',
                contentType: 'TEXT',
              },
            ],
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(burstResult.data.is_relevant).toBe(true);
          expect(burstResult.data.relevant_lanes).toEqual(['GAS']);
          expect(burstResult.data.exclusion_reason).toBeNull();
          expect(burstResult.data.accepted_message_ids).toEqual(['412', '413', '414', '415']);
        });
      });

      describe('Chat Continuity & Parent-Reply Validation Isolation', () => {
        it('formats prompt with INTERRUPTED THREAD when interveningCount > 0', () => {
          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: "Navro'z",
            calendarDay: '2026-09-12',
            contextRevision: 1,
            snapshotFingerprint: 'fp_test',
            evidence: [],
          };

          const prompt = evaluator.buildUserPrompt({
            candidateText: 'каерда экан бизга керек',
            telegramMessageId: '66312',
            originalTimestamp: '2026-09-12T14:07:37.000Z',
            contentType: 'TEXT',
            replyMetadata: {
              replyToMessageId: '66307',
              replyToUserId: '556677',
              replyToIsForwarded: false,
              replyToIsBot: false,
            },
            snapshot,
            chatContinuity: {
              interveningCount: 4,
              precedingRelevantMessage: {
                telegramMessageId: '66306',
                originalTimestamp: '2026-09-12T12:47:00.000Z',
                verbatimText: 'musor moshina kemadi',
                lane: 'WASTE',
              },
            },
            parentReplyContext: {
              parentMessageId: '66307',
              parentStatus: 'EXCLUDED',
              parentExclusionReason: 'ADVERTISEMENT_OR_SPAM',
              parentVerbatimText: 'кимга битон тош керак текинга олиб кетинг',
            },
          });

          // 1. Verify parent reply context with exclusion status and isolation rule
          expect(prompt).toContain('### REPLY CONTEXT (PARENT IS CONFIRMED NON-CIVIC MESSAGE)');
          expect(prompt).toContain('Reply To Message ID: 66307 (Status: EXCLUDED / ADVERTISEMENT_OR_SPAM)');
          expect(prompt).toContain('Parent Verbatim Text: "кимга битон тош керак текинга олиб кетинг"');
          expect(prompt).toContain('CRITICAL ISOLATION RULE: The parent message is a non-civic chat/ad');

          // 2. Verify chat continuity status marked as BROKEN
          expect(prompt).toContain('### CHAT CONTINUITY STATUS (INTERRUPTED THREAD)');
          expect(prompt).toContain('Earlier Civic Evidence: MsgID 66306 (+81m before candidate) (Lane: [WASTE])');
          expect(prompt).toContain('Sender of Earlier Evidence: DIFFERENT SENDER (Third-party message - strict anti-latching applies)');
          expect(prompt).toContain('Intervening Unrelated Messages: 4 message(s) occurred in chat between earlier civic evidence and candidate');
          expect(prompt).toContain('Conversational Continuity: BROKEN (Thread interrupted by unrelated chat)');
          expect(prompt).toContain('Explicit Reply Target: MsgID 66307');
          expect(prompt).toContain('RULE: Candidate must be fully self-contained UNLESS sent by the same resident continuing their earlier civic grievance.');

          // 3. Ensure it is NOT labeled as Immediate Preceding N-1
          expect(prompt).not.toContain('### IMMEDIATE PRECEDING MESSAGE (N-1 IN CHAT, DIRECT CONTINUATION)');
        });

        it('formats prompt with IMMEDIATE PRECEDING MESSAGE when interveningCount === 0 and direct continuation', () => {
          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: "Navro'z",
            calendarDay: '2026-09-12',
            contextRevision: 1,
            snapshotFingerprint: 'fp_test',
            evidence: [],
          };

          const prompt = evaluator.buildUserPrompt({
            candidateText: 'bizda ham ochdi',
            telegramMessageId: '1002',
            originalTimestamp: '2026-09-12T12:48:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            chatContinuity: {
              interveningCount: 0,
              precedingRelevantMessage: {
                telegramMessageId: '1001',
                originalTimestamp: '2026-09-12T12:47:00.000Z',
                verbatimText: "Svet o'chdi",
                lane: 'ELECTRICITY',
              },
            },
          });

          expect(prompt).toContain('### IMMEDIATE PRECEDING MESSAGE (N-1 IN CHAT)');
          expect(prompt).toContain('Message ID: 1001 (+1m before candidate) (Lane: [ELECTRICITY])');
          expect(prompt).toContain('Text: "Svet o\'chdi"');
          expect(prompt).not.toContain('### CHAT CONTINUITY STATUS (INTERRUPTED THREAD)');
        });

        it('evaluates ambiguous dependent fragment across broken continuity as UNRESOLVED_AMBIGUOUS_FRAGMENT', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'UNRESOLVED_AMBIGUOUS_FRAGMENT',
            accepted_message_ids: [],
            reasoning: 'Ambiguous dependent fragment across broken chat continuity without independent municipal keywords',
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: "Navro'z",
            calendarDay: '2026-09-12',
            contextRevision: 1,
            snapshotFingerprint: 'fp_test',
            evidence: [],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: 'каерда экан бизга керек',
            telegramMessageId: '66312',
            originalTimestamp: '2026-09-12T14:07:37.000Z',
            contentType: 'TEXT',
            replyMetadata: {
              replyToMessageId: '66307',
              replyToUserId: '556677',
              replyToIsForwarded: false,
              replyToIsBot: false,
            },
            snapshot,
            chatContinuity: {
              interveningCount: 4,
              precedingRelevantMessage: {
                telegramMessageId: '66306',
                originalTimestamp: '2026-09-12T12:47:00.000Z',
                verbatimText: 'musor moshina kemadi',
                lane: 'WASTE',
              },
            },
            parentReplyContext: {
              parentMessageId: '66307',
              parentStatus: 'EXCLUDED',
              parentExclusionReason: 'ADVERTISEMENT_OR_SPAM',
            },
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('UNRESOLVED_AMBIGUOUS_FRAGMENT');
          expect(result.data.relevant_lanes).toHaveLength(0);
        });

        it('formats prompt with AUTHOR PRIOR SAME-DAY CIVIC CONTEXT and SAME SENDER continuity', () => {
          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-14',
            contextRevision: 2,
            snapshotFingerprint: 'fp_author_test',
            evidence: [
              {
                id: 'ev_428',
                topicId: 'top_waste_1',
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            ],
          };

          const prompt = evaluator.buildUserPrompt({
            candidateText: 'Nme pul olepti vaqtida kemasa',
            telegramMessageId: '430',
            telegramUserId: '7512582881',
            originalTimestamp: '2026-09-14T07:17:34.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            authorPriorEvidence: [
              {
                id: 'ev_428',
                topicId: 'top_waste_1',
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            ],
            chatContinuity: {
              interveningCount: 2,
              precedingRelevantMessage: {
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            },
          });

          // Verify author section is rendered
          expect(prompt).toContain("### AUTHOR'S PRIOR SAME-DAY CIVIC CONTEXT (SAME SENDER)");
          expect(prompt).toContain('MsgID: 428, Time: 2026-09-14T02:52:00.000Z | Lane: [WASTE] | Topic: top_waste_1');
          expect(prompt).toContain('"Musr kemadiku keca"');
          expect(prompt).toContain('CONTEXTUAL CONTINUITY: This prior context establishes the sender\'s active civic problem thread.');

          // Verify sender relation in interrupted thread is SAME SENDER
          expect(prompt).toContain('Sender of Earlier Evidence: SAME SENDER AS CANDIDATE (Author Continuity applies - see AUTHOR\'S PRIOR SAME-DAY CIVIC CONTEXT)');
        });

        it('evaluates same-author grievance follow-up (Nme pul olepti vaqtida kemasa) as RELEVANT under author continuity', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WASTE'],
            exclusion_reason: null,
            accepted_message_ids: ['430'],
            reasoning: 'Citizen fee dispute regarding uncollected waste continuing author prior civic report',
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-14',
            contextRevision: 2,
            snapshotFingerprint: 'fp_author_test',
            evidence: [
              {
                id: 'ev_428',
                topicId: 'top_waste_1',
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            ],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: 'Nme pul olepti vaqtida kemasa',
            telegramMessageId: '430',
            telegramUserId: '7512582881',
            originalTimestamp: '2026-09-14T07:17:34.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            authorPriorEvidence: [
              {
                id: 'ev_428',
                topicId: 'top_waste_1',
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            ],
            chatContinuity: {
              interveningCount: 2,
              precedingRelevantMessage: {
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            },
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WASTE']);
          expect(result.data.exclusion_reason).toBeNull();
          expect(result.data.accepted_message_ids).toEqual(['430']);
        });

        it('evaluates same-author domestic chatter as EXCLUDED (GENERAL_CHATTER) even with prior civic report', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning: 'Domestic cooking inquiry unrelated to civic municipal services',
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-14',
            contextRevision: 2,
            snapshotFingerprint: 'fp_author_test',
            evidence: [
              {
                id: 'ev_428',
                topicId: 'top_waste_1',
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            ],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: 'Qozon qayerda qoldi?',
            telegramMessageId: '435',
            telegramUserId: '7512582881',
            originalTimestamp: '2026-09-14T07:30:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            authorPriorEvidence: [
              {
                id: 'ev_428',
                topicId: 'top_waste_1',
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            ],
            chatContinuity: {
              interveningCount: 2,
              precedingRelevantMessage: {
                telegramMessageId: '428',
                telegramUserId: '7512582881',
                originalTimestamp: '2026-09-14T02:52:00.000Z',
                verbatimText: 'Musr kemadiku keca',
                lane: 'WASTE',
              },
            },
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
          expect(result.data.relevant_lanes).toHaveLength(0);
        });
      });

      describe('Section 17: Citizen Coping Proposals, Workarounds & Self-Organization Grievances', () => {
        it('evaluates Navbahor multi-message waste coping burst as RELEVANT with all constituent clauses accepted', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WASTE'],
            exclusion_reason: null,
            accepted_message_ids: ['438', '439', '440', '441', '442', '443'],
            reasoning:
              "The burst proposes creating an informal communal waste collection point due to the municipal garbage truck being erratic and unserved ('Zato qacon kelarkn dib kutb utirmemiz perejivat qilib'). This coping workaround satisfies Section 17 for WASTE.",
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-15',
            contextRevision: 0,
            snapshotFingerprint: 'fp_navbahor_coping',
            evidence: [],
          };

          const burstCandidateText = [
            'Bitta obshiy tukedigan joy qiganimiz yaxshimasmikan undan kura',
            'Borib tukb keloramz',
            'Mahallani icida',
            'Mayli sal uzoro bular kimgadir',
            'Amallemiz',
            'Zato qacon kelarkn dib kutb utirmemiz perejivat qilib',
          ].join('\n');

          const result = await evaluator.evaluateRelevance({
            candidateText: burstCandidateText,
            telegramMessageId: '438',
            telegramUserId: '7512582881',
            originalTimestamp: '2026-09-15T13:20:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WASTE']);
          expect(result.data.exclusion_reason).toBeNull();
          expect(result.data.accepted_message_ids).toEqual(['438', '439', '440', '441', '442', '443']);
        });

        it('evaluates water pump self-help proposal motivated by utility abandonment as RELEVANT under WATER', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['WATER'],
            exclusion_reason: null,
            accepted_message_ids: ['501'],
            reasoning:
              "Proposes installing a private water pump because tap water supply has failed and provider has abandoned service ('vodokanaldan umid yo'q').",
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-15',
            contextRevision: 0,
            snapshotFingerprint: 'fp_water_coping',
            evidence: [],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: "O'zimiz ko'chadan pul yig'ib bitta nasos qo'yib olaylik, vodokanaldan umid yo'q",
            telegramMessageId: '501',
            originalTimestamp: '2026-09-15T14:00:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['WATER']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('evaluates generator proposal motivated by persistent blackouts as RELEVANT under ELECTRICITY', async () => {
          mockAdapter.setNextResponse({
            is_relevant: true,
            relevant_lanes: ['ELECTRICITY'],
            exclusion_reason: null,
            accepted_message_ids: ['502'],
            reasoning:
              "Proposes purchasing a generator due to grid power failure and lack of response from electric grid ('svetchilardan darak yo'q').",
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-15',
            contextRevision: 0,
            snapshotFingerprint: 'fp_elec_coping',
            evidence: [],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: "O'zimiz generator olmasak bo'lmaydi, svetchilardan darak yo'q",
            telegramMessageId: '502',
            originalTimestamp: '2026-09-15T14:10:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(true);
          expect(result.data.relevant_lanes).toEqual(['ELECTRICITY']);
          expect(result.data.exclusion_reason).toBeNull();
        });

        it('evaluates decorative landscaping wishlist without municipal failure as EXCLUDED (GENERAL_CHATTER)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning: 'Decorative landscaping proposal lacking an active municipal utility failure predicate.',
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-15',
            contextRevision: 0,
            snapshotFingerprint: 'fp_decor_coping',
            evidence: [],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: "Mahallani obodonlashtiraylik, yangi archalar ekaylik",
            telegramMessageId: '503',
            originalTimestamp: '2026-09-15T14:20:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
          expect(result.data.relevant_lanes).toHaveLength(0);
        });

        it('evaluates private road barrier proposal without Hokim appeal as EXCLUDED (GENERAL_CHATTER)', async () => {
          mockAdapter.setNextResponse({
            is_relevant: false,
            relevant_lanes: [],
            exclusion_reason: 'GENERAL_CHATTER',
            accepted_message_ids: [],
            reasoning: 'Private road gate idea without municipal utility breakdown or Hokim appeal.',
          });

          const snapshot: MahallaDailySnapshot = {
            districtId: 'dist_act_123',
            mahallaName: 'Navbahor',
            calendarDay: '2026-09-15',
            contextRevision: 0,
            snapshotFingerprint: 'fp_gate_coping',
            evidence: [],
          };

          const result = await evaluator.evaluateRelevance({
            candidateText: "Ko'chamizga bitta shlagbaum qo'ysak yaxshi bo'larmidi?",
            telegramMessageId: '504',
            originalTimestamp: '2026-09-15T14:30:00.000Z',
            contentType: 'TEXT',
            replyMetadata: null,
            snapshot,
            profileId: 'prof_rel_2026_08_v1',
          });

          expect(result.data.is_relevant).toBe(false);
          expect(result.data.exclusion_reason).toBe('GENERAL_CHATTER');
          expect(result.data.relevant_lanes).toHaveLength(0);
        });
      });
    });
  });
});

