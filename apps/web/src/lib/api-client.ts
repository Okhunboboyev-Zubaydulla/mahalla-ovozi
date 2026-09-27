import {
  ApiErrorEnvelopeSchema,
  DistrictNotReadyErrorEnvelopeSchema,
  PrerequisiteItem,
} from '@mahalla-ovozi/api-contracts';

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


export async function request<T>(
  url: string,
  options: RequestInit,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: unknown } }
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: 'include', // Include host-scoped session cookies
      headers,
    });
  } catch (networkErr: unknown) {
    // Let intentionally aborted queries propagate without classifying as network outages
    if (networkErr instanceof DOMException && networkErr.name === 'AbortError') {
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

  let body: unknown;
  try {
    body = await response.json();
  } catch {
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
}
