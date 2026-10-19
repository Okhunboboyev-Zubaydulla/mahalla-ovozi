import { ApiError } from './api-client.js';

/**
 * Extracts a user-facing message from an unknown thrown value.
 *
 * Precedence: `ApiError` (canonical transport error) -> `Error` -> non-empty
 * string -> the caller-supplied fallback. `fallback` is required rather than a
 * default parameter so each call site keeps its own established copy.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message.length > 0 ? error.message : fallback;
  }
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : fallback;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}
