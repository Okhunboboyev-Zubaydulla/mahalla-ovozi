import { describe, it, expect } from 'vitest';
import {
  qualifyTelegramContent,
  isTelegramForwarded,
  isTelegramBotMessage,
  isTelegramCommand,
  isTelegramServiceMessage,
  extractReplyMetadata,
  hasSelfContainedCivicSignal,
  type TelegramMessage,
  type TelegramIntakeRecordInput,
} from '../src/modules/telegram-intake/telegram-content-qualification.js';

describe('Story 2.2: Telegram Content Qualification Engine Unit Tests', () => {
  const createMockRecord = (
    rawPayload: unknown,
    overrides?: Partial<TelegramIntakeRecordInput>,
  ): TelegramIntakeRecordInput => ({
    id: 'intake_rec_test_1',
    districtId: 'dist_act_123',
    mahallaName: 'Navbahor',
    calendarDay: '2026-08-21',
    source: 'BOT_API',
    telegramBotId: 'bot_act_123',
    telegramChatId: '-1001234567890',
    telegramMessageId: '9988',
    updateId: '10001',
    telegramUserId: '445566',
    originalTimestamp: new Date('2026-08-21T11:00:00.000Z'),
    rawPayload,
    ...overrides,
  });

  const createBaseMessage = (overrides?: Partial<TelegramMessage>): TelegramMessage => ({
    message_id: 9988,
    date: 1787313600,
    chat: {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Navbahor Mahalla Group',
    },
    from: {
      id: 445566,
      is_bot: false,
      first_name: 'Anvar',
      username: 'anvar_uz',
    },
    ...overrides,
  });

  describe('AC 1 & Matrix #1, #17: Supported Human Text Messages', () => {
    it('admits plain Uzbek text message verbatim preserving Cyrillic, Latin, emojis and whitespace (Matrix #1)', () => {
      const verbatimText = "  Suv 3 kundan beri yo'q! 🚰\nIltimos, yordam bering.  ";
      const msg = createBaseMessage({ text: verbatimText });
      const record = createMockRecord({ update_id: 1001, message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
        expect(result.candidate.verbatimText).toBe(verbatimText);
        expect(result.candidate.districtId).toBe('dist_act_123');
        expect(result.candidate.mahallaName).toBe('Navbahor');
        expect(result.candidate.calendarDay).toBe('2026-08-21');
        expect(result.candidate.telegramChatId).toBe('-1001234567890');
        expect(result.candidate.telegramMessageId).toBe('9988');
        expect(result.candidate.telegramUserId).toBe('445566');
        expect(result.candidate.originalTimestamp).toBe('2026-08-21T11:00:00.000Z');
        expect(result.candidate.replyMetadata).toBeNull();
      }
    });

    it('admits anonymous channel/admin post (sender_chat present, from undefined) (Matrix #17)', () => {
      const msg = createBaseMessage({
        from: undefined,
        sender_chat: {
          id: -1009999999999,
          type: 'channel',
          title: 'Mahalla News Channel',
        },
        text: "Ertaga soat 10:00 da umumiy mahalla hashari o'tkaziladi.",
      });
      const record = createMockRecord({ update_id: 1002, message: msg }, { telegramUserId: undefined });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
        expect(result.candidate.verbatimText).toBe("Ertaga soat 10:00 da umumiy mahalla hashari o'tkaziladi.");
      }
    });
  });

  describe('AC 2 & Matrix #2-#6: Supported Media with Textual Captions', () => {
    it('admits photo with non-empty caption (Matrix #2)', () => {
      const msg = createBaseMessage({
        photo: [{ file_id: 'p1', width: 100, height: 100 }],
        caption: 'Elektr simlari uzildi',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('MEDIA_CAPTION');
        expect(result.candidate.verbatimText).toBe('Elektr simlari uzildi');
      }
    });

    it('admits video with caption (Matrix #3)', () => {
      const msg = createBaseMessage({
        video: { file_id: 'v1', duration: 30 },
        caption: 'Gaz bosimi juda past',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('MEDIA_CAPTION');
        expect(result.candidate.verbatimText).toBe('Gaz bosimi juda past');
      }
    });

    it('admits document with caption (Matrix #4)', () => {
      const msg = createBaseMessage({
        document: { file_id: 'd1', file_name: 'statement.pdf' },
        caption: "Chiqindi to'planib qoldi",
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('MEDIA_CAPTION');
        expect(result.candidate.verbatimText).toBe("Chiqindi to'planib qoldi");
      }
    });

    it('admits animation, audio, and voice with caption (Matrix #5)', () => {
      const audioMsg = createBaseMessage({
        audio: { file_id: 'a1', duration: 45 },
        caption: "Suv ta'minoti bo'yicha murojaat",
      });
      const voiceMsg = createBaseMessage({
        voice: { file_id: 'vo1', duration: 15 },
        caption: "Yo'l ta'miri haqida",
      });
      const animMsg = createBaseMessage({
        animation: { file_id: 'an1', duration: 5 },
        caption: 'Mahallamiz obodonlashmoqda',
      });

      expect(qualifyTelegramContent(createMockRecord({ message: audioMsg })).status).toBe('SUPPORTED');
      expect(qualifyTelegramContent(createMockRecord({ message: voiceMsg })).status).toBe('SUPPORTED');
      expect(qualifyTelegramContent(createMockRecord({ message: animMsg })).status).toBe('SUPPORTED');
    });

    it('admits paid_media with caption (Matrix #6)', () => {
      const msg = createBaseMessage({
        paid_media: { star_count: 10, paid_media: [] },
        caption: "Ta'mirlash ishlari",
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('MEDIA_CAPTION');
        expect(result.candidate.verbatimText).toBe("Ta'mirlash ishlari");
      }
    });
  });

  describe('AC 3 & Matrix #7-#10, #22: Captionless & Unsupported Media & Empty Content Exclusions', () => {
    it('excludes photo without caption (Matrix #7)', () => {
      const msg = createBaseMessage({
        photo: [{ file_id: 'p1' }],
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('CAPTIONLESS_MEDIA');
        expect(result.districtId).toBe('dist_act_123');
        expect(result.telegramMessageId).toBe('9988');
      }
    });

    it('excludes video, doc, audio, voice without caption or with empty caption (Matrix #8)', () => {
      const voiceMsg = createBaseMessage({ voice: { file_id: 'vo1' } });
      const docMsg = createBaseMessage({ document: { file_id: 'd1' }, caption: '   ' });

      expect(qualifyTelegramContent(createMockRecord({ message: voiceMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'CAPTIONLESS_MEDIA' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: docMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'CAPTIONLESS_MEDIA' }),
      );
    });

    it('excludes sticker and video_note as unsupported media (Matrix #9)', () => {
      const stickerMsg = createBaseMessage({ sticker: { file_id: 'stk1', emoji: '👍' } });
      const videoNoteMsg = createBaseMessage({ video_note: { file_id: 'vn1' } });

      expect(qualifyTelegramContent(createMockRecord({ message: stickerMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: videoNoteMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
      );
    });

    it('excludes poll, dice, game, story, contact, location (Matrix #10)', () => {
      const pollMsg = createBaseMessage({ poll: { id: 'pol1', question: 'Qanday?' } });
      const diceMsg = createBaseMessage({ dice: { emoji: '🎲', value: 6 } });
      const locMsg = createBaseMessage({ location: { latitude: 41.31, longitude: 69.24 } });
      const contactMsg = createBaseMessage({ contact: { phone_number: '+998901234567', first_name: 'Ali' } });

      expect(qualifyTelegramContent(createMockRecord({ message: pollMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: diceMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: locMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: contactMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'UNSUPPORTED_MEDIA_TYPE' }),
      );
    });

    it('excludes empty or whitespace-only text messages (Matrix #22)', () => {
      const emptyMsg = createBaseMessage({ text: '    \n\t   ' });
      const record = createMockRecord({ message: emptyMsg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('EMPTY_CONTENT');
      }
    });
  });

  describe('AC 4 & Matrix #11-#14: Telegram Forwarded Messages Exclusions', () => {
    it('excludes modern Bot API 7.0+ forward_origin user (Matrix #11)', () => {
      const msg = createBaseMessage({
        forward_origin: {
          type: 'user',
          date: 1787300000,
          sender_user: {
            id: 999111,
            is_bot: false,
            first_name: 'Original Author',
          },
        },
        text: 'Muhim eʼlon: gaz ochiriladi!',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('FORWARDED_MESSAGE');
      }
    });

    it('excludes modern Bot API 7.0+ forward_origin channel, chat, hidden_user (Matrix #12)', () => {
      const channelMsg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -10088888, type: 'channel', title: 'Official Channel' },
          message_id: 42,
        },
        text: 'Hokimiyat qarori',
      });
      const hiddenMsg = createBaseMessage({
        forward_origin: {
          type: 'hidden_user',
          date: 1787300000,
          sender_user_name: 'Anonim',
        },
        text: 'Anonim xabar',
      });

      expect(qualifyTelegramContent(createMockRecord({ message: channelMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'FORWARDED_MESSAGE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: hiddenMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'FORWARDED_MESSAGE' }),
      );
    });

    it('excludes modern Bot API 7.0+ is_automatic_forward: true (Matrix #13)', () => {
      const msg = createBaseMessage({
        is_automatic_forward: true,
        text: 'Avtomatik repost xabar',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('FORWARDED_MESSAGE');
      }
    });

    it('excludes legacy forward fields (forward_date, forward_from, etc.) (Matrix #14)', () => {
      const msg = createBaseMessage({
        forward_date: 1787200000,
        forward_from: { id: 777, is_bot: false, first_name: 'Eski Author' },
        text: 'Eski forward qilingan xabar',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('FORWARDED_MESSAGE');
      }
    });
  });

  describe('AC 3 & Matrix #15-#16, #18-#21: Bots, Commands, & Service Messages', () => {
    it('excludes bot-authored messages from.is_bot === true (Matrix #15)', () => {
      const msg = createBaseMessage({
        from: { id: 888999, is_bot: true, first_name: 'Mahalla Helper Bot' },
        text: 'Avtomatik eslatma',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('BOT_MESSAGE');
      }
    });

    it('excludes inline bot messages via_bot (Matrix #16)', () => {
      const msg = createBaseMessage({
        via_bot: { id: 456, is_bot: true, first_name: 'VoteBot' },
        text: 'Ovoz bering',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('BOT_MESSAGE');
      }
    });

    it('excludes bot commands at offset 0 via entities or slash prefix (Matrix #18, #19)', () => {
      const slashTextMsg = createBaseMessage({
        text: '/start bot_param',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      });
      const slashCaptionMsg = createBaseMessage({
        photo: [{ file_id: 'p1' }],
        caption: '/report muammo',
        caption_entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      });
      const rawSlashMsg = createBaseMessage({ text: '/help' });

      expect(qualifyTelegramContent(createMockRecord({ message: slashTextMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'BOT_COMMAND' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: slashCaptionMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'BOT_COMMAND' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: rawSlashMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'BOT_COMMAND' }),
      );
    });

    it('admits slash mentions embedded at offset > 0 as normal human text (Matrix #20)', () => {
      const msg = createBaseMessage({
        text: 'Batafsil maʼlumot uchun /start buyrugʻini bosing',
        entities: [{ type: 'bot_command', offset: 22, length: 6 }],
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
        expect(result.candidate.verbatimText).toBe('Batafsil maʼlumot uchun /start buyrugʻini bosing');
      }
    });

    it('excludes service messages (new_chat_members, pinned_message, forum_topic_*, etc.) (Matrix #21)', () => {
      const joinMsg = createBaseMessage({
        new_chat_members: [{ id: 112233, is_bot: false, first_name: 'Yangi Aʼzo' }],
      });
      const pinMsg = createBaseMessage({
        pinned_message: { message_id: 111 },
      });
      const forumMsg = createBaseMessage({
        forum_topic_created: { name: 'Kommunal muammolar', icon_color: 7322096 },
      });

      expect(qualifyTelegramContent(createMockRecord({ message: joinMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'SERVICE_MESSAGE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: pinMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'SERVICE_MESSAGE' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: forumMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'SERVICE_MESSAGE' }),
      );
    });
  });

  describe('AC 5 & Matrix #23: Replies to Forwarded Parents', () => {
    it('admits non-forwarded reply to a forwarded parent with replyToIsForwarded: true (Matrix #23)', () => {
      const forwardedParentMessage: TelegramMessage = {
        message_id: 5544,
        date: 1787310000,
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 332211, is_bot: false, first_name: 'Boshqa Fuqaro' },
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -1007777777, type: 'channel', title: 'Tuman Hokimligi' },
          message_id: 12,
        },
        text: 'Eski xabar',
      };

      const replyMsg = createBaseMessage({
        message_id: 9988,
        text: "Bizning ko'chada ham suv 2 kundan beri yo'q",
        reply_to_message: forwardedParentMessage,
      });
      const record = createMockRecord({ message: replyMsg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
        expect(result.candidate.verbatimText).toBe("Bizning ko'chada ham suv 2 kundan beri yo'q");
        expect(result.candidate.replyMetadata).toEqual({
          replyToMessageId: '5544',
          replyToUserId: '332211',
          replyToIsForwarded: true,
          replyToIsBot: false,
        });
      }
    });
  });

  describe('AC 10 & Malformed Fallback Handling', () => {
    it('excludes malformed or corrupted raw payload with MALFORMED_METADATA', () => {
      const corruptRecord1 = createMockRecord(null);
      const corruptRecord2 = createMockRecord({ update_id: 100 }); // missing message
      const corruptRecord3 = createMockRecord({ message: { text: 'Salom' } }); // missing message_id/chat

      expect(qualifyTelegramContent(corruptRecord1)).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'MALFORMED_METADATA' }),
      );
      expect(qualifyTelegramContent(corruptRecord2)).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'MALFORMED_METADATA' }),
      );
      expect(qualifyTelegramContent(corruptRecord3)).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'MALFORMED_METADATA' }),
      );
    });
  });

  describe('Pure Guard Functions Unit Verification', () => {
    it('evaluates isTelegramForwarded correctly', () => {
      expect(isTelegramForwarded(createBaseMessage())).toBe(false);
      expect(
        isTelegramForwarded(
          createBaseMessage({
            forward_origin: {
              type: 'user',
              date: 100,
              sender_user: { id: 1, is_bot: false, first_name: 'A' },
            },
          }),
        ),
      ).toBe(true);
      expect(isTelegramForwarded(createBaseMessage({ is_automatic_forward: true }))).toBe(true);
      expect(isTelegramForwarded(createBaseMessage({ forward_date: 12345 }))).toBe(true);
    });

    it('evaluates isTelegramBotMessage correctly', () => {
      expect(isTelegramBotMessage(createBaseMessage())).toBe(false);
      expect(
        isTelegramBotMessage(
          createBaseMessage({
            from: { id: 2, is_bot: true, first_name: 'Bot' },
          }),
        ),
      ).toBe(true);
      expect(
        isTelegramBotMessage(
          createBaseMessage({
            via_bot: { id: 3, is_bot: true, first_name: 'InlineBot' },
          }),
        ),
      ).toBe(true);
    });

    it('evaluates isTelegramCommand correctly', () => {
      expect(isTelegramCommand(createBaseMessage({ text: 'Salom' }))).toBe(false);
      expect(isTelegramCommand(createBaseMessage({ text: '/start' }))).toBe(true);
      expect(
        isTelegramCommand(
          createBaseMessage({
            text: 'Hello /start',
            entities: [{ type: 'bot_command', offset: 6, length: 6 }],
          }),
        ),
      ).toBe(false);
    });

    it('evaluates isTelegramServiceMessage correctly', () => {
      expect(isTelegramServiceMessage(createBaseMessage({ text: 'Salom' }))).toBe(false);
      expect(isTelegramServiceMessage(createBaseMessage({ pinned_message: {} }))).toBe(true);
    });

    it('evaluates extractReplyMetadata correctly', () => {
      expect(extractReplyMetadata(createBaseMessage())).toBeNull();
      const parent = createBaseMessage({
        message_id: 111,
        from: { id: 222, is_bot: true, first_name: 'B' },
      });
      const reply = createBaseMessage({ reply_to_message: parent });
      expect(extractReplyMetadata(reply)).toEqual({
        replyToMessageId: '111',
        replyToUserId: '222',
        replyToIsForwarded: false,
        replyToIsBot: true,
      });
    });
  });

  describe('Patched Defensive Edge Cases & Robustness', () => {
    it('returns MALFORMED_METADATA instead of throwing RangeError on invalid originalTimestamp', () => {
      const invalidDateRecord = createMockRecord(
        { update_id: 101, message: createBaseMessage({ text: 'Yaroqsiz sana testi' }) },
        { originalTimestamp: 'not-a-valid-date-string' },
      );
      const nanDateRecord = createMockRecord(
        { update_id: 102, message: createBaseMessage({ text: 'NaN date testi' }) },
        { originalTimestamp: new Date(NaN) },
      );

      expect(qualifyTelegramContent(invalidDateRecord)).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'MALFORMED_METADATA' }),
      );
      expect(qualifyTelegramContent(nanDateRecord)).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'MALFORMED_METADATA' }),
      );
    });

    it('does not falsely classify message as forwarded when forward fields are explicitly null', () => {
      const msg = createBaseMessage({
        forward_date: undefined,
        forward_from: undefined,
        text: 'Oddiy xabar forward emas',
        ...({ forward_from_chat: null, forward_signature: null } as any),
      });
      const record = createMockRecord({ update_id: 103, message: msg });

      const result = qualifyTelegramContent(record);
      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
      }
    });

    it('does not trigger CAPTIONLESS_MEDIA when photo is an empty array', () => {
      const msg = createBaseMessage({
        photo: [],
        text: "Bo'sh photo massivli xabar",
      });
      const record = createMockRecord({ update_id: 104, message: msg });

      const result = qualifyTelegramContent(record);
      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
        expect(result.candidate.verbatimText).toBe("Bo'sh photo massivli xabar");
      }
    });

    it('excludes message containing only zero-width formatting characters as EMPTY_CONTENT', () => {
      const msg = createBaseMessage({
        text: '\u200B\u200C\u200D\uFEFF\u2060   \n\t',
      });
      const record = createMockRecord({ update_id: 105, message: msg });

      const result = qualifyTelegramContent(record);
      expect(result).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'EMPTY_CONTENT' }),
      );
    });

    it('extracts and admits message from top-level channel_post or edited_message update objects', () => {
      const msg = createBaseMessage({ text: 'Kanal posti xabari' });
      const channelPostRecord = createMockRecord({ update_id: 106, channel_post: msg });
      const editedMsgRecord = createMockRecord({ update_id: 107, edited_message: msg });

      expect(qualifyTelegramContent(channelPostRecord)).toEqual(
        expect.objectContaining({ status: 'SUPPORTED' }),
      );
      expect(qualifyTelegramContent(editedMsgRecord)).toEqual(
        expect.objectContaining({ status: 'SUPPORTED' }),
      );
    });

    it('correctly preserves numeric 0 as string "0" for user IDs and reply IDs', () => {
      const parent = createBaseMessage({
        message_id: 0,
        from: { id: 0, is_bot: false, first_name: 'Zero' },
      });
      const reply = createBaseMessage({
        from: { id: 0, is_bot: false, first_name: 'Zero' },
        reply_to_message: parent,
      });

      const replyMeta = extractReplyMetadata(reply);
      expect(replyMeta?.replyToMessageId).toBe('0');
      expect(replyMeta?.replyToUserId).toBe('0');

      const record = createMockRecord({ update_id: 108, message: reply }, { telegramUserId: undefined });
      const result = qualifyTelegramContent(record);
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.telegramUserId).toBe('0');
      }
    });
  });

  describe('hasSelfContainedCivicSignal', () => {
    it('returns true for messages with explicit civic subject and failure predicate in Uzbek and Russian', () => {
      expect(hasSelfContainedCivicSignal("Bizda ham svet o'chdi")).toBe(true);
      expect(hasSelfContainedCivicSignal('бизда хам чироқ ўчди')).toBe(true);
      expect(hasSelfContainedCivicSignal("Suv to'xtab qoldi, bosim yo'q")).toBe(true);
      expect(hasSelfContainedCivicSignal('Газ босими жуда паст')).toBe(true);
      expect(hasSelfContainedCivicSignal('Трансформатор портлади ёки куйди')).toBe(true);
      expect(hasSelfContainedCivicSignal('Сув качон буладими?')).toBe(true);
      expect(hasSelfContainedCivicSignal('Чиқинди тўлиб кетган, олиб кетишмади')).toBe(true);
      expect(hasSelfContainedCivicSignal('труба ёрилди сув оқяпти')).toBe(true);
      expect(hasSelfContainedCivicSignal('канализация тўлиб тошди')).toBe(true);
    });

    it('returns true for compound civic problem terms', () => {
      expect(hasSelfContainedCivicSignal('Svetsizlikdan charchadik')).toBe(true);
      expect(hasSelfContainedCivicSignal('Сувсизлик қийнаяпти')).toBe(true);
      expect(hasSelfContainedCivicSignal('Газсизликдан музлаб қолдик')).toBe(true);
      expect(hasSelfContainedCivicSignal('кўчада мусирлар тўлиб кетди')).toBe(true);
      expect(hasSelfContainedCivicSignal('musirlar toplanib qolgan')).toBe(true);
    });

    it('returns true for dialectal waste terms, accumulation verbs, and elapsed failure predicates', () => {
      // Production Navro'z message 66410 excerpt
      expect(
        hasSelfContainedCivicSignal(
          'кучада Росса йотибди мусирлар Хамма кушниники 3 хафта ужи кемаганига мусир машинани',
        ),
      ).toBe(true);
      expect(hasSelfContainedCivicSignal('musr kemaganiga 3 hafta boldi')).toBe(true);
      expect(hasSelfContainedCivicSignal('musr mashinasi kemibdi')).toBe(true);
      expect(hasSelfContainedCivicSignal('kuchada musr yotibdi')).toBe(true);
      expect(hasSelfContainedCivicSignal('мусир кемади')).toBe(true);
    });

    it('returns false for vague fragments, chat chatter, or dependent remarks', () => {
      // The exact phrase from contaminated message 66312:
      expect(hasSelfContainedCivicSignal('каерда экан бизга керек')).toBe(false);
      expect(hasSelfContainedCivicSignal('bizga ham kerak')).toBe(false);
      expect(hasSelfContainedCivicSignal('qayerda ekan')).toBe(false);
      expect(hasSelfContainedCivicSignal('ha tushundim rahmat')).toBe(false);
      expect(hasSelfContainedCivicSignal('kim biladi?')).toBe(false);
      expect(hasSelfContainedCivicSignal('kimga murojaat qilsak boladi')).toBe(false);
      expect(hasSelfContainedCivicSignal('')).toBe(false);
    });

    it('returns false for bare utility mentions without failure/disruption predicates', () => {
      expect(hasSelfContainedCivicSignal('svet')).toBe(false);
      expect(hasSelfContainedCivicSignal('suv')).toBe(false);
      expect(hasSelfContainedCivicSignal('gaz')).toBe(false);
      expect(hasSelfContainedCivicSignal('chiqindi')).toBe(false);
    });
  });
});
