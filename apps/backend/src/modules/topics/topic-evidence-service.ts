import { sql, eq, and, gt } from 'drizzle-orm';
import { DbClient } from '../../adapters/db/client.js';
import {
  topics,
  topicProjections,
  acceptedEvidence,
} from '../../adapters/db/schema/index.js';
import {
  QualifyingLane,
  TopicCardItem,
  TopicEvidenceItem,
  TopicEvidenceResponse,
  TopicEvidenceQueryOutput,
  encodeKeysetCursor,
  decodeKeysetCursor,
  KeysetCursorPayload,
  DEFAULT_HOKIM_RECOGNITION_TERMS,
  DistrictScopedActor,
} from '@mahalla-ovozi/api-contracts';
import { districtAnalysisSettingsRepository } from '../ai/district-analysis-settings-repository.js';
import { InvalidCursorError } from './topic-query-engine.js';

export function buildHokimTermsRegex(terms: readonly string[]): RegExp {
  const normalizedTerms = new Set<string>();
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed.length > 0) {
      normalizedTerms.add(trimmed);
      if (/^[ҳҲ]/u.test(trimmed)) {
        normalizedTerms.add('х' + trimmed.slice(1));
        normalizedTerms.add('Х' + trimmed.slice(1));
      } else if (/^[хХ]/u.test(trimmed)) {
        normalizedTerms.add('ҳ' + trimmed.slice(1));
        normalizedTerms.add('Ҳ' + trimmed.slice(1));
      }
    }
  }

  const termList = Array.from(normalizedTerms).sort((a, b) => b.length - a.length);
  if (termList.length === 0) {
    return /(?!)/;
  }

  const escaped = termList.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${escaped.join('|')})[\\p{L}]*(?:$|[^\\p{L}\\p{N}_])`, 'iu');
}

export interface EvidenceKeysetCursorPayload extends KeysetCursorPayload {
  t: string; // ISO datetime string of originalTimestamp
  msgId: string; // telegramMessageId
  id: string; // evidence id
}

export function encodeEvidenceKeysetCursor(timestamp: string, msgId: string, id: string): string {
  return encodeKeysetCursor<EvidenceKeysetCursorPayload>({ t: timestamp, msgId, id });
}

export function decodeEvidenceKeysetCursor(cursor: string): EvidenceKeysetCursorPayload | null {
  const parsed = decodeKeysetCursor<EvidenceKeysetCursorPayload>(cursor);
  if (
    parsed &&
    typeof parsed.t === 'string' &&
    !Number.isNaN(new Date(parsed.t).getTime()) &&
    typeof parsed.msgId === 'string' &&
    parsed.msgId.length > 0 &&
    typeof parsed.id === 'string' &&
    parsed.id.length > 0
  ) {
    return { t: parsed.t, msgId: parsed.msgId, id: parsed.id };
  }
  return null;
}

/**
 * Custom error thrown when a topic is not found or is inaccessible (AC 1).
 */
export class TopicNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';

  constructor(message = 'Мавзу топилмади ёки сақлаш муддати тугаган.') {
    super(message);
    this.name = 'TopicNotFoundError';
  }
}

/**
 * Formats a timestamp into Asia/Tashkent time as DD.MM.YYYY HH:mm.
 * Uses deterministic UTC+5 arithmetic to avoid environment or timezone differences.
 */
export function formatTashkentDateTime(date: Date): string {
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }
  const adjusted = new Date(date.getTime() + 5 * 3600 * 1000);
  const day = String(adjusted.getUTCDate()).padStart(2, '0');
  const month = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const year = adjusted.getUTCFullYear();
  const hours = String(adjusted.getUTCHours()).padStart(2, '0');
  const minutes = String(adjusted.getUTCMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Resolves Telegram deep link using a 3-tier algorithm (AC 6):
 * 1. If public group username exists: https://t.me/${username}/${messageId}
 * 2. Else if private group or supergroup:
 *    - Supergroups with -100 prefix: https://t.me/c/${cleanChatId}/${messageId}
 *    - Basic groups with - prefix: https://t.me/c/${cleanChatId}/${messageId}
 *    - Plain numeric IDs: https://t.me/c/${cleanChatId}/${messageId}
 * 3. Otherwise: null (omit link gracefully)
 */
export function resolveTelegramDeepLink(
  groupUsername: string | null | undefined,
  chatId: string,
  messageId: string,
): string | null {
  if (groupUsername && groupUsername.trim().length > 0) {
    const cleanUsername = groupUsername.trim().replace(/^@/, '');
    if (cleanUsername.length > 0) {
      return `https://t.me/${cleanUsername}/${messageId}`;
    }
  }

  if (chatId && typeof chatId === 'string' && messageId && typeof messageId === 'string' && messageId.trim().length > 0) {
    const trimmedChatId = chatId.trim();
    let cleanChatId: string | null = null;

    if (trimmedChatId.startsWith('-100')) {
      if (trimmedChatId.length > 4) {
        cleanChatId = trimmedChatId.slice(4);
      }
    } else if (trimmedChatId.startsWith('-') && trimmedChatId.length > 1) {
      cleanChatId = trimmedChatId.slice(1);
    } else if (/^\d+$/.test(trimmedChatId)) {
      cleanChatId = trimmedChatId;
    }

    if (cleanChatId && /^\d+$/.test(cleanChatId)) {
      return `https://t.me/c/${cleanChatId}/${messageId.trim()}`;
    }
  }

  return null;
}

