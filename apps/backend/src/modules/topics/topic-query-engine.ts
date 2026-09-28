import crypto from 'node:crypto';
import { sql, eq, and, desc, type SQL } from 'drizzle-orm';
import type { DbClient } from '../../adapters/db/client.js';
import {
  districts,
  userDashboardVisits,
} from '../../adapters/db/schema/index.js';
import {
  QualifyingLane,
  TopicCardItem,
  HokimLaneBoardData,
  HokimTopicBoardResponse,
  HokimLaneResponse,
  DateFilterScope,
  HokimTopicStatisticsQueryOutput,
  HokimTopicStatisticsResponse,
  TopicStatisticCard4,
  TopicStatisticCard5,
  TopicStatisticCard1Comparison,
  DistrictTopicsSearchBodyOutput,
  DistrictTopicsPageResponse,
  encodeKeysetCursor,
  decodeKeysetCursor,
  KeysetCursorPayload,
  CANONICAL_LANES,
  DistrictScopedActor,
} from '@mahalla-ovozi/api-contracts';
import { getTashkentCalendarDay, resolveDateBoundary } from '../telegram-intake/timezone-util.js';
import { escapeLikePattern, buildTopicSearchPredicate } from './topic-query-helpers.js';

// --- Error Classes ---

export class DistrictNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'DISTRICT_NOT_FOUND';
  constructor(message = 'Туман топилмади.') {
    super(message);
    this.name = 'DistrictNotFoundError';
  }
}

export class DistrictRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'DISTRICT_REQUIRED';
  constructor(message = 'Туман ID кўрсатилиши шарт.') {
    super(message);
    this.name = 'DistrictRequiredError';
  }
}

export class InvalidCursorError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_CURSOR';
  constructor(message = 'Курсор нотўғри ёки муддати ўтган.') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

// --- Keyset Cursor Encoding & Decoding ---

interface TopicKeysetCursorPayload extends KeysetCursorPayload {
  t: string; // ISO datetime string of latestMeaningfulActivityTimestamp
  id: string; // topic id
}

function encodeTopicKeysetCursor(timestamp: string, id: string): string {
  return encodeKeysetCursor<TopicKeysetCursorPayload>({ t: timestamp, id });
}

export function decodeTopicKeysetCursor(
  cursor: string | null | undefined,
): TopicKeysetCursorPayload | null {
  const parsed = decodeKeysetCursor<TopicKeysetCursorPayload>(cursor);
  if (
    parsed &&
    typeof parsed.t === 'string' &&
    !Number.isNaN(new Date(parsed.t).getTime()) &&
    typeof parsed.id === 'string' &&
    parsed.id.length > 0 &&
    parsed.id.length <= 100
  ) {
    const time = new Date(parsed.t).getTime();
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 86400 * 1000;
    const oneMinuteInFuture = now + 60 * 1000;
    if (time < ninetyDaysAgo || time > oneMinuteInFuture) {
      return null;
    }
    return { t: parsed.t, id: parsed.id };
  }
  return null;
}

// --- Query Interface Types ---

interface RawTopicRow extends Record<string, unknown> {
  id: string;
  districtId: string;
  mahallaName: string;
  calendarDay: string;
  primaryLane: QualifyingLane;
  createdAt: Date;
  updatedAt: Date;
  summary: string | null;
  latestUpdate?: string | null;
  lanes: QualifyingLane[] | null;
  isHokimRelated: boolean;
  latestMeaningfulActivityTimestamp: Date;
  projectionUpdatedAt?: Date;
  evidenceCount: number;
  searchMatchBadge?: 'evidence' | 'author' | null;
}

interface TopicQueryFilters {
  districtId: string;
  datePredicate: SQL;
  mahallaName?: string;
  lanes?: readonly QualifyingLane[];
  search?: string;
  cursor?: string;
  limit: number;
  baselineTimestamp?: string | null;
  targetLane?: QualifyingLane;
  includeCount?: boolean;
}

interface TopicQueryResult {
  topics: TopicCardItem[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount?: number;
}

interface HokimTopicBoardFilterParams {
  search?: string;
  dateScope?: DateFilterScope;
  dateFrom?: string;
  dateTo?: string;
  mahallaName?: string;
  lanes?: QualifyingLane[];
  calendarDay?: string;
  baselineTimestamp?: string;
}

interface HokimLaneQueryParams {
  lane: QualifyingLane;
  search?: string;
  dateScope?: DateFilterScope;
  dateFrom?: string;
  dateTo?: string;
  mahallaName?: string;
  calendarDay?: string;
  cursor?: string;
  limit?: number;
  baselineTimestamp?: string;
}

// --- Authoritative District Mahallas Extraction ---

/**
 * Retrieves distinct Mahalla names across active district telegram groups and active topics,
 * sorted deterministically according to Uzbek Cyrillic collation.
 */
export async function queryDistrictMahallas(db: DbClient, districtId: string): Promise<string[]> {
  if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
    throw new DistrictRequiredError('Туман ID кўрсатилиши шарт.');
  }

  const result = await db.execute<{ mahalla_name: string }>(sql`
    SELECT DISTINCT mahalla_name FROM (
      SELECT mahalla_name 
      FROM district_telegram_groups 
      WHERE district_id = ${districtId} 
        AND status != 'FAILED'
      UNION
      SELECT mahalla_name 
      FROM topics 
      WHERE district_id = ${districtId} 
        AND status = 'ACTIVE'
        AND retention_expires_at > NOW()
    ) combined
    WHERE mahalla_name IS NOT NULL AND TRIM(mahalla_name) != '';
  `);

