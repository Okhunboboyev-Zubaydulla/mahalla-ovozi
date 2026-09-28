import {
  ComponentHealthObservation,
  ComponentScope,
  ComponentType,
  IssueCategory,
  IssueSeverity,
  IssueStatus,
  HealthStatus,
  OperationalIssue,
} from '@mahalla-ovozi/api-contracts';
import { isIssueRetryEligible, deriveRetryJobSpec } from './retry-evaluator.js';
import type { OperationalIssueEntity } from '../../adapters/db/schema/index.js';

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  Critical: 0,
  Warning: 1,
  Information: 2,
};

/**
 * Derives a deterministic logical identity key for an operational issue (Story 4.2 AC 1).
 * Format: `${scope}:${districtId || 'global'}:${component}:${issueCategory}`
 */
export function generateLogicalKey(
  scope: ComponentScope,
  districtId: string | null,
  component: ComponentType,
  issueCategory: string,
): string {
  const scopeKey = scope.toUpperCase();
  const districtKey = districtId || 'global';
  return `${scopeKey}:${districtKey}:${component}:${issueCategory}`;
}

/**
 * Pure evaluation function classifying severity from technical component observation (Story 4.2 AC 2).
 * - Unavailable on required component -> Critical
 * - Delayed or Degraded -> Warning
 * - Healthy, Quiet, Unknown -> null (no issue created)
 */
export function classifyIssueSeverity(
  observation: ComponentHealthObservation,
): IssueSeverity | null {
  if (!observation.isApplicable) {
    return null;
  }

  switch (observation.status) {
    case 'Unavailable':
      return 'Critical';
    case 'Delayed':
    case 'Degraded':
      return 'Warning';
    case 'Healthy':
    case 'Quiet':
    case 'Unknown':
    default:
      return null;
  }
}

export interface IssueDerivedMetadata {
  sanitizedTitle: string;
  sanitizedDescription: string;
  recommendedAction: string;
  targetRoute: string | null;
  issueCategory: IssueCategory;
}

/**
 * Maps technical health observation and optional district name to approved Uzbek Cyrillic diagnostics (Story 4.2 AC 3, AC 5).
 * Privacy-safe: excludes raw stack traces, tokens, citizen text, and credentials.
 */
