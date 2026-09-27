import { describe, it, expect, afterEach, vi } from 'vitest';
import { request, ApiError } from './api-client';

/** Trivial schema — the error path under test never reaches response validation. */
const passthroughSchema = {
  safeParse: (data: unknown) => ({ success: true, data: data as never }),
};

function stubErrorResponse(status: number, payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status,
      json: async () => payload,
    })),
  );
}

const validBlocker = {
  key: 'telegram_bot',
  label: 'Telegram бот',
  description: 'Туманга бот бириктирилмаган.',
  status: 'incomplete',
};

describe('api-client error envelope handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces code and message from a contract-valid envelope', async () => {
    stubErrorResponse(401, {
      error: { code: 'UNAUTHENTICATED', message: 'Сессия топилмади.' },
    });

    await expect(request('/api/v1/thing', {}, passthroughSchema)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'UNAUTHENTICATED',
      statusCode: 401,
    });
  });

  it('falls back to SERVER_ERROR when the envelope violates the contract', async () => {
    // `code` is required by ApiErrorEnvelopeSchema (common.ts:39) — a producer emitting
    // a code-less envelope must not be mistaken for a typed domain error.
    stubErrorResponse(500, { error: { message: 'boom' } });

    await expect(request('/api/v1/thing', {}, passthroughSchema)).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      statusCode: 500,
    });
  });

  it('validates DISTRICT_NOT_READY blockers against the typed carve-out shape', async () => {
    stubErrorResponse(409, {
      error: {
        code: 'DISTRICT_NOT_READY',
        message: 'Туман фаоллаштиришга тайёр эмас.',
        blockers: [validBlocker],
      },
    });

    const error = await request('/api/v1/thing', {}, passthroughSchema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('DISTRICT_NOT_READY');
    expect((error as ApiError).blockers).toEqual([validBlocker]);
  });

  it('rejects a malformed blocker rather than passing it through unvalidated', async () => {
    // `status` must be one of passed|incomplete|failed (districts.ts:112).
    const malformed = { key: 'telegram_bot', label: 'Бот', description: 'd', status: 'NOT_A_STATUS' };
    stubErrorResponse(409, {
      error: {
        code: 'DISTRICT_NOT_READY',
        message: 'Туман фаоллаштиришга тайёр эмас.',
        blockers: [malformed],
      },
    });

    const error = await request('/api/v1/thing', {}, passthroughSchema).catch((e: unknown) => e);

    // Fallback keeps the raw array so the UI still shows something rather than losing blockers.
    expect((error as ApiError).blockers).toEqual([malformed]);
  });

  it('strips unknown blocker fields, proving carve-out validation actually runs', async () => {
    // The carve-out schema strips unrecognised keys. A plain cast would pass the extra
    // field straight through to the UI, so this distinguishes validation from a cast.
    stubErrorResponse(409, {
      error: {
        code: 'DISTRICT_NOT_READY',
        message: 'Туман фаоллаштиришга тайёр эмас.',
        blockers: [{ ...validBlocker, internalDbColumn: 'leaked' }],
      },
    });

    const error = await request('/api/v1/thing', {}, passthroughSchema).catch((e: unknown) => e);

    expect((error as ApiError).blockers).toEqual([validBlocker]);
    expect((error as ApiError).blockers?.[0]).not.toHaveProperty('internalDbColumn');
  });

  it('omits blockers when the envelope carries none', async () => {
    stubErrorResponse(403, {
      error: { code: 'FORBIDDEN', message: 'Рухсат йўқ.' },
    });

    const error = await request('/api/v1/thing', {}, passthroughSchema).catch((e: unknown) => e);

    expect((error as ApiError).blockers).toBeUndefined();
  });
});
