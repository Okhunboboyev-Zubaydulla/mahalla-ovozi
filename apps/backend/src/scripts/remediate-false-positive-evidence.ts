/**
 * Standalone Data Remediation Script
 * Remediates erroneously analyzed false-positive messages from client dashboard topics:
 *
 * 1. Electricity topic (Катта Қишлоқ МФЙ):
 *    - Removes non-civic chatter ("Stansada nos sotetkanlani...", "Qanchayakan") from accepted_evidence
 *    - Marks corresponding telegram_intake_records as EXCLUDED (GENERAL_CHATTER)
 *    - Re-projects topic: evidence_count becomes 1, latest_update cleared to null
 *
 * 2. Gas topic (Раваллик ва Яккакайрогоч МФЙ):
 *    - Removes prosecutor inquiry ("Ушбу Ким ошдига прокурор назорат...") & reply from accepted_evidence
 *    - Marks corresponding telegram_intake_records as EXCLUDED (GENERAL_CHATTER)
 *    - Re-projects topic: HOKIM_RELATED lane removed, is_hokim_related set to false, ungrounded Hokim claims sanitized
 *
 * Usage:
 *   # Dry-run inspection (default):
 *   pnpm --filter @mahalla-ovozi/backend exec tsx src/scripts/remediate-false-positive-evidence.ts --dry-run
 *
 *   # Apply remediation to database:
 *   pnpm --filter @mahalla-ovozi/backend exec tsx src/scripts/remediate-false-positive-evidence.ts --execute
 */
import crypto from 'node:crypto';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  createDbPool,
  createDbClient,
  resolveDatabaseUrl,
  maskDatabaseUrl,
  type DbClient,
} from '../adapters/db/client.js';
import {
  createBossClient,
  JobSingletonKeys,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  type TelegramTopicProjectionJobData,
} from '../adapters/jobs/boss-client.js';
import {
  TopicProjectionEvaluator,
  sanitizeUngroundedHokimSummary,
} from '../modules/topics/topic-projection-evaluator.js';
import { buildHokimTermsRegex } from '../modules/topics/topic-evidence-service.js';
import { AiGateway } from '../modules/ai/ai-gateway.js';
import { HttpProviderAdapter } from '../adapters/ai-providers/http-provider-adapter.js';
import { getMahallaDailySnapshot } from '../modules/ai/context-snapshot.js';
import {
  DEFAULT_HOKIM_RECOGNITION_TERMS,
  type QualifyingLane,
} from '@mahalla-ovozi/api-contracts';

export interface RemediationOptions {
  execute: boolean;
  dryRun: boolean;
  skipAi?: boolean;
  topicId?: string;
  mahalla?: string;
}

export interface FalsePositiveRule {
  targetLabel: string;
  lane: 'ELECTRICITY' | 'GAS';
  mahallaKeywords: string[];
  messagePatterns: RegExp[];
  exclusionReason: string;
  reasoning: string;
}

export const FALSE_POSITIVE_RULES: FalsePositiveRule[] = [
  {
    targetLabel: 'Electricity (Катта Қишлоқ МФЙ) - Street Vendor Chatter',
    lane: 'ELECTRICITY',
    mahallaKeywords: ['катта қишлоқ', 'катта кишлок', 'katta qishloq', 'katta qishloq mfy'],
    messagePatterns: [
      /stansada\s+nos\s+sotetkanlani/i,
      /nos\s+sotetkanlani/i,
      /nos\s+sot/i,
      /qanchayakan/i,
    ],
    exclusionReason: 'GENERAL_CHATTER',
    reasoning: 'Ушбу хабар кўча савдоси/шахсий ёзишма бўлиб, электр таъминоти узилишига алоқадор эмас.',
  },
  {
    targetLabel: 'Gas (Раваллик ва Яккакайрогоч МФЙ) - Prosecutor/Auction Inquiry & Discussion',
    lane: 'GAS',
    mahallaKeywords: ['раваллик', 'яккакайрогоч', 'ravallik', 'yakkakayrog', 'yakkakayrogoch'],
    messagePatterns: [
      /ким\s+ошдига\s+прокурор\s+назорат/iu,
      /прокурор\s+назорат/iu,
      /ким\s+ошдига/iu,
      /олимжон\s+ака\s+худди\s+шу\s+ака\s+тураев\s+тулкин/iu,
      /тураев\s+тулкин/iu,
      /олимжон\s+ака/iu,
    ],
    exclusionReason: 'GENERAL_CHATTER',
    reasoning: 'Ушбу хабар аукцион ва прокурор назоратига оид муҳокама бўлиб, газ тармоғидаги техник муаммога алоқадор эмас.',
  },
];