export function deriveIssueMetadata(
  observation: ComponentHealthObservation,
  districtName?: string | null,
): IssueDerivedMetadata {
  const { component, districtId, errorCode, status } = observation;

  switch (component) {
    case 'telegram_bot': {
      if (errorCode === 'BOT_TOKEN_INVALID' || errorCode === 'TELEGRAM_BOT_INVALID') {
        return {
          issueCategory: 'BOT_TOKEN_INVALID',
          sanitizedTitle: 'Telegram бот токени нотўғри',
          sanitizedDescription: districtName
            ? `${districtName} учун киритилган Telegram бот токени яроқсиз ёки хато.`
            : 'Telegram бот токени яроқсиз ёки хато.',
          recommendedAction: 'Бот созламаларини текширинг ва токенни қайта киритинг',
          targetRoute: districtId ? `/telegram-setup?districtId=${districtId}` : '/telegram-setup',
        };
      }
      return {
        issueCategory: 'BOT_DISCONNECTED',
        sanitizedTitle: 'Telegram бот уланмаган ёки фаол эмас',
        sanitizedDescription: districtName
          ? `${districtName} Telegram боти билан алоқа мавжуд эмас.`
          : 'Telegram боти билан алоқа мавжуд эмас.',
        recommendedAction: 'Бот созламаларини текширинг ва боғланишни қайта текширинг',
        targetRoute: districtId ? `/telegram-setup?districtId=${districtId}` : '/telegram-setup',
      };
    }

    case 'telegram_groups': {
      return {
        issueCategory: 'TELEGRAM_GROUP_DISCONNECTED',
        sanitizedTitle: 'Telegram гуруҳларига уланишда хатолик',
        sanitizedDescription: districtName
          ? `${districtName} Telegram гуруҳлари билан боғланишда муаммо аниқланди.`
          : 'Telegram гуруҳлари билан боғланишда муаммо аниқланди.',
        recommendedAction: 'Гуруҳ уланишлари ва бот администратор ҳуқуқларини текширинг',
        targetRoute: districtId ? `/telegram-setup?districtId=${districtId}` : '/telegram-setup',
      };
    }

    case 'database': {
      return {
        issueCategory: 'DATABASE_CONNECTION_ERROR',
        sanitizedTitle: 'Маълумотлар базасига уланишда хатолик',
        sanitizedDescription: 'PostgreSQL маълумотлар базаси сервери билан алоқа йўқолди ёки сўровлар бажарилмаяпти.',
        recommendedAction: 'PostgreSQL сервери ҳолати ва тармоқни текширинг',
        targetRoute: null,
      };
    }

    case 'processing_queue': {
      if (status === 'Unavailable') {
        return {
          issueCategory: 'QUEUE_UNAVAILABLE',
          sanitizedTitle: 'Навбат тизими ишламаяпти',
          sanitizedDescription: 'pg-boss навбат тизими жараёнлари тўхтаб қолган ёки жавоб бермаяпти.',
          recommendedAction: 'pg-boss worker жараёнини қайта ишга туширинг',
          targetRoute: null,
        };
      }
      return {
        issueCategory: 'QUEUE_BACKLOG_DELAY',
        sanitizedTitle: 'Навбат тизимида кечикиш кузатилмоқда',
        sanitizedDescription: 'Навбатдаги вазифалар белгиланган вақтдан кечикмоқда.',
        recommendedAction: 'pg-boss worker жараёни ва навбат ҳажмини текширинг',
        targetRoute: null,
      };
    }

    case 'storage': {
      return {
        issueCategory: 'STORAGE_UNAVAILABLE',
        sanitizedTitle: 'Маълумотлар сақлаш тизимида хатолик',
        sanitizedDescription: 'Файллар ёки маълумотлар сақлагич тизимига уланишда хатолик мавжуд.',
        recommendedAction: 'Диск хотираси ва файл сақлагич ҳолатини текширинг',
        targetRoute: null,
      };
    }

    case 'web_application': {
      return {
        issueCategory: 'WEB_APP_UNAVAILABLE',
        sanitizedTitle: 'Веб илова ишлашида муаммо',
        sanitizedDescription: 'Веб илова асосий сервери соғломлик текширувидан ўта олмади.',
        recommendedAction: 'Сервер хизмати ва тармоқ ҳолатини текширинг',
        targetRoute: null,
      };
    }

    case 'message_intake': {
      return {
        issueCategory: 'MESSAGE_INTAKE_DELAY',
        sanitizedTitle: 'Хабарларни қабул қилишда кечикиш',
        sanitizedDescription: districtName
          ? `${districtName} хабарларни қабул қилиш навбатида 5 дақиқадан ортиқ кечикиш кузатилмоқда.`
          : 'Хабарларни қабул қилиш навбатида 5 дақиқадан ортиқ кечикиш кузатилмоқда.',
        recommendedAction: 'Webhook қабули ва intake навбатини текширинг',
        targetRoute: null,
      };
    }

    case 'ai_operations': {
      return {
        issueCategory: 'AI_SERVICE_DEGRADED',
        sanitizedTitle: 'АИ таҳлил жараёнида кечикиш ёки хатолик',
        sanitizedDescription: districtName
          ? `${districtName} учун АИ таҳлил сўровларида хатоликлар ёки кечикиш кузатилмоқда.`
          : 'АИ таҳлил сўровларида хатоликлар ёки кечикиш кузатилмоқда.',
        recommendedAction: 'АИ провайдери API ҳолати ва квоталарини текширинг',
        targetRoute: null,
      };
    }

    case 'retention_jobs': {
      return {
        issueCategory: 'RETENTION_JOB_DELAY',
        sanitizedTitle: 'Маълумотларни тозалаш иши кечикмоқда',
        sanitizedDescription: 'Глобал маълумотларни сақлаш муддати бўйича тозалаш cron вазифаси 24 соатдан ортиқ бажарилмаган.',
        recommendedAction: 'Кунлик тозалаш cron ишини текширинг',
        targetRoute: null,
      };
    }

    case 'district_retention': {
      return {
        issueCategory: 'DISTRICT_RETENTION_DELAY',
        sanitizedTitle: 'Туман маълумотларини тозалаш иши кечикмоқда',
        sanitizedDescription: districtName
          ? `${districtName} маълумотларини сақлаш муддати бўйича тозалаш иши кечикмоқда.`
          : 'Туман маълумотларини сақлаш муддати бўйича тозалаш иши кечикмоқда.',
        recommendedAction: 'Туман маълумотларини тозалаш жараёнини текширинг',
        targetRoute: null,
      };
    }

    default: {
      return {
        issueCategory: 'OPERATIONAL_MAINTENANCE_NOTICE',
        sanitizedTitle: 'Техник огоҳлантириш',
        sanitizedDescription: 'Тизим ҳолати текширувида техник диққат талаб қилувчи ҳолат аниқланди.',
        recommendedAction: 'Тизим созламалари ва журналларини текширинг',
        targetRoute: null,
      };
    }
  }
}

