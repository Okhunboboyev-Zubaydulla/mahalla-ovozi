import { ApiErrorEnvelopeSchema } from '@mahalla-ovozi/api-contracts';
import type { ApiErrorEnvelope, ApiValidationErrorItem } from '@mahalla-ovozi/api-contracts';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/**
 * Producer-side gate for the shared `ApiErrorEnvelope` contract
 * (packages/api-contracts/src/common.ts:37-46).
 *
 * The browser parses every non-2xx body with `ApiErrorEnvelopeSchema.safeParse`
 * (apps/web/src/lib/api-client.ts:68). When a producer violates the contract the
 * client cannot report the real failure and substitutes an opaque `SERVER_ERROR`.
 * Serialising here — and validating against the schema before the envelope leaves —
 * turns that client-side runtime failure into a producer-side invariant.
 *
 * Carve-out respected: strongly-typed domain errors carrying typed payload arrays
 * (e.g. `DistrictActivationBlockedErrorEnvelope`, code `DISTRICT_NOT_READY`) keep
 * their own shape. This module only asserts that `blockers` IS an array and drops
 * entries that are not plain objects (the schema requires `Record<string,unknown>[]`);
 * it never validates or rewrites the domain fields inside an item, so the typed
 * carve-out reaches the wire intact and stays the client's to validate.
 */

const INTERNAL_ERROR_STATUS_CODE = 500;
const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
const INTERNAL_ERROR_MESSAGE = 'Серверда кутилмаган хатолик юз берди.';

const VALIDATION_ERROR_STATUS_CODE = 400;
const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';
const VALIDATION_ERROR_MESSAGE = 'Киритилган маълумотларда хатолик бор.';

const NOT_FOUND_STATUS_CODE = 404;
const NOT_FOUND_CODE = 'NOT_FOUND';
const NOT_FOUND_MESSAGE = 'Сўралган манзил топилмади.';

/** A contract-valid error envelope paired with the HTTP status it must be sent with. */
export interface SerializedApiError {
  readonly statusCode: number;
  readonly body: ApiErrorEnvelope;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readErrorProperty(error: unknown, key: string): unknown {
  if (!isPlainRecord(error)) {
    return undefined;
  }
  return error[key];
}

function isValidationError(error: unknown): boolean {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return true;
  }
  if (!isPlainRecord(error)) {
    return false;
  }
  return error['name'] === 'ZodError' || Array.isArray(error['issues']);
}

/**
 * Collects raw validation issues from either zod-fastify schema validation or a
 * bare `ZodError`. Both shapes carry `{ path, message, code }`-like issue objects.
 */
function extractValidationIssues(error: unknown): readonly unknown[] {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return error.validation.map((entry) => entry.params.issue);
  }
  if (isPlainRecord(error) && Array.isArray(error['issues'])) {
    return error['issues'];
  }
  return [];
}

/**
 * Narrows one raw issue to the contract's `ApiValidationErrorItem`. Returns null when
 * the issue cannot satisfy the schema (an empty message is the realistic case) — a
 * partial issue list is better than an envelope the client will reject wholesale.
 */
function toValidationErrorItem(issue: unknown): ApiValidationErrorItem | null {
  if (!isPlainRecord(issue)) {
    return null;
  }
  const rawPath = issue['path'];
  const rawMessage = issue['message'];
  if (!Array.isArray(rawPath)) {
    return null;
  }
  if (typeof rawMessage !== 'string' || rawMessage.length === 0) {
    return null;
  }
  const path = rawPath.filter(
    (segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number',
  );
  const rawCode = issue['code'];
  if (typeof rawCode === 'string' && rawCode.length > 0) {
    return { path, message: rawMessage, code: rawCode };
  }
  return { path, message: rawMessage };
}

function collectValidationErrorItems(issues: readonly unknown[]): ApiValidationErrorItem[] {
  const items: ApiValidationErrorItem[] = [];
  for (const issue of issues) {
    const item = toValidationErrorItem(issue);
    if (item !== null) {
      items.push(item);
    }
  }
  return items;
}

function resolveStatusCode(error: unknown): number {
  const raw = readErrorProperty(error, 'statusCode');
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 400 || raw > 599) {
    return INTERNAL_ERROR_STATUS_CODE;
  }
  return raw;
}

function resolveErrorCode(error: unknown): string {
  const raw = readErrorProperty(error, 'code');
  if (typeof raw !== 'string' || raw.length === 0) {
    return INTERNAL_ERROR_CODE;
  }
  return raw;
}

function resolveErrorMessage(error: unknown, statusCode: number): string {
  // Client-safe 4xx messages are preserved; 5xx never leaks internals.
  if (statusCode < 500 && error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return INTERNAL_ERROR_MESSAGE;
}

function buildValidationError(error: unknown): SerializedApiError {
  const items = collectValidationErrorItems(extractValidationIssues(error));
  const firstItem = items.length > 0 ? items[0] : undefined;
  const message = firstItem ? firstItem.message : VALIDATION_ERROR_MESSAGE;

  const body = ApiErrorEnvelopeSchema.parse({
    error: {
      code: VALIDATION_ERROR_CODE,
      message,
      statusCode: VALIDATION_ERROR_STATUS_CODE,
      validationErrors: items,
    },
  });

  return { statusCode: VALIDATION_ERROR_STATUS_CODE, body };
}

function buildGenericError(error: unknown): SerializedApiError {
  const statusCode = resolveStatusCode(error);

  const payload: {
    code: string;
    message: string;
    statusCode: number;
    blockers?: Record<string, unknown>[];
    details?: Record<string, unknown>;
    validationErrors?: ApiValidationErrorItem[];
  } = {
    code: resolveErrorCode(error),
    message: resolveErrorMessage(error, statusCode),
    statusCode,
  };

  const rawBlockers = readErrorProperty(error, 'blockers');
  if (Array.isArray(rawBlockers)) {
    payload.blockers = rawBlockers.filter(isPlainRecord);
  }

  const rawDetails = readErrorProperty(error, 'details');
  if (isPlainRecord(rawDetails)) {
    payload.details = rawDetails;
  }

  const rawValidationErrors = readErrorProperty(error, 'validationErrors');
  if (Array.isArray(rawValidationErrors)) {
    payload.validationErrors = collectValidationErrorItems(rawValidationErrors);
  }

  const body = ApiErrorEnvelopeSchema.parse({ error: payload });
  return { statusCode, body };
}

/**
 * Serialises any thrown value into a contract-valid error envelope.
 *
 * Validation issues are reported as `400 VALIDATION_ERROR`; everything else keeps its
 * own `statusCode`/`code`/`blockers`/`details` and is normalised into the shared shape.
 * The returned body is always the parsed envelope, so a malformed envelope cannot be
 * sent — a parse failure here is a programming error and is deliberately loud.
 */
export function serializeApiError(error: unknown): SerializedApiError {
  if (isValidationError(error)) {
    return buildValidationError(error);
  }
  return buildGenericError(error);
}

/** Envelope for the unmatched-route handler. */
export function serializeNotFoundError(): SerializedApiError {
  const body = ApiErrorEnvelopeSchema.parse({
    error: {
      code: NOT_FOUND_CODE,
      message: NOT_FOUND_MESSAGE,
    },
  });
  return { statusCode: NOT_FOUND_STATUS_CODE, body };
}
