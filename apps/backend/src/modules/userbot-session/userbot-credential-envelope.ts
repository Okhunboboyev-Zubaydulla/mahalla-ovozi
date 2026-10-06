/**
 * Neutral home for the encrypted-credential envelope policy shared by the session service, the
 * key-rotation path, the preflight CLI and the userbot connection manager.
 *
 * A credential envelope is three nullable columns: a ciphertext, an IV and an authentication tag.
 * No write path in this codebase can produce a mix of present and absent columns, so a mix means
 * the stored credential is corrupt. This module owns that rule exactly once, in a form free of any
 * service, database or row-type dependency: both callers hold three named columns, so the
 * classifier takes them positionally and cannot be pulled into an import cycle with the service
 * that consumes it.
 */

/**
 * The three columns that make up the encrypted apiHash credential envelope.
 * All three are nullable with no defaults, so a row can be in three distinct states.
 */
export interface ApiHashEnvelopeColumns {
  apiHashEncrypted: string | null;
  apiHashIv: string | null;
  apiHashTag: string | null;
}

/**
 * The three columns that make up the encrypted sessionString credential envelope.
 * All three are nullable with no defaults, so a row can be in three distinct states.
 */
export interface SessionEnvelopeColumns {
  sessionEncrypted: string | null;
  sessionIv: string | null;
  sessionTag: string | null;
}

/**
 * `ABSENT` means the credential is legitimately not stored, `COMPLETE` means all three columns hold
 * a value, and `PARTIAL` means some but not all do - a state no write path in this codebase can
 * produce, and therefore a corrupt credential.
 */
export type EncryptedEnvelopeState = 'ABSENT' | 'COMPLETE' | 'PARTIAL';

/** Retained name for the apiHash-specific spelling of the same three states. */
export type ApiHashEnvelopeState = EncryptedEnvelopeState;

/**
 * Classifies one encrypted credential envelope from its three columns, in order: ciphertext, IV,
 * authentication tag.
 *
 * A blank or whitespace-only column counts as absent, matching how the rest of this codebase
 * decides whether ciphertext exists (non-null AND non-blank).
 *
 * The three columns are declared `string | null | undefined` so the classifier is TOTAL over what
 * a caller can actually hand it: `undefined` is treated exactly like `null` (absent) rather than
 * throwing a TypeError on `column.trim()`. A row read through a narrow projection, or a value
 * missing from an untyped caller, would otherwise crash the classifier instead of classifying it.
 */
export function classifyEncryptedEnvelope(
  ciphertext: string | null | undefined,
  iv: string | null | undefined,
  tag: string | null | undefined,
): EncryptedEnvelopeState {
  const presentCount = [ciphertext, iv, tag].filter((column) =>
    isEnvelopeColumnPresent(column),
  ).length;

  if (presentCount === 3) {
    return 'COMPLETE';
  }

  if (presentCount === 0) {
    return 'ABSENT';
  }

  return 'PARTIAL';
}

/**
 * Classifies a stored apiHash credential envelope into its three mutually exclusive states.
 * A thin wrapper over the shared classifier, so its callers keep naming their own columns.
 */
export function classifyApiHashEnvelope(row: ApiHashEnvelopeColumns): EncryptedEnvelopeState {
  return classifyEncryptedEnvelope(row.apiHashEncrypted, row.apiHashIv, row.apiHashTag);
}

/**
 * Classifies a stored sessionString credential envelope into its three mutually exclusive states.
 * A thin wrapper over the shared classifier, so its callers keep naming their own columns.
 */
export function classifySessionEnvelope(row: SessionEnvelopeColumns): EncryptedEnvelopeState {
  return classifyEncryptedEnvelope(row.sessionEncrypted, row.sessionIv, row.sessionTag);
}

/**
 * True only when a single envelope column holds a real value: non-null, non-undefined and not
 * whitespace-only.
 *
 * This is the per-column present/absent rule the classifier applies, factored out so a narrowing
 * call site cannot drift from it. A guard written as plain truthiness (`row.encrypted && row.iv &&
 * row.tag`) accepts an all-whitespace triple as present and hands blank strings to the decryptor;
 * this predicate does not.
 */
export function isEnvelopeColumnPresent(
  column: string | null | undefined,
): column is string {
  return column != null && column.trim().length > 0;
}

/** The three envelope columns narrowed to the non-null strings a decrypt call needs. */
export interface NarrowedEncryptedEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Narrows a raw credential triple to its non-null, non-blank form, or null when it is not COMPLETE.
 *
 * Returning null for BOTH 'ABSENT' and 'PARTIAL' is deliberate: this helper only decides whether a
 * decrypt call may run, and a caller that must tell "legitimately absent" apart from "corrupt"
 * keeps classifying separately. It exists because TypeScript cannot narrow three independent
 * columns from a call to `classifyEncryptedEnvelope`: a truthiness test is the only other way to
 * narrow them, and truthiness is exactly the check that lets an all-whitespace triple through.
 */
export function narrowEncryptedEnvelope(
  ciphertext: string | null | undefined,
  iv: string | null | undefined,
  tag: string | null | undefined,
): NarrowedEncryptedEnvelope | null {
  if (
    !isEnvelopeColumnPresent(ciphertext) ||
    !isEnvelopeColumnPresent(iv) ||
    !isEnvelopeColumnPresent(tag)
  ) {
    return null;
  }

  return { ciphertext, iv, tag };
}

/** Narrows a stored sessionString credential envelope, or null when it is not COMPLETE. */
export function narrowSessionEnvelope(
  row: SessionEnvelopeColumns,
): NarrowedEncryptedEnvelope | null {
  return narrowEncryptedEnvelope(row.sessionEncrypted, row.sessionIv, row.sessionTag);
}

/** Narrows a stored apiHash credential envelope, or null when it is not COMPLETE. */
export function narrowApiHashEnvelope(
  row: ApiHashEnvelopeColumns,
): NarrowedEncryptedEnvelope | null {
  return narrowEncryptedEnvelope(row.apiHashEncrypted, row.apiHashIv, row.apiHashTag);
}

/**
 * True only when a stored session row carries a complete credential envelope: the whole session
 * ciphertext triple, plus the whole apiHash triple whenever an apiHash is stored at all.
 *
 * An all-NULL or partially populated envelope is NOT re-established. That distinction is what
 * keeps the revocation guard honest: the revocation handler itself leaves the row with an intact
 * envelope behind a PENDING status, so status alone would be insufficient, while treating a
 * cleared or half-written row as recovered would unlock a session that cannot actually connect.
 */
export function isUserbotSessionEnvelopeComplete(
  row: SessionEnvelopeColumns & ApiHashEnvelopeColumns,
): boolean {
  if (classifySessionEnvelope(row) !== 'COMPLETE') {
    return false;
  }

  return classifyApiHashEnvelope(row) !== 'PARTIAL';
}
