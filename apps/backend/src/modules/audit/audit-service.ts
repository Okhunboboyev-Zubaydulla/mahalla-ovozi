import { AuditActionCategory, AuditActionOutcome } from '@mahalla-ovozi/api-contracts';
import crypto from 'node:crypto';
import type { DbOrTx } from '../../adapters/db/client.js';
import { auditEvents, NewAuditEvent } from '../../adapters/db/schema/index.js';

export type { DbOrTx }; // re-export for existing consumers


const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'hashedpassword',
  'token',
  'tokenhash',
  'refreshtoken',
  'accesstoken',
  'sessiontoken',
  'authtoken',
  'jwt',
  'jwttoken',
  'cookie',
  'cookies',
  'secret',
  'clientsecret',
  'webhooksecret',
  'privatekey',
  'authorization',
  'apikey',
  'bottoken',
  'bearer',
  'temporarypassword',
  'credential',
  'credentials',
]);

export function redactStringValue(val: string): string {
  return val
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{34,36}\b/g, '[BOT_TOKEN_REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/gi, 'sk-[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/gi, 'AIza[REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
}

export function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    if (SENSITIVE_KEYS.has(normalizedKey)) {
      continue; // Scrub sensitive fields completely
    }
    if (typeof value === 'string') {
      sanitized[key] = redactStringValue(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === 'string'
          ? redactStringValue(item)
          : typeof item === 'object' && item !== null
            ? sanitizeMetadata(item as Record<string, unknown>)
            : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function classifyAuditActionCategory(action: string): AuditActionCategory {
  if (
    action.startsWith('AUTH_') ||
    action === 'ACCOUNT_PO_CREATED' ||
    action === 'ACCOUNT_PO_PASSWORD_RESET' ||
    action === 'ACCOUNT_HOKIM_FIRST_LOGIN_PASSWORD_CHANGED'
  ) {
    return 'AUTH_SECURITY';
  }

  if (
    action.startsWith('ACCOUNT_HOKIM_')
  ) {
    return 'HOKIM_MANAGEMENT';
  }

  if (
    action.startsWith('DISTRICT_TELEGRAM_BOT_') ||
    action.startsWith('DISTRICT_GROUP_') ||
    action.startsWith('USERBOT_SESSION_')
  ) {
    return 'TELEGRAM_INTEGRATION';
  }

  if (
    action.startsWith('DISTRICT_')
  ) {
    return 'DISTRICT_ADMINISTRATION';
  }

  if (
    action.startsWith('OPERATIONAL_ISSUE_') ||
    action.startsWith('OPERATIONAL_RETRY_')
  ) {
    return 'OPERATIONAL_LIFECYCLE';
  }

  return 'OPERATIONAL_LIFECYCLE';
}

export function determineAuditActionOutcome(
  action: string,
  metadata?: Record<string, unknown>,
): AuditActionOutcome {
  if (
    metadata?.outcome === 'FAILURE' ||
    metadata?.status === 'FAILED' ||
    metadata?.success === false
  ) {
    return 'FAILURE';
  }
  if (action.endsWith('_FAILED') || action.endsWith('_FAILURE')) {
    return 'FAILURE';
  }
  if (
    metadata?.outcome === 'SUCCESS' ||
    metadata?.status === 'SUCCESS' ||
    metadata?.success === true
  ) {
    return 'SUCCESS';
  }
  return 'SUCCESS';
}

export async function recordAuditEvent(
  db: DbOrTx,
  params: {
    districtId?: string | null;
    actorId?: string | null;
    actorRole?: string | null;
    action: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const event: NewAuditEvent = {
    id: `aud_${crypto.randomUUID()}`,
    districtId: params.districtId || null,
    actorId: params.actorId || null,
    actorRole: params.actorRole || null,
    action: params.action,
    ipAddress: params.ipAddress || null,
    userAgent: params.userAgent || null,
    metadata: sanitizeMetadata(params.metadata),
    createdAt: new Date(),
  };

  await db.insert(auditEvents).values(event);
}
