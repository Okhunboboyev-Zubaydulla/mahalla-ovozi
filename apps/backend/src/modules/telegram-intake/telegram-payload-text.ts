/**
 * Single owner of Telegram payload-shape knowledge and verbatim display-text resolution.
 *
 * Every reader that must answer "what is the display text of this message?" calls
 * `extractVerbatimDisplayText`. The precedence order below is AUTHORITATIVE: it was the
 * order used by the intake-centric signal read path before this module existed, and the
 * search predicate in the management service derives its JSON arms from the same
 * TELEGRAM_MESSAGE_UPDATE_KEYS list so the two cannot drift again.
 */

/**
 * Terminal fallback for display callers. NOT returned by `extractVerbatimDisplayText` —
 * that function returns `null` for "unresolvable" so guards such as
 * `if (prevText)` keep their meaning. Display callers apply `?? EXTRACTED_TEXT_FALLBACK`.
 */
export const EXTRACTED_TEXT_FALLBACK = '(Матн мавжуд эмас)';

/**
 * The Telegram message-update envelopes this system ingests, in resolution order.
 * The first present envelope wins. Also the single source for the SQL search predicate's
 * nested JSON arms.
 */
export const TELEGRAM_MESSAGE_UPDATE_KEYS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_message',
  'edited_business_message',
] as const;

export type TelegramMessageUpdateKey = (typeof TELEGRAM_MESSAGE_UPDATE_KEYS)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Returns the raw Telegram message object carried by a stored `raw_payload`, or null when
 * the payload holds no recognised message envelope. Envelope values that are not objects
 * are skipped rather than accepted.
 */
export function resolveTelegramMessageObject(
  rawPayload: unknown,
): Record<string, unknown> | null {
  const payload = asRecord(rawPayload);
  if (!payload) return null;

  for (const key of TELEGRAM_MESSAGE_UPDATE_KEYS) {
    const envelope = asRecord(payload[key]);
    if (envelope) return envelope;
  }

  return null;
}

function renderDepartureLabel(leftParticipant: unknown, leftMember: unknown): string {
  const user = asRecord(leftParticipant) ?? asRecord(leftMember);
  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '';

  return name
    ? `(Хизмат хабари: ${String(name)} гуруҳни тарк этди)`
    : `(Хизмат хабари: фойдаланувчи гуруҳни тарк этди)`;
}

/**
 * Resolves the verbatim display text of a message from accepted-evidence text and/or a
 * stored raw payload. Returns `null` when nothing is resolvable — never the fallback label.
 *
 * Precedence (do not reorder):
 *   1. accepted evidence `verbatimText` column
 *   2. root-level `verbatimText`
 *   3. root-level `text`
 *   4. message-envelope `text`
 *   5. message-envelope `caption`
 *   6. service / media labels
 */
export function extractVerbatimDisplayText(
  evidenceVerbatimText: string | null | undefined,
  rawPayload: unknown,
): string | null {
  const evidenceText = asNonEmptyString(evidenceVerbatimText);
  if (evidenceText) return evidenceText;

  const raw = asRecord(rawPayload) ?? {};

  const rootVerbatimText = asNonEmptyString(raw.verbatimText);
  if (rootVerbatimText) return rootVerbatimText;

  const rootText = asNonEmptyString(raw.text);
  if (rootText) return rootText;

  const message = resolveTelegramMessageObject(raw);

  if (message) {
    const messageText = asNonEmptyString(message.text);
    if (messageText) return messageText;

    const messageCaption = asNonEmptyString(message.caption);
    if (messageCaption) return messageCaption;

    if (message.left_chat_participant || message.left_chat_member) {
      return renderDepartureLabel(message.left_chat_participant, message.left_chat_member);
    }
    if (message.new_chat_members || message.new_chat_participant) {
      return `(Хизмат хабари: янги аъзо қўшилди)`;
    }
    if (message.pinned_message) return `(Хизмат хабари: хабар қотирилди)`;
    if (message.photo) return `(Расм хабари)`;
    if (message.voice) return `(Овозли хабар)`;
    if (message.video) return `(Видео хабар)`;
    if (message.document) return `(Ҳужжат)`;
    if (message.sticker) return `(Стикер)`;
  }

  return null;
}