/**
 * Privacy-compliant sender attribution sanitization (AC 5, AD-11).
 * Strictly omits telegramUserId and phone numbers.
 */
export function sanitizeSenderAttribution(userMetadata: unknown): {
  authorUsername: string | null;
  authorName: string | null;
} {
  if (!userMetadata || typeof userMetadata !== 'object') {
    return { authorUsername: null, authorName: null };
  }
  const meta = userMetadata as Record<string, unknown>;
  const rawUsername =
    typeof meta.username === 'string' && meta.username.trim().length > 0
      ? meta.username.trim()
      : null;
  const cleanUsername = rawUsername ? rawUsername.replace(/^@/, '').trim() : '';
  const authorUsername = cleanUsername.length > 0 ? `@${cleanUsername}` : null;

  const firstName = typeof meta.firstName === 'string' ? meta.firstName.trim() : '';
  const lastName = typeof meta.lastName === 'string' ? meta.lastName.trim() : '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const authorName = fullName.length > 0 ? fullName : null;

  return { authorUsername, authorName };
}

interface RawEvidenceRow extends Record<string, unknown> {
  id: string;
  topicId: string;
  verbatimText: string;
  contentType: string;
  originalTimestamp: Date;
  telegramChatId: string;
  telegramMessageId: string;
  userMetadata: unknown;
  telegramChatUsername: string | null;
}

/**
 * Retrieves complete retained Accepted Evidence for a specific Topic (AC 1-6).
 * Validates fixed-district tenant boundary and provides keyset-paginated results.
 */