/**
 * Deterministically sorts operational issues (Story 4.2 AC 4).
 * Order: Critical (0) > Warning (1) > Information (2).
 * Secondary: startedAt DESC (newest first).
 * Deterministic tiebreaker: id ascending.
 */
export function sortOperationalIssues<
  T extends { severity: IssueSeverity; startedAt: string | Date; id: string },
>(issues: T[]): T[] {
  return [...issues].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) {
      return rankDiff;
    }

    const timeA = new Date(a.startedAt).getTime();
    const timeB = new Date(b.startedAt).getTime();
    if (timeB !== timeA) {
      return timeB - timeA;
    }

    return a.id.localeCompare(b.id);
  });
}

/**
 * Canonical formatting function mapping an operational issue database entity to contract DTO (Story 4.2 AC 1, AC 4).
 * Pure evaluation: derives retry eligibility, metadata, and ISO timestamps.
 */
export function formatOperationalIssue(
  row: OperationalIssueEntity,
  districtName?: string | null,
): OperationalIssue {
  const isRetryEligible =
    row.status === 'ACTIVE' &&
    isIssueRetryEligible(row.issueCategory as IssueCategory, row.metadata) &&
    deriveRetryJobSpec({
      id: row.id,
      scope: row.scope,
      districtId: row.districtId,
      component: row.component,
      issueCategory: row.issueCategory,
      metadata: row.metadata,
    }) !== null;
  const pendingRetry = Boolean(row.metadata?.pendingRetry);
  const retryCount =
    typeof row.metadata?.retryCount === 'number'
      ? row.metadata.retryCount
      : undefined;
  const lastRetryAt =
    typeof row.metadata?.lastRetryAt === 'string'
      ? row.metadata.lastRetryAt
      : null;

  return {
    id: row.id,
    logicalKey: row.logicalKey,
    scope: row.scope as ComponentScope,
    districtId: row.districtId,
    districtName: districtName || null,
    component: row.component as ComponentType,
    issueCategory: row.issueCategory as IssueCategory,
    severity: row.severity as IssueSeverity,
    status: row.status as IssueStatus,
    healthStatus: row.healthStatus as HealthStatus,
    sanitizedTitle: row.sanitizedTitle,
    sanitizedDescription: row.sanitizedDescription,
    recommendedAction: row.recommendedAction,
    targetRoute: row.targetRoute,
    startedAt: row.startedAt.toISOString(),
    latestCheckAt: row.latestCheckAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    isRetryEligible,
    retryCount,
    pendingRetry,
    lastRetryAt,
    metadata: row.metadata,
  };
}
