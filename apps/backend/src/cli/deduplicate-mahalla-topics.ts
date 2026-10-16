import type pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  canonicalizeMahallaName,
  normalizeMahallaName,
  ensureOfficialMahallaSuffix,
} from '@mahalla-ovozi/api-contracts';
import { createDbPool, resolveDatabaseUrl, maskDatabaseUrl } from '../adapters/db/client.js';
import {
  createBossClient,
  JobSingletonKeys,
  TELEGRAM_TOPIC_PROJECTION_QUEUE,
  type TelegramTopicProjectionJobData,
} from '../adapters/jobs/boss-client.js';

export interface DeduplicateCliOptions {
  execute: boolean;
  dryRun: boolean;
  districtId?: string;
}

export interface DeduplicationSummary {
  dryRun: boolean;
  targetDistrictId?: string;
  groupsScanned: number;
  groupsNormalized: number;
  groupsCollided: number;
  topicsScanned: number;
  clustersWithDuplicates: number;
  duplicateTopicsRemoved: number;
  evidenceRecordsMoved: number;
  projectionsDeleted: number;
  singleTopicsNormalized: number;
  projectionJobsEnqueued: number;
  durationMs: number;
}

export interface TopicRecord {
  id: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  primaryLane: string;
  status: string;
  requiredDerivedGeneration: number;
  appliedDerivedGeneration: number;
  latestRelevantEvidenceTimestamp: Date;
  retentionExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupRecord {
  id: string;
  districtId: string;
  mahallaName: string;
}

export function parseCliArgs(args: string[]): DeduplicateCliOptions {
  let execute = false;
  let dryRun = false;
  let districtId: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: pnpm cli:deduplicate-topics [options]

Options:
  --dry-run              Preview duplicates and planned merges without modifying the database (default)
  --execute              Apply topic deduplication and group normalization inside atomic transactions
  --districtId=<id>      Target a specific district ID (also accepts --district=<id>)
  --help, -h             Show this help guide
      `.trim());
      process.exit(0);
    }

    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--districtId=')) {
      districtId = arg.split('=')[1]?.trim() || undefined;
    } else if (arg.startsWith('--district=')) {
      districtId = arg.split('=')[1]?.trim() || undefined;
    } else if ((arg === '--districtId' || arg === '--district') && i + 1 < args.length) {
      districtId = args[++i]?.trim() || undefined;
    }
  }

  // Safety Default: If neither --execute nor --dry-run is specified, default to dry-run
  if (!execute) {
    dryRun = true;
  }

  return { execute, dryRun, districtId };
}

/**
 * Selects the primary topic from a cluster of duplicates:
 * 1. Prefer a topic whose mahallaName exactly equals ensureOfficialMahallaSuffix(canonicalizeMahallaName(mahallaName)).
 * 2. If multiple or none match, pick the topic with the earliest createdAt timestamp (tie-break by id).
 */
export function selectPrimaryTopic(cluster: TopicRecord[]): TopicRecord {
  if (cluster.length === 0) {
    throw new Error('Cannot select primary topic from empty cluster');
  }

  const officialMatches = cluster.filter(
    (t) => t.mahallaName === ensureOfficialMahallaSuffix(canonicalizeMahallaName(t.mahallaName)),
  );

  const candidates = officialMatches.length > 0 ? officialMatches : cluster;

  return [...candidates].sort((a, b) => {
    const diff = a.createdAt.getTime() - b.createdAt.getTime();
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  })[0]!;
}

/**
 * Core deduplication and normalization engine.
 */
export async function deduplicateMahallaTopics(
  pool: pg.Pool,
  options: DeduplicateCliOptions,
  boss?: PgBoss | null,
): Promise<DeduplicationSummary> {
  const startTime = Date.now();
  const { execute, dryRun, districtId } = options;

  const summary: DeduplicationSummary = {
    dryRun,
    targetDistrictId: districtId,
    groupsScanned: 0,
    groupsNormalized: 0,
    groupsCollided: 0,
    topicsScanned: 0,
    clustersWithDuplicates: 0,
    duplicateTopicsRemoved: 0,
    evidenceRecordsMoved: 0,
    projectionsDeleted: 0,
    singleTopicsNormalized: 0,
    projectionJobsEnqueued: 0,
    durationMs: 0,
  };

  console.log('=============================================================');
  console.log('  Mahalla Ovozi: Mahalla Name Deduplication & Consolidation  ');
  console.log('=============================================================');
  console.log(`Execution Mode:  ${dryRun ? '🔍 DRY-RUN (Preview Only - No DB Writes)' : '⚡ EXECUTE (Transactions will mutate database)'}`);
  console.log(`Target District: ${districtId ? districtId : 'ALL Registered Districts'}\n`);

  // -------------------------------------------------------------------------
  // Step 1: Scan & Normalize district_telegram_groups
  // -------------------------------------------------------------------------
  console.log('--- Step 1: Scanning District Telegram Groups ---');
  const groupQuery = districtId
    ? `SELECT id, district_id AS "districtId", mahalla_name AS "mahallaName"
       FROM district_telegram_groups
       WHERE district_id = $1
       ORDER BY district_id, id`
    : `SELECT id, district_id AS "districtId", mahalla_name AS "mahallaName"
       FROM district_telegram_groups
       ORDER BY district_id, id`;

  const groupParams = districtId ? [districtId] : [];
  const groupRes = await pool.query<GroupRecord>(groupQuery, groupParams);
  summary.groupsScanned = groupRes.rows.length;

  for (const group of groupRes.rows) {
    const official = ensureOfficialMahallaSuffix(canonicalizeMahallaName(group.mahallaName));
    if (official !== group.mahallaName) {
      // Check for collision with an existing group in the same district
      const collisionCheck = await pool.query(
        `SELECT id FROM district_telegram_groups
         WHERE district_id = $1 AND LOWER(mahalla_name) = LOWER($2) AND id != $3`,
        [group.districtId, official, group.id],
      );

      if (collisionCheck.rows.length > 0) {
        summary.groupsCollided++;
        console.warn(
          `  ⚠️  [GROUP COLLISION SKIPPED] Group ${group.id} (district ${group.districtId}) ` +
          `cannot be renamed to "${official}" because group ${collisionCheck.rows[0].id} ` +
          `already uses this mahalla name.`,
        );
        continue;
      }

      if (execute) {
        await pool.query(
          `UPDATE district_telegram_groups
           SET mahalla_name = $1, updated_at = NOW()
           WHERE id = $2`,
          [official, group.id],
        );
        console.log(`  ✅ [GROUP NORMALIZED] ${group.id}: "${group.mahallaName}" -> "${official}"`);
      } else {
        console.log(`  🔍 [DRY-RUN GROUP] Would normalize ${group.id}: "${group.mahallaName}" -> "${official}"`);
      }
      summary.groupsNormalized++;
    }
  }

  if (summary.groupsNormalized === 0 && summary.groupsCollided === 0) {
    console.log('  No uncanonical district telegram groups detected.');
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Step 2: Scan & Deduplicate Active Topics
  // -------------------------------------------------------------------------
  console.log('--- Step 2: Scanning Active Topics for Neighborhood Duplicates ---');
  const topicQuery = districtId
    ? `SELECT
         id,
         district_id AS "districtId",
         mahalla_name AS "mahallaName",
         calendar_day AS "calendarDay",
         primary_lane AS "primaryLane",
         status,
         required_derived_generation AS "requiredDerivedGeneration",
         applied_derived_generation AS "appliedDerivedGeneration",
         latest_relevant_evidence_timestamp AS "latestRelevantEvidenceTimestamp",
         retention_expires_at AS "retentionExpiresAt",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM topics
       WHERE status = 'ACTIVE' AND district_id = $1
       ORDER BY district_id, calendar_day, primary_lane, created_at ASC, id ASC`
    : `SELECT
         id,
         district_id AS "districtId",
         mahalla_name AS "mahallaName",
         calendar_day AS "calendarDay",
         primary_lane AS "primaryLane",
         status,
         required_derived_generation AS "requiredDerivedGeneration",
         applied_derived_generation AS "appliedDerivedGeneration",
         latest_relevant_evidence_timestamp AS "latestRelevantEvidenceTimestamp",
         retention_expires_at AS "retentionExpiresAt",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM topics
       WHERE status = 'ACTIVE'
       ORDER BY district_id, calendar_day, primary_lane, created_at ASC, id ASC`;

  const topicParams = districtId ? [districtId] : [];
  const topicRes = await pool.query<TopicRecord>(topicQuery, topicParams);
  summary.topicsScanned = topicRes.rows.length;

  // Group by (districtId, primaryLane, calendarDay)
  const partitionMap = new Map<string, TopicRecord[]>();
  for (const topic of topicRes.rows) {
    const partitionKey = `${topic.districtId}::${topic.primaryLane}::${topic.calendarDay}`;
    const list = partitionMap.get(partitionKey) ?? [];
    list.push(topic);
    partitionMap.set(partitionKey, list);
  }

  // Iterate partitions and cluster by normalized mahalla name
  for (const [, partitionTopics] of partitionMap) {
    const clusterMap = new Map<string, TopicRecord[]>();
    for (const topic of partitionTopics) {
      const canonicalKey = normalizeMahallaName(topic.mahallaName);
      const cluster = clusterMap.get(canonicalKey) ?? [];
      cluster.push(topic);
      clusterMap.set(canonicalKey, cluster);
    }

    for (const [, clusterTopics] of clusterMap) {
      if (clusterTopics.length > 1) {
        summary.clustersWithDuplicates++;
        const primary = selectPrimaryTopic(clusterTopics);
        const duplicateTopics = clusterTopics.filter((t) => t.id !== primary.id);
        const duplicateIds = duplicateTopics.map((d) => d.id);
        const officialName = ensureOfficialMahallaSuffix(canonicalizeMahallaName(primary.mahallaName));

        // Fetch evidence counts for diagnostic logging
        const evidenceCountsRes = await pool.query<{ topicId: string; count: number }>(
          `SELECT topic_id AS "topicId", COUNT(*)::int AS count
           FROM accepted_evidence
           WHERE topic_id = ANY($1::text[])
           GROUP BY topic_id`,
          [[primary.id, ...duplicateIds]],
        );

        const countMap = new Map<string, number>();
        for (const row of evidenceCountsRes.rows) {
          countMap.set(row.topicId, row.count);
        }

        const primaryCount = countMap.get(primary.id) ?? 0;
        const duplicatesEvidenceTotal = duplicateIds.reduce(
          (sum, id) => sum + (countMap.get(id) ?? 0),
          0,
        );

        console.log(`  📌 [DUPLICATE CLUSTER FOUND] "${officialName}"`);
        console.log(`     District: ${primary.districtId} | Lane: ${primary.primaryLane} | Day: ${primary.calendarDay}`);
        console.log(`     Primary:    ${primary.id} ("${primary.mahallaName}") [${primaryCount} evidence records]`);
        for (const dup of duplicateTopics) {
          console.log(`     Duplicate:  ${dup.id} ("${dup.mahallaName}") [${countMap.get(dup.id) ?? 0} evidence records]`);
        }

        if (dryRun) {
          console.log(`     Action:     Would reassign ${duplicatesEvidenceTotal} evidence items to ${primary.id}, delete ${duplicateTopics.length} duplicate topics, and increment required derived generation.`);
          summary.duplicateTopicsRemoved += duplicateTopics.length;
          summary.evidenceRecordsMoved += duplicatesEvidenceTotal;
        } else {
          // Atomic transaction to merge duplicate cluster
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            // 1. Move all accepted evidence pointing to duplicate topics
            const moveRes = await client.query(
              `UPDATE accepted_evidence
               SET topic_id = $1, mahalla_name = $2
               WHERE topic_id = ANY($3::text[])
               RETURNING id`,
              [primary.id, officialName, duplicateIds],
            );
            const movedEvidenceCount = moveRes.rowCount ?? 0;
            summary.evidenceRecordsMoved += movedEvidenceCount;

            // 2. Normalize mahalla_name on existing primary evidence
            await client.query(
              `UPDATE accepted_evidence
               SET mahalla_name = $1
               WHERE topic_id = $2 AND mahalla_name != $1`,
              [officialName, primary.id],
            );

            // 3. Compute latest evidence timestamp and evidence count on consolidated primary
            const statsRes = await client.query<{ count: number; latestTimestamp: Date | null }>(
              `SELECT COUNT(*)::int AS count, MAX(original_timestamp) AS "latestTimestamp"
               FROM accepted_evidence
               WHERE topic_id = $1`,
              [primary.id],
            );
            const totalEvidenceCount = statsRes.rows[0]?.count ?? 0;
            const latestTimestamp = statsRes.rows[0]?.latestTimestamp ?? primary.latestRelevantEvidenceTimestamp;

            // Compute maximum retention expiry among primary and duplicates
            const allExpiryTimes = [
              new Date(primary.retentionExpiresAt).getTime(),
              ...duplicateTopics.map((d) => new Date(d.retentionExpiresAt).getTime()),
            ];
            const maxRetentionExpiry = new Date(Math.max(...allExpiryTimes));

            const newGeneration = (primary.requiredDerivedGeneration ?? 0) + 1;

            // 4. Update primary topic
            await client.query(
              `UPDATE topics
               SET mahalla_name = $1,
                   required_derived_generation = $2,
                   latest_relevant_evidence_timestamp = COALESCE($3, latest_relevant_evidence_timestamp),
                   retention_expires_at = GREATEST(retention_expires_at, $4),
                   updated_at = NOW()
               WHERE id = $5`,
              [officialName, newGeneration, latestTimestamp, maxRetentionExpiry, primary.id],
            );

            // 5. Update primary topic_projections mahalla_name if projection already exists
            await client.query(
              `UPDATE topic_projections
               SET mahalla_name = $1, updated_at = NOW()
               WHERE topic_id = $2`,
              [officialName, primary.id],
            );

            // 6. Delete duplicate topic projections
            const delProjRes = await client.query(
              `DELETE FROM topic_projections WHERE topic_id = ANY($1::text[])`,
              [duplicateIds],
            );
            const deletedProjections = delProjRes.rowCount ?? 0;
            summary.projectionsDeleted += deletedProjections;

            // 7. Delete stale duplicate projection jobs from PgBoss queue (if table exists)
            try {
              await client.query(
                `DELETE FROM pgboss.job
                 WHERE name = 'telegram-topic-projection'
                   AND data->>'topicId' = ANY($1::text[])
                   AND state IN ('created', 'retry', 'active')`,
                [duplicateIds],
              );
            } catch {
              // Ignore if pgboss schema not initialized
            }

            // 8. Delete duplicate topics
            const delTopicsRes = await client.query(
              `DELETE FROM topics WHERE id = ANY($1::text[])`,
              [duplicateIds],
            );
            const deletedCount = delTopicsRes.rowCount ?? 0;
            summary.duplicateTopicsRemoved += deletedCount;

            await client.query('COMMIT');
            console.log(`     ✅ Consolidated into ${primary.id}: moved ${movedEvidenceCount} evidence (total now ${totalEvidenceCount}), removed ${deletedCount} duplicate topics, bumped generation to ${newGeneration}.`);

            // 9. Dispatch PgBoss projection job for consolidated primary
            if (boss) {
              try {
                const singletonKey = JobSingletonKeys.forTopicProjection(primary.id, newGeneration);
                const jobData: TelegramTopicProjectionJobData = {
                  topicId: primary.id,
                  districtId: primary.districtId,
                  mahallaName: officialName,
                  calendarDay: primary.calendarDay,
                  generation: newGeneration,
                };
                const jobId = await boss.send(TELEGRAM_TOPIC_PROJECTION_QUEUE, jobData, {
                  singletonKey,
                  retryLimit: 5,
                  retryDelay: 15,
                  retryBackoff: true,
                });
                if (jobId) {
                  summary.projectionJobsEnqueued++;
                  console.log(`     📬 Enqueued projection recalculation job (jobId: ${jobId})`);
                }
              } catch (err: unknown) {
                console.warn(
                  `     ⚠️  Failed to enqueue pg-boss projection job for topic ${primary.id}:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            } else {
              console.log('     ℹ️  PgBoss client not active; background topic projection reconciler will refresh stale generation.');
            }
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`     ❌ Error consolidating cluster "${officialName}":`, err);
            throw err;
          } finally {
            client.release();
          }
        }
        console.log('');
      } else if (clusterTopics.length === 1) {
        // Single topic: check if its name needs official "МФЙ" suffix
        const single = clusterTopics[0]!;
        const official = ensureOfficialMahallaSuffix(canonicalizeMahallaName(single.mahallaName));
        if (official !== single.mahallaName) {
          summary.singleTopicsNormalized++;
          if (dryRun) {
            console.log(`  🔍 [DRY-RUN SINGLE TOPIC] Would normalize topic ${single.id}: "${single.mahallaName}" -> "${official}"`);
          } else {
            const newGeneration = (single.requiredDerivedGeneration ?? 0) + 1;
            await pool.query(
              `UPDATE topics SET mahalla_name = $1, required_derived_generation = $2, updated_at = NOW() WHERE id = $3`,
              [official, newGeneration, single.id],
            );
            await pool.query(
              `UPDATE accepted_evidence SET mahalla_name = $1 WHERE topic_id = $2`,
              [official, single.id],
            );
            await pool.query(
              `UPDATE topic_projections SET mahalla_name = $1, updated_at = NOW() WHERE topic_id = $2`,
              [official, single.id],
            );
            console.log(`  ✅ [SINGLE TOPIC NORMALIZED] ${single.id}: "${single.mahallaName}" -> "${official}" (generation bumped to ${newGeneration})`);

            if (boss) {
              try {
                const singletonKey = JobSingletonKeys.forTopicProjection(single.id, newGeneration);
                const jobData: TelegramTopicProjectionJobData = {
                  topicId: single.id,
                  districtId: single.districtId,
                  mahallaName: official,
                  calendarDay: single.calendarDay,
                  generation: newGeneration,
                };
                const jobId = await boss.send(TELEGRAM_TOPIC_PROJECTION_QUEUE, jobData, {
                  singletonKey,
                  retryLimit: 5,
                  retryDelay: 15,
                  retryBackoff: true,
                });
                if (jobId) {
                  summary.projectionJobsEnqueued++;
                  console.log(`     📬 Enqueued projection recalculation job for single topic (jobId: ${jobId})`);
                }
              } catch (err: unknown) {
                console.warn(
                  `     ⚠️  Failed to enqueue pg-boss projection job for topic ${single.id}:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
          }
        }
      }
    }
  }

  if (summary.clustersWithDuplicates === 0) {
    console.log('  No duplicate mahalla topics detected across active topics.');
  }

  summary.durationMs = Date.now() - startTime;

  console.log('\n=============================================================');
  console.log('  Consolidation Summary Report');
  console.log('=============================================================');
  console.log(`- Execution Mode:            ${dryRun ? 'DRY-RUN' : 'EXECUTE'}`);
  console.log(`- District Groups Scanned:   ${summary.groupsScanned}`);
  console.log(`- District Groups Updated:   ${summary.groupsNormalized}`);
  if (summary.groupsCollided > 0) {
    console.log(`- District Group Collisions: ${summary.groupsCollided}`);
  }
  console.log(`- Topics Scanned:            ${summary.topicsScanned}`);
  console.log(`- Clusters with Duplicates:  ${summary.clustersWithDuplicates}`);
  console.log(`- Duplicate Topics Removed:  ${summary.duplicateTopicsRemoved}`);
  console.log(`- Evidence Records Moved:    ${summary.evidenceRecordsMoved}`);
  console.log(`- Projections Purged:        ${summary.projectionsDeleted}`);
  console.log(`- Single Topics Normalized:  ${summary.singleTopicsNormalized}`);
  if (summary.projectionJobsEnqueued > 0) {
    console.log(`- Projection Jobs Enqueued:  ${summary.projectionJobsEnqueued}`);
  }
  console.log(`- Processing Time:           ${summary.durationMs}ms`);
  console.log('=============================================================\n');

  return summary;
}

/**
 * Top-level CLI entry point.
 */
export async function runDeduplicateMahallaTopicsCli(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();

  console.log(`Database Target: ${maskDatabaseUrl(databaseUrl)}\n`);

  const pool = createDbPool(databaseUrl);
  let boss: PgBoss | null = null;

  try {
    try {
      boss = createBossClient({ connectionString: databaseUrl });
      await boss.start();
    } catch (err: unknown) {
      console.warn('PgBoss client initialization skipped:', err instanceof Error ? err.message : String(err));
      boss = null;
    }

    await deduplicateMahallaTopics(pool, options, boss);
  } finally {
    if (boss) {
      try {
        await boss.stop();
      } catch {
        // ignore shutdown error
      }
    }
    await pool.end();
  }
}

if (process.argv[1]?.includes('deduplicate-mahalla-topics')) {
  runDeduplicateMahallaTopicsCli()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal deduplication failure:', err);
      process.exit(1);
    });
}
