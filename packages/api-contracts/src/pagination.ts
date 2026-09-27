import { z } from 'zod';

/**
 * Keyset cursor pagination query schema.
 *
 * ARCHITECTURAL NOTE ON SCHEMA DEFAULTS:
 * Project engineering standards strictly forbid default parameter values in TypeScript function signatures.
 * However, Zod schemas used for HTTP query string parsing (such as CursorPaginationQuerySchema)
 * are an intentional and sanctioned exception to this rule: incoming HTTP query parameters
 * are omitted when optional, and query schemas legitimately need default fallback values
 * (e.g., default limit, default direction) during request validation and coercion at the API boundary.
 */
export const CursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  direction: z.enum(['forward', 'backward']).default('forward'),
});
export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>;

export const CursorPaginationMetaSchema = z.object({
  limit: z.number().int().min(1),
  hasNextPage: z.boolean(),
  hasPrevPage: z.boolean(),
  nextCursor: z.string().nullable().optional(),
  prevCursor: z.string().nullable().optional(),
  totalCount: z.number().int().min(0).optional(),
});
export type CursorPaginationMeta = z.infer<typeof CursorPaginationMetaSchema>;

export function createKeysetPageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    pagination: CursorPaginationMetaSchema,
  });
}

export type KeysetPage<T> = {
  items: T[];
  pagination: CursorPaginationMeta;
};

export interface KeysetCursorPayload {
  id: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

declare const Buffer:
  | {
      from: (
        str: string,
        encoding?: string,
      ) => { toString: (encoding?: string) => string };
    }
  | undefined;

declare const btoa: ((data: string) => string) | undefined;
declare const atob: ((data: string) => string) | undefined;

/**
 * Encodes an opaque, URL-safe Base64URL keyset cursor payload.
 */
export function encodeKeysetCursor<T extends KeysetCursorPayload = KeysetCursorPayload>(payload: T): string {
  const json = JSON.stringify(payload);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64url');
  }
  if (typeof btoa !== 'undefined') {
    return btoa(encodeURIComponent(json))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
  throw new Error('Base64 encoding environment unavailable');
}

/**
 * Safely decodes an opaque Base64URL keyset cursor payload.
 * Returns null if the cursor is malformed or invalid JSON.
 */
export function decodeKeysetCursor<T extends KeysetCursorPayload = KeysetCursorPayload>(
  cursor: string | null | undefined,
): T | null {
  if (!cursor || typeof cursor !== 'string') {
    return null;
  }
  try {
    let json: string;
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(cursor, 'base64url').toString('utf8');
    } else if (typeof atob !== 'undefined') {
      const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
      json = decodeURIComponent(atob(base64));
    } else {
      return null;
    }
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.id !== 'string') {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

