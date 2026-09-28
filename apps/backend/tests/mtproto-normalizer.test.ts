import { describe, it, expect } from 'vitest';
import {
  normalizeMtprotoUpdate,
} from '../src/adapters/telegram/mtproto-normalizer.js';
import {
  filterTelegramMessage,
  extractReplyMetadata,
} from '../src/modules/telegram-intake/telegram-content-qualification.js';

describe('MTProto Normalizer (Ticket 15 - Pure DB-Free Unit Tests)', () => {
  describe('Plain text message in a PeerChannel supergroup', () => {
    it('normalizes a standard human text message in a supergroup', () => {
      const update = {
        _: 'UpdateNewChannelMessage',
        message: {
          _: 'message',
          id: 1001,
          peerId: { _: 'peerChannel', channelId: 1987654321 },
          date: 1710000000, // 2024-03-09T16:00:00.000Z -> Tashkent 2024-03-09
          message: 'Mahallamizda suv bosimi past, iltimos yordam bering',
          fromId: { _: 'peerUser', userId: 12345 },
        },
        users: [
          {
            id: 12345,
            firstName: 'Bobur',
            lastName: 'Karimov',
            username: 'bobur_k',
            bot: false,
          },
        ],
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const { envelope } = result;
      expect(envelope.transport).toBe('USERBOT');
      expect(envelope.chatId).toBe('-1001987654321');
      expect(envelope.messageId).toBe('1001');
      expect(envelope.originalTimestamp).toEqual(new Date(1710000000 * 1000));
      expect(envelope.calendarDay).toBe('2024-03-09');

      const msg = envelope.normalizedMessage;
      expect(msg.message_id).toBe(1001);
      expect(msg.chat.id).toBe(-1001987654321);
      expect(msg.chat.type).toBe('supergroup');
      expect(msg.from?.id).toBe(12345);
      expect(msg.from?.first_name).toBe('Bobur');
      expect(msg.from?.last_name).toBe('Karimov');
      expect(msg.from?.username).toBe('bobur_k');
      expect(msg.from?.is_bot).toBe(false);
      expect(msg.text).toBe('Mahallamizda suv bosimi past, iltimos yordam bering');

      // Verifies compatibility with downstream filter
      const filterResult = filterTelegramMessage(msg);
      expect(filterResult.accepted).toBe(true);
      expect(filterResult.text).toBe('Mahallamizda suv bosimi past, iltimos yordam bering');
    });
  });

  describe('Edited message', () => {
    it('normalizes an edited message preserving edit_date', () => {
      const update = {
        _: 'UpdateEditChannelMessage',
        message: {
          _: 'message',
          id: 2002,
          peerId: { _: 'peerChannel', channelId: 1987654321 },
          date: 1710000000,
          editDate: 1710000600,
          message: 'Tuzatilgan: elektr chirogʻi yana oʻchdi',
          fromId: { _: 'peerUser', userId: 12345 },
        },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.message_id).toBe(2002);
      expect(msg.edit_date).toBe(1710000600);
      expect(msg.text).toBe('Tuzatilgan: elektr chirogʻi yana oʻchdi');

      const filterResult = filterTelegramMessage(msg);
      expect(filterResult.accepted).toBe(true);
    });
  });

  describe('Service message (dropped as SERVICE_MESSAGE)', () => {
    it('drops MessageService updates', () => {
      const update = {
        _: 'UpdateNewChannelMessage',
        message: {
          _: 'messageService',
          id: 3001,
          peerId: { _: 'peerChannel', channelId: 1987654321 },
          date: 1710000000,
          action: {
            _: 'messageActionChatAddUser',
            users: [99999],
          },
        },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('DROPPED');
      if (result.status === 'DROPPED') {
        expect(result.reason).toBe('SERVICE_MESSAGE');
      }
    });

    it('drops messages with action object present even if not named messageService', () => {
      const update = {
        _: 'message',
        id: 3002,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        action: {
          _: 'messageActionPinMessage',
        },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('DROPPED');
      if (result.status === 'DROPPED') {
        expect(result.reason).toBe('SERVICE_MESSAGE');
      }
    });
  });

  describe('Media with caption', () => {
    it('normalizes photo with caption without fabricated dimensions or fake ID', () => {
      const update = {
        _: 'message',
        id: 4001,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Koʻchadagi chuqur surati',
        media: {
          _: 'messageMediaPhoto',
          photo: {
            id: 9876543210123n,
            sizes: [
              { _: 'photoSize', type: 's', w: 100, h: 60, size: 2500 },
              { _: 'photoSize', type: 'y', w: 1280, h: 720, size: 85000 },
            ],
          },
        },
        fromId: { _: 'peerUser', userId: 12345 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.caption).toBe('Koʻchadagi chuqur surati');
      expect(Array.isArray(msg.photo)).toBe(true);
      expect(msg.photo?.length).toBe(2);

      const largest = (msg.photo as any[])[1];
      expect(largest.file_id).toBe('9876543210123');
      expect(largest.width).toBe(1280);
      expect(largest.height).toBe(720);
      expect(largest.file_size).toBe(85000);

      const filterResult = filterTelegramMessage(msg);
      expect(filterResult.accepted).toBe(true);
      expect(filterResult.text).toBe('Koʻchadagi chuqur surati');
    });

    it('normalizes document with caption without fake doc_1 id', () => {
      const update = {
        _: 'message',
        id: 4002,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Mahalla hisoboti fayli',
        media: {
          _: 'messageMediaDocument',
          document: {
            id: 5544332211n,
            mimeType: 'application/pdf',
            attributes: [],
          },
        },
        fromId: { _: 'peerUser', userId: 12345 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.caption).toBe('Mahalla hisoboti fayli');
      expect(msg.document).toEqual({
        file_id: '5544332211',
        mime_type: 'application/pdf',
      });

      const filterResult = filterTelegramMessage(msg);
      expect(filterResult.accepted).toBe(true);
      expect(filterResult.text).toBe('Mahalla hisoboti fayli');
    });

    it('normalizes voice note with caption', () => {
      const update = {
        _: 'message',
        id: 4003,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Ovozli shikoyat matni',
        media: {
          _: 'messageMediaDocument',
          document: {
            id: 1122334455n,
            attributes: [
              {
                _: 'DocumentAttributeAudio',
                voice: true,
              },
            ],
          },
        },
        fromId: { _: 'peerUser', userId: 12345 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.voice).toEqual({ file_id: '1122334455' });
      expect(msg.caption).toBe('Ovozli shikoyat matni');

      const filterResult = filterTelegramMessage(msg);
      expect(filterResult.accepted).toBe(true);
    });

    it('normalizes video with caption', () => {
      const update = {
        _: 'message',
        id: 4004,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Video dalil: suv toshqini',
        media: {
          _: 'messageMediaDocument',
          document: {
            id: 9988776655n,
            attributes: [
              {
                _: 'DocumentAttributeVideo',
              },
            ],
          },
        },
        fromId: { _: 'peerUser', userId: 12345 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.video).toEqual({ file_id: '9988776655' });
      expect(msg.caption).toBe('Video dalil: suv toshqini');

      const filterResult = filterTelegramMessage(msg);
      expect(filterResult.accepted).toBe(true);
    });
  });

  describe('PeerChat (legacy groups)', () => {
    it('normalizes message in basic legacy group with negative chatId', () => {
      const update = {
        _: 'message',
        id: 5001,
        peerId: { _: 'peerChat', chatId: 987654 },
        date: 1710000000,
        message: 'Oddiy guruhdagi xabar: gaz oʻchdi',
        fromId: { _: 'peerUser', userId: 54321 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      expect(result.envelope.chatId).toBe('-987654');
      expect(result.envelope.normalizedMessage.chat.id).toBe(-987654);
      expect(result.envelope.normalizedMessage.chat.type).toBe('group');
      expect(result.envelope.normalizedMessage.text).toBe('Oddiy guruhdagi xabar: gaz oʻchdi');

      const filterResult = filterTelegramMessage(result.envelope.normalizedMessage);
      expect(filterResult.accepted).toBe(true);
    });
  });

  describe('Reply mapping (both shapes)', () => {
    it('handles Shape A: replyTo header object with user peer and users array', () => {
      const update = {
        _: 'message',
        id: 6001,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Ha, bizda ham suv bosimi tushib ketgan',
        replyTo: {
          _: 'MessageReplyHeader',
          replyToMsgId: 1001,
          replyToPeerId: { _: 'PeerUser', userId: 887766 },
        },
        fromId: { _: 'peerUser', userId: 12345 },
        users: [
          {
            id: 887766,
            firstName: 'Nodir',
            bot: false,
          },
        ],
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.reply_to_message).toBeDefined();
      expect(msg.reply_to_message?.message_id).toBe(1001);
      expect(msg.reply_to_message?.from?.id).toBe(887766);
      expect(msg.reply_to_message?.from?.first_name).toBe('Nodir');
      expect(msg.reply_to_message?.from?.is_bot).toBe(false);

      const replyMeta = extractReplyMetadata(msg);
      expect(replyMeta).not.toBeNull();
      expect(replyMeta?.replyToMessageId).toBe('1001');
      expect(replyMeta?.replyToUserId).toBe('887766');
      expect(replyMeta?.replyToIsBot).toBe(false);
      expect(replyMeta?.replyToIsForwarded).toBe(false);
    });

    it('handles Shape A with forwarded reply resolving replyToIsForwarded and replyToIsBot', () => {
      const update = {
        _: 'message',
        id: 6002,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Bu xabarga javob berdim',
        replyTo: {
          _: 'MessageReplyHeader',
          replyToMsgId: 1002,
          replyFrom: {
            _: 'MessageFwdHeader',
            fromId: { _: 'PeerUser', userId: 777666 },
            date: 1709999000,
          },
        },
        fromId: { _: 'peerUser', userId: 12345 },
        users: [
          {
            id: 777666,
            firstName: 'BotAdmin',
            is_bot: true,
          },
        ],
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const replyMeta = extractReplyMetadata(result.envelope.normalizedMessage);
      expect(replyMeta?.replyToMessageId).toBe('1002');
      expect(replyMeta?.replyToUserId).toBe('777666');
      expect(replyMeta?.replyToIsBot).toBe(true);
      expect(replyMeta?.replyToIsForwarded).toBe(true);
    });

    it('handles Shape B: top-level replyToMsgId without replyTo header object', () => {
      const update = {
        _: 'message',
        id: 6003,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Top-level reply orqali javob',
        replyToMsgId: 2005,
        replyToUserId: 998877,
        fromId: { _: 'peerUser', userId: 12345 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.reply_to_message).toBeDefined();
      expect(msg.reply_to_message?.message_id).toBe(2005);
      expect(msg.reply_to_message?.from?.id).toBe(998877);

      const replyMeta = extractReplyMetadata(msg);
      expect(replyMeta?.replyToMessageId).toBe('2005');
      expect(replyMeta?.replyToUserId).toBe('998877');
    });

    it('handles Shape B: top-level replyToMsgId without replyToUserId', () => {
      const update = {
        _: 'message',
        id: 6004,
        peerId: { _: 'peerChannel', channelId: 1987654321 },
        date: 1710000000,
        message: 'Anonim javob',
        replyToMsgId: 3005,
        fromId: { _: 'peerUser', userId: 12345 },
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('NORMALIZED');

      if (result.status !== 'NORMALIZED') return;

      const msg = result.envelope.normalizedMessage;
      expect(msg.reply_to_message?.message_id).toBe(3005);

      const replyMeta = extractReplyMetadata(msg);
      expect(replyMeta?.replyToMessageId).toBe('3005');
      expect(replyMeta?.replyToUserId).toBeUndefined();
    });
  });

  describe('Drop cases', () => {
    it('drops unsupported update types (UNSUPPORTED_UPDATE_TYPE)', () => {
      const cases = [
        { _: 'UpdateDeleteMessages', messages: [101, 102] },
        { _: 'UpdateDeleteChannelMessages', channelId: 123, messages: [1] },
        { _: 'UpdateUserStatus', userId: 12345 },
        { _: 'UpdateUserTyping', userId: 12345 },
        { _: 'UpdateChannel', channelId: 12345 },
        { _: 'UpdateUnknownTypeWithoutMessage' },
      ];

      for (const update of cases) {
        const result = normalizeMtprotoUpdate(update);
        expect(result.status).toBe('DROPPED');
        if (result.status === 'DROPPED') {
          expect(result.reason).toBe('UNSUPPORTED_UPDATE_TYPE');
        }
      }
    });

    it('drops empty messages (EMPTY_MESSAGE)', () => {
      const update = {
        _: 'messageEmpty',
        id: 8001,
      };

      const result = normalizeMtprotoUpdate(update);
      expect(result.status).toBe('DROPPED');
      if (result.status === 'DROPPED') {
        expect(result.reason).toBe('EMPTY_MESSAGE');
      }
    });

    it('drops malformed updates (MALFORMED_UPDATE)', () => {
      const malformedCases = [
        null,
        undefined,
        'not-an-object',
        12345,
        {},
        // Missing date
        {
          _: 'message',
          id: 9001,
          peerId: { _: 'peerChannel', channelId: 123 },
        },
        // Non-number date (no Date.now fallback!)
        {
          _: 'message',
          id: 9002,
          peerId: { _: 'peerChannel', channelId: 123 },
          date: '2024-03-09',
        },
        // Zero/negative date
        {
          _: 'message',
          id: 9003,
          peerId: { _: 'peerChannel', channelId: 123 },
          date: 0,
        },
        {
          _: 'message',
          id: 9004,
          peerId: { _: 'peerChannel', channelId: 123 },
          date: -100,
        },
        // Missing id
        {
          _: 'message',
          peerId: { _: 'peerChannel', channelId: 123 },
          date: 1710000000,
        },
        // Missing peerId
        {
          _: 'message',
          id: 9005,
          date: 1710000000,
        },
        // Photo missing id (no fake photo_1!)
        {
          _: 'message',
          id: 9006,
          peerId: { _: 'peerChannel', channelId: 123 },
          date: 1710000000,
          media: {
            _: 'messageMediaPhoto',
            photo: {},
          },
        },
        // Document missing id (no fake doc_1!)
        {
          _: 'message',
          id: 9007,
          peerId: { _: 'peerChannel', channelId: 123 },
          date: 1710000000,
          media: {
            _: 'messageMediaDocument',
            document: {},
          },
        },
      ];

      for (const update of malformedCases) {
        const result = normalizeMtprotoUpdate(update);
        expect(result.status).toBe('DROPPED');
        if (result.status === 'DROPPED') {
          expect(result.reason).toBe('MALFORMED_UPDATE');
        }
      }
    });
  });
});