  const mahallas = result.rows
    .map((r) => r.mahalla_name?.trim())
    .filter((name): name is string => Boolean(name && name.length > 0));

  const uniqueMahallas = Array.from(new Set(mahallas));
  uniqueMahallas.sort((a, b) => a.localeCompare(b, 'uz-Cyrl', { sensitivity: 'base' }));

  return uniqueMahallas;
}

// --- Core Topic Query Engine ---

/**
 * Executes a unified, high-performance PostgreSQL query retrieving topics
 * with keyset cursor pagination, multi-field search predicate, and contextual match badges.
 */
async function queryTopics(db: DbClient, params: TopicQueryFilters): Promise<TopicQueryResult> {
  const {
    districtId,
    datePredicate,
    mahallaName,
    lanes,
    search,
    cursor,
    limit,
    baselineTimestamp,
    targetLane,
    includeCount,
  } = params;

  let mahallaPredicate = sql``;
  if (mahallaName && mahallaName.trim() !== '' && mahallaName !== 'all') {
    mahallaPredicate = sql`AND t.mahalla_name = ${mahallaName.trim()}`;
  }

  let lanePredicate = sql``;
  if (lanes && lanes.length > 0) {
    const laneClauses = lanes.map((l) => {
      if (l === 'HOKIM_RELATED') {
        return sql`(tp.is_hokim_related = true OR tp.lanes @> '["HOKIM_RELATED"]'::jsonb OR t.primary_lane = 'HOKIM_RELATED')`;
      }
      return sql`(tp.lanes @> ${JSON.stringify([l])}::jsonb OR t.primary_lane = ${l})`;
    });
    lanePredicate = sql`AND (${sql.join(laneClauses, sql` OR `)})`;
  }

  let searchPredicate = sql``;
  let badgeSelect = sql`NULL::text AS "searchMatchBadge"`;

  const trimmedSearch = search?.trim();
  if (trimmedSearch) {
    const pattern = `%${escapeLikePattern(trimmedSearch)}%`;
    searchPredicate = buildTopicSearchPredicate(pattern, districtId);

    badgeSelect = sql`CASE 
      WHEN tp.summary ILIKE ${pattern} THEN NULL
      WHEN EXISTS (
        SELECT 1 FROM accepted_evidence ae 
        WHERE ae.topic_id = t.id 
          AND ae.district_id = ${districtId}
          AND ae.verbatim_text ILIKE ${pattern}
      ) THEN 'evidence'
      WHEN EXISTS (
        SELECT 1 FROM accepted_evidence ae 
        WHERE ae.topic_id = t.id 
          AND ae.district_id = ${districtId}
          AND (
            ae.user_metadata->>'username' ILIKE ${pattern}
            OR (ae.user_metadata->>'username' IS NOT NULL AND CONCAT('@', ae.user_metadata->>'username') ILIKE ${pattern})
            OR ae.user_metadata->>'firstName' ILIKE ${pattern}
            OR ae.user_metadata->>'lastName' ILIKE ${pattern}
            OR ((ae.user_metadata->>'firstName' IS NOT NULL OR ae.user_metadata->>'lastName' IS NOT NULL) AND CONCAT_WS(' ', ae.user_metadata->>'firstName', ae.user_metadata->>'lastName') ILIKE ${pattern})
          )
      ) THEN 'author'
      ELSE NULL 
    END AS "searchMatchBadge"`;
  }

  let cursorPredicate = sql``;
  if (cursor) {
    const decoded = decodeTopicKeysetCursor(cursor);
    if (!decoded) {
      throw new InvalidCursorError('Курсор нотўғри ёки муддати ўтган.');
    }
    const cursorDate = new Date(decoded.t);
    cursorPredicate = sql`AND (
      date_trunc('milliseconds', COALESCE(tp.latest_meaningful_activity_timestamp, t.latest_relevant_evidence_timestamp, t.created_at)) < ${cursorDate}
      OR (date_trunc('milliseconds', COALESCE(tp.latest_meaningful_activity_timestamp, t.latest_relevant_evidence_timestamp, t.created_at)) = ${cursorDate} AND t.id < ${decoded.id})
    )`;
  }

  const query = sql<RawTopicRow>`
    SELECT 
      t.id, 
      t.district_id AS "districtId", 
      t.mahalla_name AS "mahallaName", 
      t.calendar_day AS "calendarDay", 
      t.primary_lane AS "primaryLane", 
      t.created_at AS "createdAt", 
      t.updated_at AS "updatedAt",
      tp.summary AS summary, 
      tp.latest_update AS "latestUpdate",
      COALESCE(tp.lanes, jsonb_build_array(t.primary_lane)) AS lanes, 
      COALESCE(tp.is_hokim_related, (t.primary_lane = 'HOKIM_RELATED')) AS "isHokimRelated", 
      COALESCE(tp.latest_meaningful_activity_timestamp, t.latest_relevant_evidence_timestamp, t.created_at) AS "latestMeaningfulActivityTimestamp",
      tp.updated_at AS "projectionUpdatedAt",
      COUNT(ae.id)::int AS "evidenceCount",
      ${badgeSelect}
    FROM topics t
    LEFT JOIN topic_projections tp ON tp.topic_id = t.id
    LEFT JOIN accepted_evidence ae ON ae.topic_id = t.id AND ae.district_id = ${districtId}
    WHERE t.district_id = ${districtId}
      AND ${datePredicate}
      ${mahallaPredicate}
      AND t.status = 'ACTIVE'
      AND t.retention_expires_at > NOW()
      ${lanePredicate}
      ${cursorPredicate}
      ${searchPredicate}
    GROUP BY t.id, tp.id
    ORDER BY COALESCE(tp.latest_meaningful_activity_timestamp, t.latest_relevant_evidence_timestamp, t.created_at) DESC, t.id DESC
    LIMIT ${limit + 1};
  `;

  let countPromise: Promise<{ rows: Array<{ count: number }> }> | undefined;
  if (includeCount) {
    const countQuery = sql<{ count: number }>`
      SELECT COUNT(DISTINCT t.id)::int AS count
      FROM topics t
      LEFT JOIN topic_projections tp ON tp.topic_id = t.id
      WHERE t.district_id = ${districtId}
        AND ${datePredicate}
        ${mahallaPredicate}
        AND t.status = 'ACTIVE'
        AND t.retention_expires_at > NOW()
        ${lanePredicate}
        ${searchPredicate};
    `;
    countPromise = db.execute<{ count: number }>(countQuery);
  }

  const [topicsResult, countResult] = await Promise.all([
    db.execute<RawTopicRow>(query),
    countPromise ?? Promise.resolve(undefined),
  ]);

  const rows = topicsResult.rows;
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const baselineDate = baselineTimestamp ? new Date(baselineTimestamp) : null;

  const topics: TopicCardItem[] = pageRows.map((row) => {
    const allLanes =
      Array.isArray(row.lanes) && row.lanes.length > 0
        ? (row.lanes as QualifyingLane[])
        : [(row.primaryLane as QualifyingLane) || 'HOKIM_RELATED'];

    const referenceLane = targetLane ?? row.primaryLane;
    const additionalLanes = allLanes.filter((l) => l !== referenceLane);

    let isNew = false;
    let isUpdated = false;

    if (baselineDate) {
      const createdAtDate = new Date(row.createdAt);
      const projectionUpdatedAtDate = new Date(row.projectionUpdatedAt || row.updatedAt);

      if (createdAtDate > baselineDate) {
        isNew = true;
      } else if (projectionUpdatedAtDate > baselineDate) {
        isUpdated = true;
      }
    }

    let searchMatchBadge: 'evidence' | 'author' | null = null;
    if (row.searchMatchBadge === 'evidence' || row.searchMatchBadge === 'author') {
      searchMatchBadge = row.searchMatchBadge;
    }

    return {
      id: row.id,
      districtId: row.districtId,
      mahallaName: row.mahallaName,
      calendarDay: row.calendarDay,
      summary: row.summary,
      latestUpdate: row.latestUpdate ?? null,
      primaryLane: (row.primaryLane as QualifyingLane) || 'HOKIM_RELATED',
      lanes: allLanes,
      additionalLanes,
      evidenceCount: Number(row.evidenceCount) || 0,
      latestMeaningfulActivityTimestamp: new Date(
        row.latestMeaningfulActivityTimestamp,
      ).toISOString(),
      isNew,
      isUpdated,
      searchMatchBadge,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  });

  let nextCursor: string | null = null;
  if (hasNextPage && topics.length > 0) {
    const lastItem = topics[topics.length - 1];
    if (lastItem) {
      nextCursor = encodeTopicKeysetCursor(
        lastItem.latestMeaningfulActivityTimestamp,
        lastItem.id,
      );
    }
  }

  const totalCount = countResult ? Number(countResult.rows[0]?.count ?? 0) : undefined;

  return {
    topics,
    nextCursor,
    hasNextPage,
    totalCount,
  };
}

// --- Product Owner District Topics Page ---

/**
 * Retrieves paginated, filterable canonical Topics for an explicitly selected District (Product Owner Console).
 */
export async function queryDistrictTopicsPage(
  db: DbClient,
  params: {
    districtId: string;
    filter: DistrictTopicsSearchBodyOutput;
  },
): Promise<DistrictTopicsPageResponse> {
  const { districtId, filter } = params;

  if (!districtId || typeof districtId !== 'string' || districtId.trim() === '') {
    throw new DistrictRequiredError('Туман ID кўрсатилиши шарт.');
  }

  const district = await db.query.districts.findFirst({
    where: eq(districts.id, districtId),
  });

  if (!district) {
    throw new DistrictNotFoundError('Туман топилмади.');
  }

  const { datePredicate } = resolveDateBoundary({
    dateScope: filter.dateScope,
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    calendarDay: filter.calendarDay,
  });

  const queryResult = await queryTopics(db, {
    districtId,
    datePredicate,
    mahallaName: filter.mahallaName,
    lanes: filter.lanes,
    search: filter.search,
    cursor: filter.cursor,
    limit: filter.limit ?? 20,
    includeCount: true,
  });

  return {
    districtId: district.id,
    districtName: district.name,
    topics: queryResult.topics,
    totalCount: queryResult.totalCount ?? 0,
    nextCursor: queryResult.nextCursor,
    hasNextPage: queryResult.hasNextPage,
    serverEvaluatedAt: new Date().toISOString(),
  };
}

// --- Hokim Multi-Lane Board ---

/**
 * Retrieves today's or filtered multi-lane unified board for the Hokim's district,
 * evaluating freshness against baseline timestamp or preceding visit.
 */
export async function queryHokimBoard(
  db: DbClient,
  actorContext: DistrictScopedActor,
  paramsOrCalendarDay?: HokimTopicBoardFilterParams | string,
  baselineTimestampOverride?: string,
): Promise<HokimTopicBoardResponse> {
  const district = await db.query.districts.findFirst({
    where: eq(districts.id, actorContext.districtId),
  });

  if (!district) {
    throw new DistrictNotFoundError('Туман топилмади.');
  }

  const filterParams: HokimTopicBoardFilterParams =
    typeof paramsOrCalendarDay === 'string'
      ? {
          calendarDay: paramsOrCalendarDay,
          baselineTimestamp: baselineTimestampOverride,
        }
      : paramsOrCalendarDay || {};

  const { datePredicate, resolvedCalendarDay } = resolveDateBoundary({
    dateScope: filterParams.dateScope,
    dateFrom: filterParams.dateFrom,
    dateTo: filterParams.dateTo,
    calendarDay: filterParams.calendarDay,
  });

  const currentVisitDate = new Date();
  let visitBaselineTimestamp: string | null = null;

  const baseline = filterParams.baselineTimestamp || baselineTimestampOverride;

  if (baseline) {
    visitBaselineTimestamp = baseline;
  } else {
    const prevVisit = await db.query.userDashboardVisits.findFirst({
      where: and(
        eq(userDashboardVisits.userId, actorContext.id),
        eq(userDashboardVisits.districtId, actorContext.districtId),
      ),
      orderBy: [desc(userDashboardVisits.visitedAt)],
    });

    visitBaselineTimestamp = prevVisit ? prevVisit.visitedAt.toISOString() : null;

    // A2 (L3-P03-08) — ACCEPTED TRADE-OFF, not an oversight.
    // This GET appends a visit row, so the endpoint is not side-effect free.
    // The append IS the feature: the next load's `isNew`/`isUpdated` freshness
    // is derived from the previous visit timestamp, so removing the write
    // silently disables freshness (AC 5 fails).
    // `user_dashboard_visits` has NO unique constraint on (userId, districtId)
    // — verified in the live schema and via pg_constraint — so it is an
    // append-only log and concurrent board loads cannot collide or corrupt.
    // Known costs, accepted: read-only replicas and cache-on-GET assumptions
    // do not hold for this route. Pinned by the 'visit append semantics' test
    // in apps/backend/tests/hokim-topics.test.ts.
    await db.insert(userDashboardVisits).values({
      id: `vis_${crypto.randomUUID()}`,
      userId: actorContext.id,
      districtId: actorContext.districtId,
      visitedAt: currentVisitDate,
      createdAt: currentVisitDate,
    });
  }

  const hasProcessingDelay = await checkProcessingDelay(
    db,
    actorContext.districtId,
    resolvedCalendarDay,
  );

  const requestedLanes =
    filterParams.lanes && filterParams.lanes.length > 0
      ? CANONICAL_LANES.filter((l) => filterParams.lanes!.includes(l))
      : CANONICAL_LANES;

  const activeLanes = requestedLanes.length > 0 ? requestedLanes : CANONICAL_LANES;

  const laneResults = await Promise.all(
    activeLanes.map(async (lane) => {
      const result = await queryTopics(db, {
        districtId: actorContext.districtId,
        datePredicate,
        mahallaName: filterParams.mahallaName,
        lanes: [lane],
        targetLane: lane,
        limit: 20,
        baselineTimestamp: visitBaselineTimestamp,
        search: filterParams.search,
        includeCount: true,
      });

      return {
        lane,
        data: {
          lane,
          topics: result.topics,
          nextCursor: result.nextCursor,
          hasNextPage: result.hasNextPage,
          totalCount: result.totalCount ?? 0,
        },
      };
    }),
  );

  const lanesRecord = {} as Record<QualifyingLane, HokimLaneBoardData>;
  for (const res of laneResults) {
    lanesRecord[res.lane] = res.data;
  }

  return {
    districtId: district.id,
    districtName: district.name,
    calendarDay: resolvedCalendarDay,
    evaluationId: crypto.randomUUID(),
    visitBaselineTimestamp,
    currentVisitTimestamp: currentVisitDate.toISOString(),
    serverEvaluatedAt: currentVisitDate.toISOString(),
    hasProcessingDelay,
    lanes: lanesRecord,
  };
}

// --- Hokim Single Lane Batch ---

/**
 * Retrieves a paginated batch of topics for a single lane using deterministic keyset pagination.
 */
export async function queryHokimLaneBatch(
  db: DbClient,
  params: HokimLaneQueryParams & { actorContext: DistrictScopedActor },
): Promise<HokimLaneResponse> {
  const { actorContext, lane, cursor, baselineTimestamp, mahallaName, search, limit } = params;

  const { datePredicate } = resolveDateBoundary({
    dateScope: params.dateScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    calendarDay: params.calendarDay,
  });

  const result = await queryTopics(db, {
    districtId: actorContext.districtId,
    datePredicate,
    mahallaName,
    lanes: [lane],
    targetLane: lane,
    limit: limit ?? 20,
    cursor,
    baselineTimestamp,
    search,
    includeCount: false,
  });

  return {
    lane,
    topics: result.topics,
    nextCursor: result.nextCursor,
    hasNextPage: result.hasNextPage,
  };
}

// --- Processing Delay Check ---

/**
 * Checks if unprocessed intake records or active processing jobs older than 30s indicate a processing delay.
 */
async function checkProcessingDelay(
  db: DbClient,
  districtId: string,
  calendarDay: string,
): Promise<boolean> {
  try {
    const bossDelay = await db.execute(sql`
      SELECT 1 FROM pgboss.job
      WHERE name IN (
        'telegram-content-qualification',
        'telegram-semantic-relevance',
        'telegram-topic-assignment',
        'telegram-topic-projection'
      )
      AND state IN ('created', 'retry', 'active')
      AND (data->>'districtId' = ${districtId})
      AND createdon < NOW() - INTERVAL '30 seconds'
      LIMIT 1;
    `);
    if (bossDelay.rows && bossDelay.rows.length > 0) {
      return true;
    }
  } catch {
    // pgboss table might not exist in certain test setups or schemas
  }

  try {
    let intakeDayPredicate = sql`tir.calendar_day = ${calendarDay}`;
    let topicDayPredicate = sql`t.calendar_day = ${calendarDay}`;
    if (calendarDay.includes('..')) {
      const [fromDay, toDay] = calendarDay.split('..');
      intakeDayPredicate = sql`tir.calendar_day >= ${fromDay} AND tir.calendar_day <= ${toDay}`;
      topicDayPredicate = sql`t.calendar_day >= ${fromDay} AND t.calendar_day <= ${toDay}`;
    }

    const intakeDelay = await db.execute(sql`
      SELECT 1 FROM telegram_intake_records tir
      WHERE tir.district_id = ${districtId}
        AND ${intakeDayPredicate}
        AND tir.created_at < NOW() - INTERVAL '30 seconds'
        AND NOT EXISTS (
          SELECT 1 FROM ai_operations ao 
          WHERE ao.district_id = tir.district_id 
            AND ao.target_id = tir.id
        )
      LIMIT 1;
    `);
    if (intakeDelay.rows && intakeDelay.rows.length > 0) {
      return true;
    }

    const projectionDelay = await db.execute(sql`
      SELECT 1 FROM topics t
      LEFT JOIN topic_projections tp ON tp.topic_id = t.id
      WHERE t.district_id = ${districtId}
        AND ${topicDayPredicate}
        AND t.status = 'ACTIVE'
        AND (tp.id IS NULL OR tp.updated_at < t.updated_at - INTERVAL '30 seconds')
        AND t.created_at < NOW() - INTERVAL '30 seconds'
      LIMIT 1;
    `);
    if (projectionDelay.rows && projectionDelay.rows.length > 0) {
      return true;
    }
  } catch {
    // Fallback safely to false if query fails
  }

  return false;
}

// --- Topic Statistics & Prior Period Comparison ---

/**
 * Retrieves compact neutral statistics following active filter scope
 * and single-roundtrip authoritative PostgreSQL aggregations.
 */
export async function queryHokimStatistics(
  db: DbClient,
  actorContext: DistrictScopedActor,
  params: HokimTopicStatisticsQueryOutput & { search?: string },
): Promise<HokimTopicStatisticsResponse> {
  const districtId = actorContext.districtId;

  const districtResult = await db
    .select({ name: districts.name })
    .from(districts)
    .where(eq(districts.id, districtId))
    .limit(1);
  const districtName = districtResult[0]?.name || 'Номаълум туман';

  const { datePredicate, resolvedCalendarDay } = resolveDateBoundary(params);

  let mahallaPredicate = sql``;
  if (params.mahallaName && params.mahallaName.trim() !== '' && params.mahallaName !== 'all') {
    mahallaPredicate = sql`AND t.mahalla_name = ${params.mahallaName.trim()}`;
  }

  const selectedLanes: QualifyingLane[] =
    params.lanes && Array.isArray(params.lanes) && params.lanes.length > 0
      ? params.lanes
      : [...CANONICAL_LANES];

  const laneClauses = selectedLanes.map((l) => {
    if (l === 'HOKIM_RELATED') {
      return sql`(tp.is_hokim_related = true OR tp.lanes @> '["HOKIM_RELATED"]'::jsonb OR t.primary_lane = 'HOKIM_RELATED')`;
    }
    return sql`(tp.lanes @> ${JSON.stringify([l])}::jsonb OR t.primary_lane = ${l})`;
  });
  const lanePredicate = sql.join(laneClauses, sql` OR `);

  let searchPredicate = sql``;
  const trimmedSearch = typeof params.search === 'string' ? params.search.trim() : undefined;
  if (trimmedSearch) {
    const pattern = `%${escapeLikePattern(trimmedSearch)}%`;
    searchPredicate = buildTopicSearchPredicate(pattern, districtId);
  }

  const statsQuery = sql`
    WITH filtered_topics AS (
      SELECT 
        t.id,
        t.mahalla_name,
        t.primary_lane,
        tp.lanes,
        tp.is_hokim_related
      FROM topics t
      LEFT JOIN topic_projections tp ON tp.topic_id = t.id
      WHERE t.district_id = ${districtId}
        AND t.status = 'ACTIVE'
        AND t.retention_expires_at > NOW()
        AND ${datePredicate}
        ${mahallaPredicate}
        AND (${lanePredicate})
        ${searchPredicate}
    ),
    evidence_counts AS (
      SELECT 
        ae.topic_id,
        COUNT(DISTINCT ae.id)::int as count
      FROM accepted_evidence ae
      WHERE ae.topic_id IN (SELECT id FROM filtered_topics)
        AND ae.district_id = ${districtId}
      GROUP BY ae.topic_id
    ),
    mahalla_topic_counts AS (
      SELECT 
        mahalla_name, 
        COUNT(DISTINCT id)::int as topic_count
      FROM filtered_topics
      WHERE mahalla_name IS NOT NULL AND TRIM(mahalla_name) != ''
      GROUP BY mahalla_name
    ),
    district_mahallas_total AS (
      SELECT COUNT(DISTINCT mahalla_name)::int as total_mahallas_count
      FROM (
        SELECT mahalla_name FROM district_telegram_groups WHERE district_id = ${districtId} AND status != 'FAILED'
        UNION
        SELECT mahalla_name FROM topics WHERE district_id = ${districtId} AND status = 'ACTIVE' AND retention_expires_at > NOW()
      ) d_mahallas
      WHERE mahalla_name IS NOT NULL AND TRIM(mahalla_name) != ''
    )
    SELECT 
      COUNT(DISTINCT ft.id)::int as total_unique_topics,
      COUNT(DISTINCT CASE WHEN ft.is_hokim_related = true OR ft.lanes @> '["HOKIM_RELATED"]'::jsonb OR ft.primary_lane = 'HOKIM_RELATED' THEN ft.id END)::int as hokim_topics_count,
      COALESCE(SUM(CASE WHEN ft.is_hokim_related = true OR ft.lanes @> '["HOKIM_RELATED"]'::jsonb OR ft.primary_lane = 'HOKIM_RELATED' THEN ec.count ELSE 0 END), 0)::int as hokim_evidence_count,
      COUNT(DISTINCT CASE WHEN ft.mahalla_name IS NOT NULL AND TRIM(ft.mahalla_name) != '' THEN ft.mahalla_name END)::int as active_mahallas_count,
      COALESCE(SUM(ec.count), 0)::int as total_accepted_evidence_count,
      COUNT(DISTINCT CASE WHEN ft.lanes IS NOT NULL AND jsonb_typeof(ft.lanes) = 'array' AND jsonb_array_length(ft.lanes) > 1 THEN ft.id END)::int as multi_lane_topics_count,
      COUNT(DISTINCT CASE WHEN COALESCE(ec.count, 0) > 1 THEN ft.id END)::int as multi_evidence_topics_count,
      COUNT(DISTINCT CASE WHEN ft.lanes @> '["WATER"]'::jsonb OR ft.primary_lane = 'WATER' THEN ft.id END)::int as water_count,
      COUNT(DISTINCT CASE WHEN ft.lanes @> '["ELECTRICITY"]'::jsonb OR ft.primary_lane = 'ELECTRICITY' THEN ft.id END)::int as electricity_count,
      COUNT(DISTINCT CASE WHEN ft.lanes @> '["GAS"]'::jsonb OR ft.primary_lane = 'GAS' THEN ft.id END)::int as gas_count,
      COUNT(DISTINCT CASE WHEN ft.lanes @> '["WASTE"]'::jsonb OR ft.primary_lane = 'WASTE' THEN ft.id END)::int as waste_count,
      COALESCE((SELECT jsonb_object_agg(mahalla_name, topic_count) FROM mahalla_topic_counts), '{}'::jsonb) as mahalla_counts,
      COALESCE((SELECT total_mahallas_count FROM district_mahallas_total), 0)::int as total_district_mahallas_count
    FROM filtered_topics ft
    LEFT JOIN evidence_counts ec ON ec.topic_id = ft.id;
  `;

  const result = await db.execute<{
    total_unique_topics: number;
    hokim_topics_count: number;
    hokim_evidence_count: number;
    active_mahallas_count: number;
    total_accepted_evidence_count: number;
    multi_lane_topics_count: number;
    multi_evidence_topics_count: number;
    water_count: number;
    electricity_count: number;
    gas_count: number;
    waste_count: number;
    mahalla_counts: Record<string, number> | null;
    total_district_mahallas_count: number;
  }>(statsQuery);

  const row = result.rows[0];

  const totalUniqueTopics = Number(row?.total_unique_topics ?? 0);
  const hokimRelatedTopics = Number(row?.hokim_topics_count ?? 0);
  const hokimEvidenceCount = Number(row?.hokim_evidence_count ?? 0);
  const activeMahallasCount = Number(row?.active_mahallas_count ?? 0);
  const totalAcceptedEvidenceCount = Number(row?.total_accepted_evidence_count ?? 0);
  const multiLaneTopicCount = Number(row?.multi_lane_topics_count ?? 0);
  const multiEvidenceTopicCount = Number(row?.multi_evidence_topics_count ?? 0);
  const totalDistrictMahallasCount = Number(row?.total_district_mahallas_count ?? 0);

  // Card 4
  const activeServiceLanes = selectedLanes.filter(
    (l): l is 'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE' =>
      l === 'WATER' || l === 'ELECTRICITY' || l === 'GAS' || l === 'WASTE',
  );

  let card4: TopicStatisticCard4;
  if (activeServiceLanes.length < 2) {
    card4 = {
      mode: 'multi_lane_topics',
      multiLaneTopicCount,
    };
  } else {
    const serviceCounts: Record<'WATER' | 'ELECTRICITY' | 'GAS' | 'WASTE', number> = {
      WATER: Number(row?.water_count ?? 0),
      ELECTRICITY: Number(row?.electricity_count ?? 0),
      GAS: Number(row?.gas_count ?? 0),
      WASTE: Number(row?.waste_count ?? 0),
    };

    let maxCount = 0;
    for (const lane of activeServiceLanes) {
      const c = serviceCounts[lane];
      if (c > maxCount) {
        maxCount = c;
      }
    }

    if (maxCount === 0) {
      card4 = {
        mode: 'most_active_service_lane',
        leaderLane: null,
        leaderTopicCount: 0,
        isTie: false,
        tiedCount: 0,
        isZero: true,
      };
    } else {
      const tied = activeServiceLanes.filter((lane) => serviceCounts[lane] === maxCount);
      if (tied.length > 1) {
        card4 = {
          mode: 'most_active_service_lane',
          leaderLane: null,
          leaderTopicCount: maxCount,
          isTie: true,
          tiedCount: tied.length,
          isZero: false,
        };
      } else {
        card4 = {
          mode: 'most_active_service_lane',
          leaderLane: tied[0] ?? null,
          leaderTopicCount: maxCount,
          isTie: false,
          tiedCount: 0,
          isZero: false,
        };
      }
    }
  }

  // Card 5
  const isSingleMahallaScope =
    (params.mahallaName &&
      params.mahallaName.trim() !== '' &&
      params.mahallaName.trim() !== 'all') ||
    totalDistrictMahallasCount <= 1;

  let card5: TopicStatisticCard5;
  if (isSingleMahallaScope) {
    card5 = {
      mode: 'multi_evidence_topics',
      multiEvidenceTopicCount,
    };
  } else {
    const rawMahallaCounts = (row?.mahalla_counts ?? {}) as Record<string, number>;
    const mahallaEntries = Object.entries(rawMahallaCounts).filter(
      ([name, count]) => name && name.trim() !== '' && Number(count) > 0,
    );

    if (mahallaEntries.length === 0 || totalUniqueTopics === 0) {
      card5 = {
        mode: 'most_active_mahalla',
        leaderMahalla: null,
        leaderTopicCount: 0,
        isTie: false,
        tiedCount: 0,
        isZero: true,
      };
    } else {
      let maxCount = 0;
      for (const [, count] of mahallaEntries) {
        const c = Number(count);
        if (c > maxCount) {
          maxCount = c;
        }
      }

      if (maxCount === 0) {
        card5 = {
          mode: 'most_active_mahalla',
          leaderMahalla: null,
          leaderTopicCount: 0,
          isTie: false,
          tiedCount: 0,
          isZero: true,
        };
      } else {
        const tied = mahallaEntries
          .filter(([, count]) => Number(count) === maxCount)
          .map(([name]) => name);

        if (tied.length > 1) {
          card5 = {
            mode: 'most_active_mahalla',
            leaderMahalla: null,
            leaderTopicCount: maxCount,
            isTie: true,
            tiedCount: tied.length,
            isZero: false,
          };
        } else {
          card5 = {
            mode: 'most_active_mahalla',
            leaderMahalla: tied[0] ?? null,
            leaderTopicCount: maxCount,
            isTie: false,
            tiedCount: 0,
            isZero: false,
          };
        }
      }
    }
  }

  const asOfDate = new Date();
  const serverEvaluatedAt = asOfDate.toISOString();

  const card1Comparison = await resolvePriorPeriodComparison(db, {
    districtId,
    asOfDate,
    totalUniqueTopics,
    query: params,
    selectedLanes,
    trimmedSearch,
    mahallaPredicate,
    lanePredicate,
    searchPredicate,
  });

  return {
    districtId,
    districtName,
    calendarDay: resolvedCalendarDay,
    evaluationId: crypto.randomUUID(),
    serverEvaluatedAt,
    totalUniqueTopics,
    card1Comparison,
    hokimRelatedTopics,
    hokimEvidenceCount,
    activeMahallasCount,
    totalAcceptedEvidenceCount,
    card4,
    card5,
  };
}

/**
 * Computes authoritative prior-period comparison for Card 1 (Total Unique Topics).
 */
async function resolvePriorPeriodComparison(
  db: DbClient,
  params: {
    districtId: string;
    asOfDate: Date;
    totalUniqueTopics: number;
    query: HokimTopicStatisticsQueryOutput & { search?: string };
    selectedLanes: QualifyingLane[];
    trimmedSearch?: string;
    mahallaPredicate: SQL;
    lanePredicate: SQL;
    searchPredicate: SQL;
  },
): Promise<TopicStatisticCard1Comparison> {
  const {
    districtId,
    asOfDate,
    totalUniqueTopics,
    query,
    selectedLanes,
    trimmedSearch,
    mahallaPredicate,
    lanePredicate,
    searchPredicate,
  } = params;

  const nowSeconds = Math.floor(asOfDate.getTime() / 1000);
  const today = getTashkentCalendarDay(nowSeconds);
  const retentionLowerBound = getTashkentCalendarDay(nowSeconds - 90 * 86400);

  const isHistoricalSingleDay = Boolean(query.calendarDay && query.calendarDay < today);
  const isYesterdayScope = Boolean(!query.calendarDay && query.dateScope === 'yesterday');
  const isCustomScope = Boolean(query.dateScope === 'custom');
  const isTodayScope =
    query.calendarDay === today ||
    (!query.calendarDay && (query.dateScope === 'today' || !query.dateScope));

  // Case 1: Today scope
  if (isTodayScope) {
    if (selectedLanes.length < 5 || (trimmedSearch && trimmedSearch.length > 0)) {
      return {
        isAvailable: false,
        reason: 'UNSUPPORTED_FILTER_SCOPE',
      };
    }

    const yesterdayCutoffSeconds = nowSeconds - 86400;
    const yesterdayCutoffDate = new Date(yesterdayCutoffSeconds * 1000);
    const yesterdayDay = getTashkentCalendarDay(yesterdayCutoffSeconds);

    if (yesterdayDay < retentionLowerBound) {
      return {
        isAvailable: false,
        reason: 'OUTSIDE_RETENTION_WINDOW',
      };
    }

    const prevResult = await db.execute<{ prev_count: number }>(sql`
      SELECT COUNT(DISTINCT t.id)::int as prev_count
      FROM topics t
      WHERE t.district_id = ${districtId}
        AND t.status = 'ACTIVE'
        AND t.retention_expires_at > NOW()
        AND t.calendar_day = ${yesterdayDay}
        ${mahallaPredicate}
        AND EXISTS (
          SELECT 1 FROM accepted_evidence ae
          WHERE ae.topic_id = t.id
            AND ae.district_id = ${districtId}
            AND ae.calendar_day = ${yesterdayDay}
            AND ae.original_timestamp <= ${yesterdayCutoffDate}
        );
    `);

    const prevCount = Number(prevResult.rows[0]?.prev_count ?? 0);
    return {
      isAvailable: true,
      previousValue: prevCount,
      delta: totalUniqueTopics - prevCount,
      comparisonPeriodType: 'equivalent_same_time_yesterday',
      comparisonPeriodLabel: 'кечаги шу вақтга нисбатан',
    };
  }

  // Case 2: Completed Single Day Scope
  if (isYesterdayScope || isHistoricalSingleDay) {
    const targetDay = isYesterdayScope
      ? getTashkentCalendarDay(nowSeconds - 86400)
      : query.calendarDay!;

    const parts = targetDay.split('-').map(Number);
    const y = parts[0] ?? 2026;
    const m = parts[1] ?? 1;
    const d = parts[2] ?? 1;
    const dMidday = new Date(Date.UTC(y, m - 1, d, 7, 0, 0));
    const priorDaySeconds = Math.floor(dMidday.getTime() / 1000) - 86400;
    const priorDay = getTashkentCalendarDay(priorDaySeconds);

    if (priorDay < retentionLowerBound) {
      return {
        isAvailable: false,
        reason: 'OUTSIDE_RETENTION_WINDOW',
      };
    }

    const prevResult = await db.execute<{ prev_count: number }>(sql`
      SELECT COUNT(DISTINCT t.id)::int as prev_count
      FROM topics t
      JOIN topic_projections tp ON tp.topic_id = t.id
      WHERE t.district_id = ${districtId}
        AND t.status = 'ACTIVE'
        AND t.retention_expires_at > NOW()
        AND t.calendar_day = ${priorDay}
        ${mahallaPredicate}
        AND (${lanePredicate})
        ${searchPredicate};
    `);

    const prevCount = Number(prevResult.rows[0]?.prev_count ?? 0);
    return {
      isAvailable: true,
      previousValue: prevCount,
      delta: totalUniqueTopics - prevCount,
      comparisonPeriodType: 'previous_calendar_day',
      comparisonPeriodLabel: 'олдинги кунга нисбатан',
    };
  }

  // Case 3: Completed Custom N-day Range Scope
  if (isCustomScope) {
    const { dateFrom, dateTo } = query;
    if (!dateFrom || !dateTo) {
      return {
        isAvailable: false,
        reason: 'UNSUPPORTED_FILTER_SCOPE',
      };
    }

    if (dateTo >= today) {
      return {
        isAvailable: false,
        reason: 'UNSUPPORTED_FILTER_SCOPE',
      };
    }

    const fromParts = dateFrom.split('-').map(Number);
    const yFrom = fromParts[0] ?? 2026;
    const mFrom = fromParts[1] ?? 1;
    const dFrom = fromParts[2] ?? 1;

    const toParts = dateTo.split('-').map(Number);
    const yTo = toParts[0] ?? 2026;
    const mTo = toParts[1] ?? 1;
    const dTo = toParts[2] ?? 1;

    const fromMidday = new Date(Date.UTC(yFrom, mFrom - 1, dFrom, 7, 0, 0));
    const toMidday = new Date(Date.UTC(yTo, mTo - 1, dTo, 7, 0, 0));
    const diffDays = Math.round((toMidday.getTime() - fromMidday.getTime()) / (86400 * 1000));
    const nDays = diffDays + 1;

    const priorToSeconds = Math.floor(fromMidday.getTime() / 1000) - 86400;
    const priorFromSeconds = Math.floor(fromMidday.getTime() / 1000) - nDays * 86400;

    const priorDateTo = getTashkentCalendarDay(priorToSeconds);
    const priorDateFrom = getTashkentCalendarDay(priorFromSeconds);

    if (priorDateFrom < retentionLowerBound) {
      return {
        isAvailable: false,
        reason: 'OUTSIDE_RETENTION_WINDOW',
      };
    }

    const prevResult = await db.execute<{ prev_count: number }>(sql`
      SELECT COUNT(DISTINCT t.id)::int as prev_count
      FROM topics t
      JOIN topic_projections tp ON tp.topic_id = t.id
      WHERE t.district_id = ${districtId}
        AND t.status = 'ACTIVE'
        AND t.retention_expires_at > NOW()
        AND t.calendar_day >= ${priorDateFrom} AND t.calendar_day <= ${priorDateTo}
        ${mahallaPredicate}
        AND (${lanePredicate})
        ${searchPredicate};
    `);

    const prevCount = Number(prevResult.rows[0]?.prev_count ?? 0);
    return {
      isAvailable: true,
      previousValue: prevCount,
      delta: totalUniqueTopics - prevCount,
      comparisonPeriodType: 'previous_custom_range',
      comparisonPeriodLabel: 'олдинги даврга нисбатан',
    };
  }

  return {
    isAvailable: false,
    reason: 'UNSUPPORTED_FILTER_SCOPE',
  };
}
