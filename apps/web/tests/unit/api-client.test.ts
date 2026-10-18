import { describe, it, expect, vi, afterEach } from 'vitest';
import { request, ApiError } from '../../src/lib/api-client.js';

/**
 * The module consumes any object exposing `safeParse`; a pass-through schema
 * keeps these transport tests focused on timeout/abort semantics rather than
 * payload validation.
 */
const passthroughSchema = {
  safeParse: (data: unknown) => ({ success: true as const, data }),
};

/**
 * A fetch double that never resolves on its own and only settles when the
 * composed AbortSignal fires - exactly like a real hung request.
 */
function createHangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  });
}

describe('api-client request deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects with a TIMEOUT ApiError when the request never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', createHangingFetch());

    const outcome = request('/api/test', {}, passthroughSchema).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    const error = await outcome;

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TIMEOUT');
    expect((error as ApiError).statusCode).toBe(0);
    expect((error as ApiError).isNetworkError).toBe(true);
  });

  it('re-throws a caller-initiated AbortError instead of the TIMEOUT ApiError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', createHangingFetch());

    const controller = new AbortController();
    const outcome = request('/api/test', { signal: controller.signal }, passthroughSchema).catch(
      (e) => e,
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = await outcome;

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('does not fire a timeout when timeoutMs is 0', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', createHangingFetch());

    let settled = false;
    const promise = request('/api/test', { timeoutMs: 0 }, passthroughSchema);
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });

  it('rejects with TIMEOUT when the response body stalls past the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        } as unknown as Response),
      ),
    );

    const outcome = request('/api/test', {}, passthroughSchema).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    const error = await outcome;

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TIMEOUT');
    expect((error as ApiError).statusCode).toBe(0);
    expect((error as ApiError).isNetworkError).toBe(true);
  });
});
