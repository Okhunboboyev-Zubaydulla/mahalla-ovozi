import {
  ApiErrorEnvelopeSchema,
  DistrictNotReadyErrorEnvelopeSchema,
  PrerequisiteItem,
} from '@mahalla-ovozi/api-contracts';

/** Default deadline for a single API request (headers + body). */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Validates blocker payloads against the strongly-typed carve-out shape.
 *
 * `ApiErrorEnvelopeSchema` types `blockers` as `Record<string, unknown>[]`
 * (common.ts:43), so a successful generic parse proves nothing about their
 * structure. The transport contract for `DISTRICT_NOT_READY` carries
 * `PrerequisiteItem[]` under the documented carve-out (common.ts:25-28).
 *
 * Returns the validated array when the body conforms to that carve-out, and falls
 * back to the raw array otherwise so a producer bug degrades rather than silently
 * dropping blockers the UI needs.
 */
function resolveBlockers(body: unknown, rawBlockers: unknown): PrerequisiteItem[] | undefined {
  if (rawBlockers === undefined) {
    return undefined;
  }
  const carveOut = DistrictNotReadyErrorEnvelopeSchema.safeParse(body);
  if (carveOut.success) {
    return carveOut.data.error.blockers;
  }
  return rawBlockers as PrerequisiteItem[];
}

export class ApiError extends Error {
  code: string;
  statusCode: number;
  isNetworkError: boolean;
  blockers?: PrerequisiteItem[];

  constructor(
    message: string,
    code: string,
    statusCode: number,
    isNetworkError: boolean,
    blockers?: PrerequisiteItem[]
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.isNetworkError = isNetworkError;
    this.blockers = blockers;
  }
}

export interface RequestOptions extends RequestInit {
  /** Deadline in milliseconds for the whole request. `0` (or negative) disables it. */
  timeoutMs?: number;
}

/**
 * Builds a signal that aborts when either the caller aborts or the deadline
 * elapses. `AbortSignal.any` is avoided on purpose for older browsers.
 * Returns the composed signal plus the bookkeeping needed to classify aborts.
 */
function createDeadlineSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number
): { signal: AbortSignal; didTimeout: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const forwardAbort = () => {
    controller.abort();
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', forwardAbort);
    }
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
  }

  const dispose = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (callerSignal) {
      callerSignal.removeEventListener('abort', forwardAbort);
    }
  };

  return { signal: controller.signal, didTimeout: () => didTimeout, dispose };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createTimeoutError(): ApiError {
  return new ApiError(
    'Сервер жавоби кутиш вақти тугади. Қайта уриниб кўринг.',
    'TIMEOUT',
    0,
    true
  );
}

export async function request<T>(
  url: string,
  options: RequestOptions,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: unknown } }
): Promise<T> {
  const { timeoutMs, ...fetchOptions } = options;
  const deadlineMs = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (fetchOptions.body) {
    headers['Content-Type'] = 'application/json';
  }

  const deadline = createDeadlineSignal(fetchOptions.signal, deadlineMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        credentials: 'include', // Include host-scoped session cookies
        headers,
        signal: deadline.signal,
      });
    } catch (networkErr: unknown) {
      // Our own deadline fired: report a distinguishable transport failure
      if (deadline.didTimeout()) {
        throw createTimeoutError();
      }
      // Let intentionally aborted queries propagate without classifying as network outages
      if (isAbortError(networkErr)) {
        throw networkErr;
      }
      // Network uncertainty: server unreachable, DNS failure, offline
      throw new ApiError(
        'Сервер билан алоқа мавжуд эмас. Тармоқни текширинг.',
        'NETWORK_ERROR',
        0,
        true
      );
    }

    // The composed signal also governs the body read, so a stalled body
    // rejects instead of hanging forever.
    let body: unknown;
    try {
      body = await response.json();
    } catch (bodyErr: unknown) {
      if (deadline.didTimeout()) {
        throw createTimeoutError();
      }
      if (isAbortError(bodyErr)) {
        throw bodyErr;
      }
      body = null;
    }

    if (!response.ok) {
      const errorParsed = ApiErrorEnvelopeSchema.safeParse(body);
      if (errorParsed.success) {
        throw new ApiError(
          errorParsed.data.error.message,
          errorParsed.data.error.code,
          response.status,
          false,
          resolveBlockers(body, errorParsed.data.error.blockers)
        );
      }
      throw new ApiError(
        'Серверда кутилмаган хатолик юз берди.',
        'SERVER_ERROR',
        response.status,
        false
      );
    }

    const result = schema.safeParse(body);
    if (!result.success || result.data === undefined) {
      if (typeof console !== 'undefined' && result.error) {
        console.error(
          `[api-client] Schema validation failed for ${url}:`,
          result.error,
        );
      }
      throw new ApiError(
        'Сервердан нотўғри форматдаги маълумот олинди.',
        'INVALID_RESPONSE',
        response.status,
        false
      );
    }

    return result.data;
  } finally {
    deadline.dispose();
  }
}