export interface EvidenceMatch {
  evidenceId: string;
  topicId: string;
  intakeRecordId: string;
  mahallaName: string;
  verbatimText: string;
  telegramMessageId: string;
  originalTimestamp: Date;
  matchedRule: FalsePositiveRule;
}

export interface TopicRemediationReport {
  topicId: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  primaryLane: string;
  beforeEvidenceCount: number;
  afterEvidenceCount: number;
  remediatedEvidenceIds: string[];
  remediatedIntakeIds: string[];
  beforeProjection: {
    lanes: QualifyingLane[];
    isHokimRelated: boolean;
    latestUpdate: string | null;
    summary: string;
  } | null;
  afterProjection: {
    lanes: QualifyingLane[];
    isHokimRelated: boolean;
    latestUpdate: string | null;
    summary: string;
  } | null;
  reprojectionMode: 'AI_REPROJECTED' | 'DETERMINISTIC_UPDATED' | 'QUEUED_BOSS' | 'SKIPPED';
}

export interface RemediationResult {
  dryRun: boolean;
  totalEvidenceScanned: number;
  matchedEvidenceCount: number;
  affectedTopicsCount: number;
  reports: TopicRemediationReport[];
}

export function parseRemediationArgs(args: string[]): RemediationOptions {
  let execute = false;
  let dryRun = false;
  let skipAi = false;
  let topicId: string | undefined = undefined;
  let mahalla: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: pnpm exec tsx src/scripts/remediate-false-positive-evidence.ts [options]

Options:
  --dry-run              Inspect and report erroneous evidence without DB writes (default)
  --execute, --apply     Apply evidence remediation and trigger topic re-projections
  --skip-ai              Skip calling external AI APIs; apply deterministic projection cleanup & queue jobs
  --topic-id=<id>        Remediate only a specific topic ID
  --mahalla=<name>       Filter by mahalla name
  --help, -h             Show this help guide
      `.trim());
      process.exit(0);
    }

    if (arg === '--execute' || arg === '--apply') {
      execute = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--skip-ai') {
      skipAi = true;
    } else if (arg.startsWith('--topic-id=')) {
      topicId = arg.split('=')[1]?.trim();
    } else if (arg.startsWith('--mahalla=')) {
      mahalla = arg.split('=')[1]?.trim();
    }
  }

  if (!execute) {
    dryRun = true;
  }

  return { execute, dryRun, skipAi, topicId, mahalla };
}

/**
 * Checks whether an evidence text and topic match any of the false-positive rules.
 */
export function matchFalsePositiveRule(
  verbatimText: string,
  mahallaName: string,
  primaryLane: string,
): FalsePositiveRule | null {
  const normMahalla = mahallaName.toLowerCase();
  for (const rule of FALSE_POSITIVE_RULES) {
    const mahallaMatches = rule.mahallaKeywords.some((kw) => normMahalla.includes(kw));
    const laneMatches = rule.lane === primaryLane;

    // Must match either the mahalla or lane + pattern
    if (mahallaMatches || laneMatches) {
      const textMatches = rule.messagePatterns.some((pattern) => pattern.test(verbatimText));
      if (textMatches) {
        return rule;
      }
    }
  }
  return null;
}

/**
 * Determines the genuine civic lane for a topic whose evidence was misclassified or remediated.
 * Prioritizes keyword detection in surviving evidence text, falling back to matched rule lane.
 */
export function detectSurvivingLane(
  evidence: Array<{ verbatimText: string }>,
  mahallaName: string,
): QualifyingLane {
  const combined = evidence.map((e) => e.verbatimText).join(' ').toLowerCase();

  // 1. Gas indicators
  if (/(?:^|\b|[^\p{L}])(?:газ|gaz|hududgaz|ҳудудгаз)(?:[^\p{L}]|\b|$)/iu.test(combined)) {
    return 'GAS';
  }
  // 2. Electricity indicators
  if (/(?:^|\b|[^\p{L}])(?:свет|chiroq|чироқ|электр|tok|трансформатор|svet)(?:[^\p{L}]|\b|$)/iu.test(combined)) {
    return 'ELECTRICITY';
  }
  // 3. Water indicators
  if (/(?:^|\b|[^\p{L}])(?:сув|suv|vodokanal|водоканал)(?:[^\p{L}]|\b|$)/iu.test(combined)) {
    return 'WATER';
  }
  // 4. Waste indicators
  if (/(?:^|\b|[^\p{L}])(?:чиқинди|ахлат|musor|chiqindi|axlat|toza hudud|тоза ҳудуд)(?:[^\p{L}]|\b|$)/iu.test(combined)) {
    return 'WASTE';
  }

  // 5. Fall back to target rule lane if mahalla matches a known remediation rule
  const normMahalla = mahallaName.toLowerCase();
  for (const rule of FALSE_POSITIVE_RULES) {
    if (rule.mahallaKeywords.some((kw) => normMahalla.includes(kw))) {
      return rule.lane;
    }
  }

  return 'GAS';
}

/**
 * Core remediation implementation.
 */
export async function remediateFalsePositiveEvidence(
  deps: {
    db: DbClient;
    pool: pg.Pool;
    boss?: PgBoss | null;
  },
  options: RemediationOptions,
): Promise<RemediationResult> {
  const { db, pool, boss } = deps;
  const { dryRun, skipAi, topicId: filterTopicId, mahalla: filterMahalla } = options;

  console.log('===================================================================');
  console.log('  Mahalla Ovozi: False-Positive Evidence Remediation Engine       ');
  console.log('===================================================================');
  console.log(`Mode:       ${dryRun ? '🔍 DRY-RUN (Preview Only - No DB writes)' : '⚡ EXECUTE (Mutating database)'}`);
  console.log(`Skip AI:    ${skipAi ? 'YES (Deterministic updates & queueing only)' : 'NO (Will evaluate AI projections if configured)'}`);
  if (filterTopicId) console.log(`Topic ID:   ${filterTopicId}`);
  if (filterMahalla) console.log(`Mahalla:    ${filterMahalla}`);
  console.log('-------------------------------------------------------------------\n');

  // 1. Fetch all accepted evidence joining topics and topic projections
  const query = `
    SELECT 
      ae.id AS "evidenceId",
      ae.topic_id AS "topicId",
      ae.intake_record_id AS "intakeRecordId",
      ae.mahalla_name AS "mahallaName",
      ae.verbatim_text AS "verbatimText",
      ae.telegram_message_id AS "telegramMessageId",
      ae.original_timestamp AS "originalTimestamp",
      t.primary_lane AS "primaryLane",
      t.district_id AS "districtId",
      t.calendar_day AS "calendarDay",
      t.required_derived_generation AS "requiredDerivedGeneration",
      t.applied_derived_generation AS "appliedDerivedGeneration",
      tp.id AS "projectionId",
      tp.summary AS "summary",
      tp.latest_update AS "latestUpdate",
      tp.lanes AS "lanes",
      tp.is_hokim_related AS "isHokimRelated",
      tp.anchor_evidence_id AS "anchorEvidenceId"
    FROM accepted_evidence ae
    JOIN topics t ON ae.topic_id = t.id
    LEFT JOIN topic_projections tp ON tp.topic_id = t.id
    ORDER BY ae.topic_id, ae.original_timestamp ASC
  `;

  const { rows: allRows } = await pool.query<{
    evidenceId: string;
    topicId: string;
    intakeRecordId: string;
    mahallaName: string;
    verbatimText: string;
    telegramMessageId: string;
    originalTimestamp: Date;
    primaryLane: string;
    districtId: string;
    calendarDay: string;
    requiredDerivedGeneration: number;
    appliedDerivedGeneration: number;
    projectionId: string | null;
    summary: string | null;
    latestUpdate: string | null;
    lanes: QualifyingLane[] | null;
    isHokimRelated: boolean | null;
    anchorEvidenceId: string | null;
  }>(query);

  // Group by topic
  const topicMap = new Map<string, typeof allRows>();
  for (const row of allRows) {
    if (filterTopicId && row.topicId !== filterTopicId) continue;
    if (filterMahalla && !row.mahallaName.toLowerCase().includes(filterMahalla.toLowerCase())) continue;

    const list = topicMap.get(row.topicId) ?? [];
    list.push(row);
    topicMap.set(row.topicId, list);
  }

  const reports: TopicRemediationReport[] = [];
  let totalMatchedEvidence = 0;

  for (const [topicId, evidenceList] of topicMap.entries()) {
    const firstRow = evidenceList[0];
    if (!firstRow) continue;

    const districtId = firstRow.districtId;
    const mahallaName = firstRow.mahallaName;
    const calendarDay = firstRow.calendarDay;
    const primaryLane = firstRow.primaryLane;

    const matchedEvidence: EvidenceMatch[] = [];
    const genuineEvidence: typeof evidenceList = [];

    for (const ev of evidenceList) {
      const rule = matchFalsePositiveRule(ev.verbatimText, ev.mahallaName, ev.primaryLane);
      if (rule) {
        matchedEvidence.push({
          evidenceId: ev.evidenceId,
          topicId: ev.topicId,
          intakeRecordId: ev.intakeRecordId,
          mahallaName: ev.mahallaName,
          verbatimText: ev.verbatimText,
          telegramMessageId: ev.telegramMessageId,
          originalTimestamp: ev.originalTimestamp,
          matchedRule: rule,
        });
      } else {
        genuineEvidence.push(ev);
      }
    }

    const hokimRegex = buildHokimTermsRegex(DEFAULT_HOKIM_RECOGNITION_TERMS);
    const hasHokimEvidence = genuineEvidence.some((ev) => hokimRegex.test(ev.verbatimText));

    const isMisclassifiedHokimTopic =
      primaryLane === 'HOKIM_RELATED' &&
      !hasHokimEvidence &&
      genuineEvidence.length > 0;

    if (matchedEvidence.length === 0 && !isMisclassifiedHokimTopic) {
      continue;
    }

    const targetLane: QualifyingLane =
      primaryLane === 'HOKIM_RELATED' || isMisclassifiedHokimTopic
        ? detectSurvivingLane(genuineEvidence, mahallaName)
        : (primaryLane as QualifyingLane);

    totalMatchedEvidence += matchedEvidence.length;

    const beforeProjection = firstRow.summary
      ? {
          lanes: firstRow.lanes || [primaryLane as QualifyingLane],
          isHokimRelated: firstRow.isHokimRelated ?? false,
          latestUpdate: firstRow.latestUpdate,
          summary: firstRow.summary,
        }
      : null;

    console.log(`\n-------------------------------------------------------------------`);
    console.log(`📌 Target Topic Found: ${topicId} [${primaryLane}${primaryLane !== targetLane ? ` -> ${targetLane}` : ''}] - "${mahallaName}"`);
    console.log(`   Total Evidence in Topic:    ${evidenceList.length}`);
    console.log(`   False-Positives to Remove:  ${matchedEvidence.length}`);
    console.log(`   Genuine Evidence Remaining: ${genuineEvidence.length}`);
    if (isMisclassifiedHokimTopic) {
      console.log(`   ⚠️  Detected misclassified Hokim topic without Hokim evidence. Correcting lane to [${targetLane}].`);
    }
    for (const m of matchedEvidence) {
      console.log(`   ❌ [MATCH] Evidence ${m.evidenceId} (Msg #${m.telegramMessageId}): "${m.verbatimText.slice(0, 60)}..."`);
      console.log(`      Matched Rule: ${m.matchedRule.targetLabel}`);
    }

    const report: TopicRemediationReport = {
      topicId,
      districtId,
      mahallaName,
      calendarDay,
      primaryLane: targetLane,
      beforeEvidenceCount: evidenceList.length,
      afterEvidenceCount: genuineEvidence.length,
      remediatedEvidenceIds: matchedEvidence.map((m) => m.evidenceId),
      remediatedIntakeIds: matchedEvidence.map((m) => m.intakeRecordId),
      beforeProjection,
      afterProjection: null,
      reprojectionMode: 'SKIPPED',
    };

    if (dryRun) {
      if (matchedEvidence.length > 0) {
        console.log(`   🔍 [DRY-RUN] Would delete ${matchedEvidence.length} evidence records.`);
        console.log(`   🔍 [DRY-RUN] Would set ${matchedEvidence.length} intake records to EXCLUDED / GENERAL_CHATTER.`);
      }
      if (primaryLane !== targetLane) {
        console.log(`   🔍 [DRY-RUN] Would update topic primary_lane: "${primaryLane}" -> "${targetLane}".`);
      }
      console.log(`   🔍 [DRY-RUN] Would re-project topic ${topicId} with ${genuineEvidence.length} remaining evidence items into lane "${targetLane}".`);
      reports.push(report);
      continue;
    }

    // --- EXECUTION PHASE ---
    const evIdsToDelete = matchedEvidence.map((m) => m.evidenceId);
    const intakeIdsToExclude = matchedEvidence.map((m) => m.intakeRecordId);
    const nextGeneration = (firstRow.requiredDerivedGeneration ?? 0) + 1;

    let safeAnchorId = genuineEvidence[0]?.evidenceId;

    // Transactional evidence cleanup & intake exclusion
    const executeCleanup = async (client: pg.PoolClient) => {
      // 1. Referential integrity: if current projection anchor is being deleted or topic lane changed, re-anchor to remaining genuine evidence
      if (
        safeAnchorId &&
        firstRow.projectionId &&
        (evIdsToDelete.includes(firstRow.anchorEvidenceId ?? '') ||
          !firstRow.anchorEvidenceId ||
          primaryLane !== targetLane)
      ) {
        await client.query(
          `UPDATE topic_projections 
           SET anchor_evidence_id = $1, updated_at = NOW() 
           WHERE topic_id = $2`,
          [safeAnchorId, topicId],
        );
      } else if (!safeAnchorId && firstRow.projectionId) {
        // If no evidence remains (rare/abnormal), delete projection
        await client.query(`DELETE FROM topic_projections WHERE topic_id = $1`, [topicId]);
      }

      // 2. Delete false-positive evidence rows (if any)
      if (evIdsToDelete.length > 0) {
        await client.query(
          `DELETE FROM accepted_evidence WHERE id = ANY($1::text[])`,
          [evIdsToDelete],
        );
      }

      // 3. Mark intake records as EXCLUDED / GENERAL_CHATTER (if any)
      if (intakeIdsToExclude.length > 0) {
        const exclusionPayload = JSON.stringify({
          status: 'EXCLUDED',
          exclusionReason: 'GENERAL_CHATTER',
          remediatedAt: new Date().toISOString(),
          remediationReason: 'Remediated false-positive civic evidence via data remediation script',
        });

        await client.query(
          `UPDATE telegram_intake_records
           SET status = 'EXCLUDED',
               raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $1::jsonb,
               updated_at = NOW()
           WHERE id = ANY($2::text[])`,
          [exclusionPayload, intakeIdsToExclude],
        );
      }

      // 4. Update topic's primary_lane, latestRelevantEvidenceTimestamp & bump required generation
      if (genuineEvidence.length > 0) {
        const { rows: maxRows } = await client.query<{ maxTs: Date }>(
          `SELECT MAX(original_timestamp) as "maxTs" FROM accepted_evidence WHERE topic_id = $1`,
          [topicId],
        );
        const maxTs = maxRows[0]?.maxTs ?? new Date();

        await client.query(
          `UPDATE topics 
           SET primary_lane = $1,
               latest_relevant_evidence_timestamp = $2,
               required_derived_generation = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [targetLane, maxTs, nextGeneration, topicId],
        );
      }
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await executeCleanup(client);
      await client.query('COMMIT');
      if (evIdsToDelete.length > 0) {
        console.log(`   ✅ Removed ${evIdsToDelete.length} false-positive evidence records from DB.`);
        console.log(`   ✅ Marked ${intakeIdsToExclude.length} intake records as EXCLUDED (GENERAL_CHATTER).`);
      }
      if (primaryLane !== targetLane) {
        console.log(`   ✅ Corrected topic primary_lane: "${primaryLane}" -> "${targetLane}".`);
      }
    } catch (cleanErr) {
      await client.query('ROLLBACK');
      console.error(`   ❌ Failed to clean up evidence for topic ${topicId}:`, cleanErr);
      throw cleanErr;
    } finally {
      client.release();
    }

    // --- RE-PROJECTION PHASE ---
    let reprojected = false;

    // Check if AI re-projection is possible
    const hasAiKey =
      !skipAi &&
      Boolean(
        process.env.DEEPINFRA_API_KEY ||
          process.env.OPENAI_API_KEY ||
          process.env.GEMINI_API_KEY,
      );

    if (hasAiKey) {
      try {
        console.log(`   🤖 Executing AI Topic Projection recalculation...`);
        const aiProviderAdapters = new Map<string, HttpProviderAdapter>([
          ['OPENAI', new HttpProviderAdapter('OPENAI')],
          ['GEMINI', new HttpProviderAdapter('GEMINI')],
          ['DEEPINFRA', new HttpProviderAdapter('DEEPINFRA')],
          ['OLLAMA', new HttpProviderAdapter('OLLAMA')],
        ]);
        const aiGateway = new AiGateway({ db, customAdapters: aiProviderAdapters });
        const evaluator = new TopicProjectionEvaluator(aiGateway);

        const snapshot = await getMahallaDailySnapshot(db, districtId, mahallaName, calendarDay);

        const evaluation = await evaluator.evaluateTopicProjection({
          topicId,
          primaryLane: targetLane,
          generation: nextGeneration,
          snapshot,
        });

        // Commit evaluation directly to topic_projections
        const projectionOpId = `aiop_${crypto.randomUUID()}`;
        const targetId = `${topicId}:${nextGeneration}`;

        await pool.query(
          `INSERT INTO ai_operations (
             id, district_id, mahalla_name, calendar_day, operation_type, target_id,
             pinned_profile_id, context_revision, snapshot_fingerprint, final_status, result_payload
           ) VALUES ($1, $2, $3, $4, 'TOPIC_DERIVED_PROJECTION', $5, $6, $7, $8, 'COMPLETED', $9)
           ON CONFLICT (district_id, operation_type, target_id) DO UPDATE SET
             pinned_profile_id = EXCLUDED.pinned_profile_id,
             context_revision = EXCLUDED.context_revision,
             snapshot_fingerprint = EXCLUDED.snapshot_fingerprint,
             final_status = 'COMPLETED',
             result_payload = EXCLUDED.result_payload,
             updated_at = NOW()`,
          [
            projectionOpId,
            districtId,
            mahallaName,
            calendarDay,
            targetId,
            evaluation.aiResult.profileId,
            snapshot.contextRevision,
            snapshot.snapshotFingerprint,
            JSON.stringify(evaluation),
          ],
        );

        await pool.query(
          `INSERT INTO topic_projections (
             id, topic_id, district_id, mahalla_name, calendar_day,
             summary, latest_update, lanes, primary_lane, anchor_evidence_id,
             anchor_quote, latest_meaningful_activity_timestamp, attribution,
             is_hokim_related, generation, ai_profile_id, ai_operation_id,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
           ON CONFLICT (topic_id) DO UPDATE SET
             summary = EXCLUDED.summary,
             latest_update = EXCLUDED.latest_update,
             lanes = EXCLUDED.lanes,
             primary_lane = EXCLUDED.primary_lane,
             anchor_evidence_id = EXCLUDED.anchor_evidence_id,
             anchor_quote = EXCLUDED.anchor_quote,
             latest_meaningful_activity_timestamp = EXCLUDED.latest_meaningful_activity_timestamp,
             attribution = EXCLUDED.attribution,
             is_hokim_related = EXCLUDED.is_hokim_related,
             generation = EXCLUDED.generation,
             ai_profile_id = EXCLUDED.ai_profile_id,
             ai_operation_id = EXCLUDED.ai_operation_id,
             updated_at = NOW()`,
          [
            `prj_${crypto.randomUUID()}`,
            topicId,
            districtId,
            mahallaName,
            calendarDay,
            evaluation.summary,
            evaluation.latestUpdate,
            JSON.stringify(evaluation.lanes),
            targetLane,
            evaluation.anchorEvidenceId,
            evaluation.anchorQuote,
            evaluation.latestMeaningfulActivityTimestamp,
            evaluation.attribution,
            evaluation.isHokimRelated,
            nextGeneration,
            evaluation.aiResult.profileId,
            projectionOpId,
          ],
        );

        await pool.query(
          `UPDATE topics SET applied_derived_generation = $1, updated_at = NOW() WHERE id = $2`,
          [nextGeneration, topicId],
        );

        report.afterProjection = {
          lanes: evaluation.lanes,
          isHokimRelated: evaluation.isHokimRelated,
          latestUpdate: evaluation.latestUpdate,
          summary: evaluation.summary,
        };
        report.reprojectionMode = 'AI_REPROJECTED';
        reprojected = true;
        console.log(`   ✨ [AI RE-PROJECTED] Updated summary: "${evaluation.summary}"`);
        console.log(`      Lanes: [${evaluation.lanes.join(', ')}], Hokim: ${evaluation.isHokimRelated}, Latest Update: ${evaluation.latestUpdate ?? 'null'}`);
      } catch (aiErr) {
        console.warn(`   ⚠️  AI re-projection evaluation encountered an error:`, aiErr);
      }
    }

    // Deterministic projection cleanup if AI evaluation was skipped or failed
    if (!reprojected) {
      console.log(`   🛡️ Applying deterministic projection sanitation...`);
      const existingSummary = firstRow.summary ?? 'Коммунал хизмат кўрсатиш тизимида узилиш кузатилмоқда';
      let sanitizedSummary = sanitizeUngroundedHokimSummary(existingSummary);

      if (targetLane === 'GAS') {
        if (/ҳокимлик|мутасаддилар/iu.test(existingSummary) || /газ таъминоти/iu.test(sanitizedSummary)) {
          sanitizedSummary = 'Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда.';
        }
      } else if (targetLane === 'ELECTRICITY') {
        if (/ҳокимлик|мутасаддилар/iu.test(existingSummary) || /электр таъминоти/iu.test(sanitizedSummary)) {
          sanitizedSummary = 'Электр таъминотида узилиш юз бергани хабар қилинмоқда.';
        }
      }

      let updatedLanes: QualifyingLane[] = (firstRow.lanes || [targetLane]).filter(
        (l) => l !== 'HOKIM_RELATED',
      );
      if (!updatedLanes.includes(targetLane)) {
        updatedLanes.push(targetLane);
      }

      // If target topic has only 1 message, latest_update is strictly null
      const updatedLatestUpdate =
        genuineEvidence.length <= 1
          ? null
          : firstRow.latestUpdate
            ? sanitizeUngroundedHokimSummary(firstRow.latestUpdate)
            : null;

      const fallbackAnchor = safeAnchorId ?? firstRow.anchorEvidenceId ?? firstRow.evidenceId;

      await pool.query(
        `UPDATE topic_projections
         SET summary = $1,
             latest_update = $2,
             lanes = $3,
             primary_lane = $4,
             is_hokim_related = false,
             anchor_evidence_id = $5,
             generation = $6,
             updated_at = NOW()
         WHERE topic_id = $7`,
        [
          sanitizedSummary,
          updatedLatestUpdate,
          JSON.stringify(updatedLanes),
          targetLane,
          fallbackAnchor,
          nextGeneration,
          topicId,
        ],
      );

      await pool.query(
        `UPDATE topics SET applied_derived_generation = $1, updated_at = NOW() WHERE id = $2`,
        [nextGeneration, topicId],
      );

      report.afterProjection = {
        lanes: updatedLanes,
        isHokimRelated: false,
        latestUpdate: updatedLatestUpdate,
        summary: sanitizedSummary,
      };
      report.reprojectionMode = 'DETERMINISTIC_UPDATED';

      console.log(`   🛡️ [DETERMINISTIC UPDATED] Summary: "${sanitizedSummary}"`);
      console.log(`      Lanes: [${updatedLanes.join(', ')}], Hokim: false, Latest Update: ${updatedLatestUpdate ?? 'null'}`);
    }

    // Enqueue boss job if pg-boss is available
    if (boss) {
      try {
        const jobData: TelegramTopicProjectionJobData = {
          topicId,
          districtId,
          mahallaName,
          calendarDay,
          generation: nextGeneration,
        };
        const singletonKey = JobSingletonKeys.forTopicProjection(topicId, nextGeneration);
        await boss.send(TELEGRAM_TOPIC_PROJECTION_QUEUE, jobData, {
          singletonKey,
          retryLimit: 3,
        });
        console.log(`   📬 Enqueued topic projection job to pg-boss (generation ${nextGeneration}).`);
      } catch (bossErr) {
        console.warn(`   ⚠️ Failed to enqueue pg-boss job:`, bossErr);
      }
    }

    reports.push(report);
  }

  const result: RemediationResult = {
    dryRun,
    totalEvidenceScanned: allRows.length,
    matchedEvidenceCount: totalMatchedEvidence,
    affectedTopicsCount: reports.length,
    reports,
  };

  console.log('\n===================================================================');
  console.log('  Remediation Summary Report');
  console.log('===================================================================');
  console.log(`- Mode:                     ${dryRun ? 'DRY-RUN (Preview)' : 'EXECUTE (Applied)'}`);
  console.log(`- Total Evidence Scanned:   ${result.totalEvidenceScanned}`);
  console.log(`- Erroneous Records Found:  ${result.matchedEvidenceCount}`);
  console.log(`- Affected Topics:          ${result.affectedTopicsCount}`);
  for (const r of reports) {
    console.log(`  * Topic ${r.topicId} (${r.primaryLane}): ${r.beforeEvidenceCount} -> ${r.afterEvidenceCount} evidence items [${r.reprojectionMode}]`);
  }
  console.log('===================================================================\n');

  return result;
}

/**
 * Top-level CLI entry point.
 */
export async function main(): Promise<void> {
  const options = parseRemediationArgs(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();

  console.log(`Connecting to: ${maskDatabaseUrl(databaseUrl)}...`);
  const pool = createDbPool(databaseUrl);
  const db = createDbClient(pool);

  let boss: PgBoss | null = null;
  try {
    boss = createBossClient({ connectionString: databaseUrl });
    await boss.start();
  } catch (bErr) {
    // Non-fatal if pg-boss cannot connect in standalone script
    boss = null;
  }

  try {
    await remediateFalsePositiveEvidence({ db, pool, boss }, options);
  } finally {
    if (boss) {
      try {
        await boss.stop();
      } catch {}
    }
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.includes('remediate-false-positive-evidence');
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error in remediation script:', err);
    process.exit(1);
  });
}
