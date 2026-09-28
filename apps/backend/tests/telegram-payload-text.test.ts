import { describe, it, expect } from 'vitest';
import {
  EXTRACTED_TEXT_FALLBACK,
  TELEGRAM_MESSAGE_UPDATE_KEYS,
  extractVerbatimDisplayText,
  resolveTelegramMessageObject,
} from '../src/modules/telegram-intake/telegram-payload-text.js';

describe('telegram-payload-text — one owner for payload shape and verbatim resolution', () => {
  describe('TELEGRAM_MESSAGE_UPDATE_KEYS', () => {
    it('declares the six Telegram message-update envelopes in resolution order', () => {
      expect(TELEGRAM_MESSAGE_UPDATE_KEYS).toEqual([
        'message',
        'edited_message',
        'channel_post',
        'edited_channel_post',
        'business_message',
        'edited_business_message',
      ]);
    });
  });

  describe('resolveTelegramMessageObject', () => {
    it('returns the message object carried by the payload', () => {
      expect(resolveTelegramMessageObject({ message: { text: 'A' } })).toEqual({ text: 'A' });
      expect(resolveTelegramMessageObject({ channel_post: { text: 'B' } })).toEqual({ text: 'B' });
    });

    it('prefers message over every later envelope key', () => {
      expect(
        resolveTelegramMessageObject({
          message: { text: 'first' },
          edited_message: { text: 'second' },
          channel_post: { text: 'third' },
        }),
      ).toEqual({ text: 'first' });
    });

    it('returns null for a payload with no recognised envelope', () => {
      expect(resolveTelegramMessageObject({ status: 'EXCLUDED' })).toBeNull();
      expect(resolveTelegramMessageObject(null)).toBeNull();
      expect(resolveTelegramMessageObject('not-an-object')).toBeNull();
    });

    it('ignores an envelope key whose value is not an object', () => {
      expect(
        resolveTelegramMessageObject({ message: 'malformed', edited_message: { text: 'ok' } }),
      ).toEqual({ text: 'ok' });
    });
  });

  describe('extractVerbatimDisplayText — precedence', () => {
    it('returns the accepted evidence text ahead of any payload shape', () => {
      expect(
        extractVerbatimDisplayText('Evidence verbatim text', { message: { text: 'Raw text' } }),
      ).toBe('Evidence verbatim text');
    });

    it('FALSIFICATION: a root-level verbatimText BEATS message.text', () => {
      // This is the exact input L3-P04-01's AC(3) names. The deleted outlier
      // extractVerbatimTextFromRawPayload returned 'A' here; the canonical resolver returns 'B'.
      expect(extractVerbatimDisplayText(null, { message: { text: 'A' }, verbatimText: 'B' })).toBe(
        'B',
      );
    });

    it('returns a root-level text when there is no verbatimText', () => {
      expect(extractVerbatimDisplayText(null, { text: 'Root text' })).toBe('Root text');
    });

    it('prefers a root-level text over a nested message text', () => {
      expect(extractVerbatimDisplayText(null, { text: 'Root', message: { text: 'Nested' } })).toBe(
        'Root',
      );
    });

    it('falls back to the message caption when there is no text', () => {
      expect(extractVerbatimDisplayText(null, { message: { caption: 'Quvur yorildi rasm' } })).toBe(
        'Quvur yorildi rasm',
      );
    });

    it('prefers message.text over message.caption', () => {
      expect(
        extractVerbatimDisplayText(null, { message: { text: 'Text', caption: 'Caption' } }),
      ).toBe('Text');
    });

    it('treats a whitespace-only value as unresolvable', () => {
      expect(extractVerbatimDisplayText('   ', { verbatimText: '  ', message: {} })).toBeNull();
    });
  });

  describe('extractVerbatimDisplayText — every declared envelope shape', () => {
    it.each(TELEGRAM_MESSAGE_UPDATE_KEYS)(
      'resolves the message text from a %s envelope',
      (key) => {
        expect(extractVerbatimDisplayText(null, { [key]: { text: `from ${key}` } })).toBe(
          `from ${key}`,
        );
      },
    );

    it('resolves a channel_post payload that has no message envelope at all', () => {
      expect(
        extractVerbatimDisplayText(null, {
          update_id: 991002,
          channel_post: {
            message_id: 55,
            text: 'Kanal postidagi muammo',
            chat: { id: -1001234567, type: 'channel' },
          },
        }),
      ).toBe('Kanal postidagi muammo');
    });
  });

  describe('extractVerbatimDisplayText — service-message labels', () => {
    it('renders a named participant leaving the group', () => {
      expect(
        extractVerbatimDisplayText(null, {
          message: { left_chat_participant: { first_name: 'Bekzod', last_name: 'Karimov' } },
        }),
      ).toBe('(Хизмат хабари: Bekzod Karimov гуруҳни тарк этди)');
    });

    it('falls back to the username when no name is present', () => {
      expect(
        extractVerbatimDisplayText(null, {
          message: { left_chat_member: { username: 'bekzod_uz' } },
        }),
      ).toBe('(Хизмат хабари: bekzod_uz гуруҳни тарк этди)');
    });

    it('renders an anonymous departure when the participant is unreadable', () => {
      expect(
        extractVerbatimDisplayText(null, { message: { left_chat_participant: { id: 7 } } }),
      ).toBe('(Хизмат хабари: фойдаланувчи гуруҳни тарк этди)');
    });

    it.each([
      [{ new_chat_members: [{ id: 1 }] }, '(Хизмат хабари: янги аъзо қўшилди)'],
      [{ new_chat_participant: { id: 1 } }, '(Хизмат хабари: янги аъзо қўшилди)'],
      [{ pinned_message: { message_id: 9 } }, '(Хизмат хабари: хабар қотирилди)'],
      [{ photo: [{ file_id: 'x' }] }, '(Расм хабари)'],
      [{ voice: { file_id: 'x' } }, '(Овозли хабар)'],
      [{ video: { file_id: 'x' } }, '(Видео хабар)'],
      [{ document: { file_id: 'x' } }, '(Ҳужжат)'],
      [{ sticker: { file_id: 'x' } }, '(Стикер)'],
    ])('renders a media/service label for %j', (message, expected) => {
      expect(extractVerbatimDisplayText(null, { message })).toBe(expected);
    });
  });

  describe('extractVerbatimDisplayText — unresolvable input', () => {
    it('returns null (never the fallback label) when nothing is resolvable', () => {
      expect(extractVerbatimDisplayText(null, {})).toBeNull();
      expect(extractVerbatimDisplayText(null, { status: 'EXCLUDED' })).toBeNull();
      expect(extractVerbatimDisplayText(undefined, null)).toBeNull();
      expect(extractVerbatimDisplayText(null, { message: { message_id: 1 } })).toBeNull();
    });

    it('keeps the fallback label available for display callers to apply', () => {
      expect(EXTRACTED_TEXT_FALLBACK).toBe('(Матн мавжуд эмас)');
    });

    it('distinguishes null from a payload that happens to hold the fallback label', () => {
      expect(extractVerbatimDisplayText(null, { verbatimText: EXTRACTED_TEXT_FALLBACK })).toBe(
        EXTRACTED_TEXT_FALLBACK,
      );
      expect(extractVerbatimDisplayText(null, {})).toBeNull();
    });
  });
});