export async function getTopicEvidence(
  db: DbClient,
  actorContext: DistrictScopedActor,
  topicId: string,
  query: TopicEvidenceQueryOutput,
): Promise<TopicEvidenceResponse> {

  // 1. Build Keyset Cursor Predicate (Bidirectional: ASC or DESC)
  const order = query.order ?? 'ASC';
  let cursorPredicate = sql``;
  if (query.cursor) {
    const decoded = decodeEvidenceKeysetCursor(query.cursor);
    if (!decoded) {
      throw new InvalidCursorError('Курсор нотўғри ёки муддати ўтган.');
    }
    const cursorDate = new Date(decoded.t);
    if (order === 'DESC') {
      cursorPredicate = sql`AND (
        ae.original_timestamp < ${cursorDate}
        OR (ae.original_timestamp = ${cursorDate} AND ae.telegram_message_id < ${decoded.msgId})
        OR (ae.original_timestamp = ${cursorDate} AND ae.telegram_message_id = ${decoded.msgId} AND ae.id < ${decoded.id})
      )`;
    } else {
      cursorPredicate = sql`AND (
        ae.original_timestamp > ${cursorDate}
        OR (ae.original_timestamp = ${cursorDate} AND ae.telegram_message_id > ${decoded.msgId})
        OR (ae.original_timestamp = ${cursorDate} AND ae.telegram_message_id = ${decoded.msgId} AND ae.id > ${decoded.id})
      )`;
    }
  }

  const orderByClause =
    order === 'DESC'
      ? sql`ORDER BY ae.original_timestamp DESC, ae.telegram_message_id DESC, ae.id DESC`
      : sql`ORDER BY ae.original_timestamp ASC, ae.telegram_message_id ASC, ae.id ASC`;

  const limit = query.limit ?? 50;

  // 2. Parallelize all queries: topic validation, projection, count, evidence rows, and settings (P3)
  const [topicRow, projectionRow, countResult, rawEvidenceRows, activeDistrictSettings] =
    await Promise.all([
      db.query.topics.findFirst({
        where: and(
          eq(topics.id, topicId),
          eq(topics.districtId, actorContext.districtId),
          eq(topics.status, 'ACTIVE'),
          gt(topics.retentionExpiresAt, new Date()),
        ),
      }),
      db.query.topicProjections.findFirst({
        where: eq(topicProjections.topicId, topicId),
      }),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(acceptedEvidence)
        .where(
          and(
            eq(acceptedEvidence.topicId, topicId),
            eq(acceptedEvidence.districtId, actorContext.districtId),
          ),
        ),
      db.execute<RawEvidenceRow>(sql`
        SELECT 
          ae.id,
          ae.topic_id AS "topicId",
          ae.verbatim_text AS "verbatimText",
          ae.content_type AS "contentType",
          ae.original_timestamp AS "originalTimestamp",
          ae.telegram_chat_id AS "telegramChatId",
          ae.telegram_message_id AS "telegramMessageId",
          ae.user_metadata AS "userMetadata",
          dtg.telegram_chat_username AS "telegramChatUsername"
        FROM accepted_evidence ae
        LEFT JOIN district_telegram_groups dtg 
          ON dtg.district_id = ae.district_id AND dtg.telegram_chat_id = ae.telegram_chat_id
        WHERE ae.topic_id = ${topicId}
          AND ae.district_id = ${actorContext.districtId}
          ${cursorPredicate}
        ${orderByClause}
        LIMIT ${limit + 1};
      `),
      districtAnalysisSettingsRepository.getActiveConfiguration(db, actorContext.districtId),
    ]);

  if (!topicRow) {
    throw new TopicNotFoundError('Мавзу топилмади ёки сақлаш муддати тугаган.');
  }

  const totalCount = countResult[0]?.count ?? 0;

  const recognitionTerms: readonly string[] =
    activeDistrictSettings?.hokimRecognitionTerms && activeDistrictSettings.hokimRecognitionTerms.length > 0
      ? activeDistrictSettings.hokimRecognitionTerms
      : DEFAULT_HOKIM_RECOGNITION_TERMS;
  const hokimMatcher = buildHokimTermsRegex(recognitionTerms);

  // 4. Build TopicCardItem
  const topicCard: TopicCardItem = {
    id: topicRow.id,
    districtId: topicRow.districtId,
    mahallaName: topicRow.mahallaName,
    calendarDay: topicRow.calendarDay,
    summary: projectionRow?.summary ?? null,
    latestUpdate: projectionRow?.latestUpdate ?? null,
    primaryLane: (topicRow.primaryLane as QualifyingLane) || 'HOKIM_RELATED',
    lanes: (projectionRow?.lanes as QualifyingLane[]) || [
      topicRow.primaryLane as QualifyingLane,
    ],
    additionalLanes: ((projectionRow?.lanes as QualifyingLane[]) || []).filter(
      (l) => l !== topicRow.primaryLane,
    ),
    evidenceCount: totalCount,
    latestMeaningfulActivityTimestamp:
      projectionRow?.latestMeaningfulActivityTimestamp?.toISOString() ||
      topicRow.latestRelevantEvidenceTimestamp.toISOString(),
    isNew: false,
    isUpdated: false,
    createdAt: topicRow.createdAt.toISOString(),
    updatedAt: topicRow.updatedAt.toISOString(),
  };

  const rows = (rawEvidenceRows.rows || rawEvidenceRows) as unknown as RawEvidenceRow[];

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const evidenceList: TopicEvidenceItem[] = pageRows.map((row) => {
    const { authorUsername, authorName } = sanitizeSenderAttribution(row.userMetadata);
    const deepLink = resolveTelegramDeepLink(
      row.telegramChatUsername,
      row.telegramChatId,
      row.telegramMessageId,
    );
    const isAnchor = Boolean(projectionRow && row.id === projectionRow.anchorEvidenceId);
    const originalDate = new Date(row.originalTimestamp);
    const isHokimRelated = hokimMatcher.test(row.verbatimText);

    return {
      id: row.id,
      topicId: row.topicId,
      verbatimText: row.verbatimText,
      contentType: row.contentType,
      originalTimestamp: originalDate.toISOString(),
      formattedTime: formatTashkentDateTime(originalDate),
      authorName,
      authorUsername,
      isAnchor,
      isHokimRelated,
      telegramDeepLink: deepLink,
    };
  });

  const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
  const nextCursor =
    hasNextPage && lastRow
      ? encodeEvidenceKeysetCursor(
          new Date(lastRow.originalTimestamp).toISOString(),
          lastRow.telegramMessageId,
          lastRow.id,
        )
      : null;

  return {
    topic: topicCard,
    anchorQuote: projectionRow?.anchorQuote ?? '',
    anchorEvidenceId: projectionRow?.anchorEvidenceId ?? '',
    evidence: evidenceList,
    totalCount,
    nextCursor,
    hasNextPage,
  };
}
