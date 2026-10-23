import { describe, it, expect } from 'vitest';
import {
  qualifyTelegramContent,
  isTelegramForwarded,
  isTelegramBotMessage,
  isTelegramCommand,
  isTelegramServiceMessage,
  extractReplyMetadata,
  extractForwardOriginMetadata,
  hasSelfContainedCivicSignal,
  matchesCivicLaneKeyword,
  normalizeUzbekScript,
  hasContextualFollowUpSignal,
  CIVIC_LANE_KEYWORD_REGEX,
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

  describe('Controlled Forwarded Message Admission & Exclusions', () => {
    it('admits manual channel forward with meaningful text and populates forwardMetadata', () => {
      const msg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -10088888, type: 'channel', title: 'Hududgaz Poytaxt' },
          message_id: 42,
        },
        text: "E'LON: Ertaga soat 09:00 dan 18:00 gacha gaz ta'minoti vaqtincha to'xtatiladi.",
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('TEXT');
        expect(result.candidate.verbatimText).toBe(
          "E'LON: Ertaga soat 09:00 dan 18:00 gacha gaz ta'minoti vaqtincha to'xtatiladi.",
        );
        expect(result.candidate.forwardMetadata).toEqual({
          originChatId: '-10088888',
          originMessageId: '42',
          originTitle: 'Hududgaz Poytaxt',
          originType: 'channel',
        });
      }
    });

    it('admits manual forward from user, chat, and hidden_user with text', () => {
      const userMsg = createBaseMessage({
        forward_origin: {
          type: 'user',
          date: 1787300000,
          sender_user: {
            id: 999111,
            is_bot: false,
            first_name: 'Original',
            last_name: 'Author',
          },
        },
        text: 'Muhim eʼlon: gaz ochiriladi!',
      });
      const chatMsg = createBaseMessage({
        forward_origin: {
          type: 'chat',
          date: 1787300000,
          sender_chat: { id: -100999, type: 'supergroup', title: 'Neighbor Chat' },
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

      const userRes = qualifyTelegramContent(createMockRecord({ message: userMsg }));
      expect(userRes.status).toBe('SUPPORTED');
      if (userRes.status === 'SUPPORTED') {
        expect(userRes.candidate.forwardMetadata).toEqual({
          originChatId: null,
          originMessageId: null,
          originTitle: 'Original Author',
          originType: 'user',
        });
      }

      const chatRes = qualifyTelegramContent(createMockRecord({ message: chatMsg }));
      expect(chatRes.status).toBe('SUPPORTED');
      if (chatRes.status === 'SUPPORTED') {
        expect(chatRes.candidate.forwardMetadata).toEqual({
          originChatId: '-100999',
          originMessageId: null,
          originTitle: 'Neighbor Chat',
          originType: 'chat',
        });
      }

      const hiddenRes = qualifyTelegramContent(createMockRecord({ message: hiddenMsg }));
      expect(hiddenRes.status).toBe('SUPPORTED');
      if (hiddenRes.status === 'SUPPORTED') {
        expect(hiddenRes.candidate.forwardMetadata).toEqual({
          originChatId: null,
          originMessageId: null,
          originTitle: 'Anonim',
          originType: 'hidden_user',
        });
      }
    });

    it('admits legacy manual forward fields with text', () => {
      const legacyChatMsg = createBaseMessage({
        forward_date: 1787200000,
        forward_from_chat: { id: -100777, type: 'channel', title: 'Toshkent Suv' },
        forward_from_message_id: 123,
        text: 'Suv jadvali yangilandi',
      });
      const legacyUserMsg = createBaseMessage({
        forward_date: 1787200000,
        forward_from: { id: 777, is_bot: false, first_name: 'Eski', last_name: 'Author' },
        text: 'Eski forward qilingan xabar',
      });

      const legacyChatRes = qualifyTelegramContent(createMockRecord({ message: legacyChatMsg }));
      expect(legacyChatRes.status).toBe('SUPPORTED');
      if (legacyChatRes.status === 'SUPPORTED') {
        expect(legacyChatRes.candidate.forwardMetadata).toEqual({
          originChatId: '-100777',
          originMessageId: '123',
          originTitle: 'Toshkent Suv',
          originType: 'channel',
        });
      }

      const legacyUserRes = qualifyTelegramContent(createMockRecord({ message: legacyUserMsg }));
      expect(legacyUserRes.status).toBe('SUPPORTED');
      if (legacyUserRes.status === 'SUPPORTED') {
        expect(legacyUserRes.candidate.forwardMetadata).toEqual({
          originChatId: null,
          originMessageId: null,
          originTitle: 'Eski Author',
          originType: 'user',
        });
      }
    });

    it('admits captioned forwarded media with forwardMetadata', () => {
      const captionedPhotoMsg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -10088888, type: 'channel', title: 'Hokimiyat Media' },
          message_id: 99,
        },
        photo: [{ file_id: 'p_fwd_1', width: 200, height: 200 }],
        caption: 'Asfalt yotqizish ishlari boshlandi',
      });
      const result = qualifyTelegramContent(createMockRecord({ message: captionedPhotoMsg }));

      expect(result.status).toBe('SUPPORTED');
      if (result.status === 'SUPPORTED') {
        expect(result.candidate.contentType).toBe('MEDIA_CAPTION');
        expect(result.candidate.verbatimText).toBe('Asfalt yotqizish ishlari boshlandi');
        expect(result.candidate.forwardMetadata).toEqual({
          originChatId: '-10088888',
          originMessageId: '99',
          originTitle: 'Hokimiyat Media',
          originType: 'channel',
        });
      }
    });

    it('excludes captionless forwarded photo or video as CAPTIONLESS_MEDIA', () => {
      const captionlessPhotoMsg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -10088888, type: 'channel', title: 'Channel' },
          message_id: 50,
        },
        photo: [{ file_id: 'p_captionless' }],
      });
      const captionlessVideoMsg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -10088888, type: 'channel', title: 'Channel' },
          message_id: 51,
        },
        video: { file_id: 'v_captionless', duration: 10 },
      });

      expect(qualifyTelegramContent(createMockRecord({ message: captionlessPhotoMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'CAPTIONLESS_MEDIA' }),
      );
      expect(qualifyTelegramContent(createMockRecord({ message: captionlessVideoMsg }))).toEqual(
        expect.objectContaining({ status: 'EXCLUDED', reason: 'CAPTIONLESS_MEDIA' }),
      );
    });

    it('excludes automatic channel forward is_automatic_forward: true as FORWARDED_MESSAGE', () => {
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

    it('excludes forwarded message with empty or whitespace-only text as EMPTY_CONTENT', () => {
      const msg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -10088888, type: 'channel', title: 'Channel' },
          message_id: 52,
        },
        text: '   \n\t  ',
      });
      const record = createMockRecord({ message: msg });

      const result = qualifyTelegramContent(record);

      expect(result.status).toBe('EXCLUDED');
      if (result.status === 'EXCLUDED') {
        expect(result.reason).toBe('EMPTY_CONTENT');
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

    it('evaluates extractForwardOriginMetadata correctly across modern and legacy shapes', () => {
      expect(extractForwardOriginMetadata(createBaseMessage())).toBeNull();

      // Modern channel origin
      const channelMsg = createBaseMessage({
        forward_origin: {
          type: 'channel',
          date: 1787300000,
          chat: { id: -100111222, type: 'channel', title: 'Gas Channel' },
          message_id: 300,
        },
      });
      expect(extractForwardOriginMetadata(channelMsg)).toEqual({
        originChatId: '-100111222',
        originMessageId: '300',
        originTitle: 'Gas Channel',
        originType: 'channel',
      });

      // Modern chat origin
      const chatMsg = createBaseMessage({
        forward_origin: {
          type: 'chat',
          date: 1787300000,
          sender_chat: { id: -100333444, type: 'supergroup', title: 'Public Group' },
        },
      });
      expect(extractForwardOriginMetadata(chatMsg)).toEqual({
        originChatId: '-100333444',
        originMessageId: null,
        originTitle: 'Public Group',
        originType: 'chat',
      });

      // Modern user origin
      const userMsg = createBaseMessage({
        forward_origin: {
          type: 'user',
          date: 1787300000,
          sender_user: { id: 555, is_bot: false, first_name: 'Jasur', last_name: 'Karimov' },
        },
      });
      expect(extractForwardOriginMetadata(userMsg)).toEqual({
        originChatId: null,
        originMessageId: null,
        originTitle: 'Jasur Karimov',
        originType: 'user',
      });

      // Modern hidden_user origin
      const hiddenMsg = createBaseMessage({
        forward_origin: {
          type: 'hidden_user',
          date: 1787300000,
          sender_user_name: 'Secret Sender',
        },
      });
      expect(extractForwardOriginMetadata(hiddenMsg)).toEqual({
        originChatId: null,
        originMessageId: null,
        originTitle: 'Secret Sender',
        originType: 'hidden_user',
      });

      // Legacy forward_from_chat
      const legacyChatMsg = createBaseMessage({
        forward_from_chat: { id: -100555666, type: 'channel', title: 'Legacy Channel' },
        forward_from_message_id: 400,
      });
      expect(extractForwardOriginMetadata(legacyChatMsg)).toEqual({
        originChatId: '-100555666',
        originMessageId: '400',
        originTitle: 'Legacy Channel',
        originType: 'channel',
      });

      // Legacy forward_from
      const legacyUserMsg = createBaseMessage({
        forward_from: { id: 777, is_bot: false, first_name: 'Anvar' },
        forward_from_message_id: 401,
      });
      expect(extractForwardOriginMetadata(legacyUserMsg)).toEqual({
        originChatId: null,
        originMessageId: '401',
        originTitle: 'Anvar',
        originType: 'user',
      });

      // Legacy forward_sender_name
      const legacySenderMsg = createBaseMessage({
        forward_sender_name: 'Legacy Anonymous',
      });
      expect(extractForwardOriginMetadata(legacySenderMsg)).toEqual({
        originChatId: null,
        originMessageId: null,
        originTitle: 'Legacy Anonymous',
        originType: 'hidden_user',
      });

      // Legacy with only forward_date / message_id
      const legacyDateMsg = createBaseMessage({
        forward_date: 1787200000,
        forward_from_message_id: 402,
      });
      expect(extractForwardOriginMetadata(legacyDateMsg)).toEqual({
        originChatId: null,
        originMessageId: '402',
        originTitle: null,
        originType: null,
      });

      // Invalid / non-object message
      expect(extractForwardOriginMetadata(null as unknown as TelegramMessage)).toBeNull();
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

  describe('matchesCivicLaneKeyword', () => {
    it('exports CIVIC_LANE_KEYWORD_REGEX with Unicode and case-insensitive flags', () => {
      expect(CIVIC_LANE_KEYWORD_REGEX).toBeInstanceOf(RegExp);
      expect(CIVIC_LANE_KEYWORD_REGEX.unicode).toBe(true);
      expect(CIVIC_LANE_KEYWORD_REGEX.ignoreCase).toBe(true);
    });

    describe('Positive matches across all 5 canonical lanes in Latin, Cyrillic, and Russian', () => {
      it('matches Gaz lane keywords: gaz, газ', () => {
        expect(matchesCivicLaneKeyword('gaz')).toBe(true);
        expect(matchesCivicLaneKeyword('Mahallada gaz bosimi juda past')).toBe(true);
        expect(matchesCivicLaneKeyword('газ')).toBe(true);
        expect(matchesCivicLaneKeyword('Бизда газ ўчди')).toBe(true);
        expect(matchesCivicLaneKeyword('газ йўқ')).toBe(true);
        expect(matchesCivicLaneKeyword('ГАЗ ТАЪМИНОТИ')).toBe(true);
      });

      it('matches Elektr lane keywords: svet, свет, svyet, свьет, chiroq, чироқ, чирок', () => {
        expect(matchesCivicLaneKeyword('svet')).toBe(true);
        expect(matchesCivicLaneKeyword("Bizda svet o'chdi")).toBe(true);
        expect(matchesCivicLaneKeyword('bugun svet bormi?')).toBe(true);
        expect(matchesCivicLaneKeyword('свет')).toBe(true);
        expect(matchesCivicLaneKeyword('свет отключили')).toBe(true);
        expect(matchesCivicLaneKeyword('свет йўқ')).toBe(true);
        expect(matchesCivicLaneKeyword('svyet')).toBe(true);
        expect(matchesCivicLaneKeyword('svyet qachon keladi?')).toBe(true);
        expect(matchesCivicLaneKeyword('свьет')).toBe(true);
        expect(matchesCivicLaneKeyword('свьет йук')).toBe(true);
        expect(matchesCivicLaneKeyword('chiroq')).toBe(true);
        expect(matchesCivicLaneKeyword("chiroq o'chib qoldi")).toBe(true);
        expect(matchesCivicLaneKeyword('чироқ')).toBe(true);
        expect(matchesCivicLaneKeyword('чироқ ёнмаяпти')).toBe(true);
        expect(matchesCivicLaneKeyword('чирок')).toBe(true);
        expect(matchesCivicLaneKeyword('чирок учди')).toBe(true);
      });

      it('matches Suv lane keywords: suv, сув, voda, вода', () => {
        expect(matchesCivicLaneKeyword('suv')).toBe(true);
        expect(matchesCivicLaneKeyword("suv to'xtab qoldi")).toBe(true);
        expect(matchesCivicLaneKeyword("sovuq suv yo'q")).toBe(true);
        expect(matchesCivicLaneKeyword('сув')).toBe(true);
        expect(matchesCivicLaneKeyword('сув босими паст')).toBe(true);
        expect(matchesCivicLaneKeyword('совуқ сув йўқ')).toBe(true);
        expect(matchesCivicLaneKeyword('voda')).toBe(true);
        expect(matchesCivicLaneKeyword('goryachaya voda propala')).toBe(true);
        expect(matchesCivicLaneKeyword('вода')).toBe(true);
        expect(matchesCivicLaneKeyword('холодная вода отключена')).toBe(true);
      });

      it('matches Chiqindi lane keywords: musor, мусор, musr, musir, chiqindi, чиқинди, axlat, ахлат, svalka, свалка', () => {
        expect(matchesCivicLaneKeyword('musor')).toBe(true);
        expect(matchesCivicLaneKeyword("musor to'planib ketdi")).toBe(true);
        expect(matchesCivicLaneKeyword('мусор')).toBe(true);
        expect(matchesCivicLaneKeyword('мусор не вывозят')).toBe(true);
        expect(matchesCivicLaneKeyword('musr')).toBe(true);
        expect(matchesCivicLaneKeyword('musr qachon olib ketiladi?')).toBe(true);
        expect(matchesCivicLaneKeyword('musir')).toBe(true);
        expect(matchesCivicLaneKeyword('musir mashinasi kelmadi')).toBe(true);
        expect(matchesCivicLaneKeyword('мусир')).toBe(true);
        expect(matchesCivicLaneKeyword('мусир машинаси келмади')).toBe(true);
        expect(matchesCivicLaneKeyword('chiqindi')).toBe(true);
        expect(matchesCivicLaneKeyword("chiqindi qutilari to'lib ketdi")).toBe(true);
        expect(matchesCivicLaneKeyword('чиқинди')).toBe(true);
        expect(matchesCivicLaneKeyword('кўчада чиқинди тўлиб кетди')).toBe(true);
        expect(matchesCivicLaneKeyword('axlat')).toBe(true);
        expect(matchesCivicLaneKeyword("ko'chada axlat uyulib yotibdi")).toBe(true);
        expect(matchesCivicLaneKeyword('ахлат')).toBe(true);
        expect(matchesCivicLaneKeyword('ахлат олиб кетилмади')).toBe(true);
        expect(matchesCivicLaneKeyword('svalka')).toBe(true);
        expect(matchesCivicLaneKeyword("bu yer svalka bo'lib qoldi")).toBe(true);
        expect(matchesCivicLaneKeyword('свалка')).toBe(true);
        expect(matchesCivicLaneKeyword('свалка прямо возле дома')).toBe(true);
      });

      it('matches Hokimiyat lane keywords: hokim, ҳоким, tepadagilar, тепадагилар, yuqoridagilar, юқоридагилар', () => {
        expect(matchesCivicLaneKeyword('hokim')).toBe(true);
        expect(matchesCivicLaneKeyword('hokim qabuliga yozildik')).toBe(true);
        expect(matchesCivicLaneKeyword('ҳоким')).toBe(true);
        expect(matchesCivicLaneKeyword('ҳоким келиб кетди')).toBe(true);
        expect(matchesCivicLaneKeyword('tepadagilar')).toBe(true);
        expect(matchesCivicLaneKeyword("tepadagilar e'tibor bermayapti")).toBe(true);
        expect(matchesCivicLaneKeyword('тепадагилар')).toBe(true);
        expect(matchesCivicLaneKeyword('тепадагилар қачон қарайди')).toBe(true);
        expect(matchesCivicLaneKeyword('yuqoridagilar')).toBe(true);
        expect(matchesCivicLaneKeyword('yuqoridagilar bilishi kerak')).toBe(true);
        expect(matchesCivicLaneKeyword('юқоридагилар')).toBe(true);
        expect(matchesCivicLaneKeyword('юқоридагилар ёрдам берсин')).toBe(true);
      });
    });

    describe('Negative matches strictly preventing substring collisions', () => {
      it('rejects substring false positives for gaz (magazin, gazel, gazon, etc.)', () => {
        expect(matchesCivicLaneKeyword('magazin')).toBe(false);
        expect(matchesCivicLaneKeyword('Yangi magazin ochildi')).toBe(false);
        expect(matchesCivicLaneKeyword('gazel')).toBe(false);
        expect(matchesCivicLaneKeyword('Gazel yuk mashinasi keldi')).toBe(false);
        expect(matchesCivicLaneKeyword('gazon')).toBe(false);
        expect(matchesCivicLaneKeyword('Gazon ekildi')).toBe(false);
        expect(matchesCivicLaneKeyword('магазин')).toBe(false);
        expect(matchesCivicLaneKeyword('магазин очяпмиз')).toBe(false);
        expect(matchesCivicLaneKeyword('газель')).toBe(false);
        expect(matchesCivicLaneKeyword('газель сотилади')).toBe(false);
        expect(matchesCivicLaneKeyword('газон')).toBe(false);
        expect(matchesCivicLaneKeyword('янги газон')).toBe(false);
      });

      it('rejects substring false positives for suv (suvoq, suvoqchi, suvarak, etc.)', () => {
        expect(matchesCivicLaneKeyword('suvoq')).toBe(false);
        expect(matchesCivicLaneKeyword('Devor suvoq qilindi')).toBe(false);
        expect(matchesCivicLaneKeyword('suvoqchi')).toBe(false);
        expect(matchesCivicLaneKeyword('Usta suvoqchi kerak')).toBe(false);
        expect(matchesCivicLaneKeyword('suvarak')).toBe(false);
        expect(matchesCivicLaneKeyword("Uyda suvarak paydo bo'ldi")).toBe(false);
        expect(matchesCivicLaneKeyword('сувоқ')).toBe(false);
        expect(matchesCivicLaneKeyword('сувоқ ишлари')).toBe(false);
        expect(matchesCivicLaneKeyword('сувоқчи')).toBe(false);
        expect(matchesCivicLaneKeyword('сувоқчи керак')).toBe(false);
        expect(matchesCivicLaneKeyword('суварак')).toBe(false);
        expect(matchesCivicLaneKeyword('суварак дориси')).toBe(false);
      });

      it('rejects non-civic chat messages, empty input, and whitespace', () => {
        expect(matchesCivicLaneKeyword('')).toBe(false);
        expect(matchesCivicLaneKeyword('   \n\t  ')).toBe(false);
        expect(matchesCivicLaneKeyword(null as unknown as string)).toBe(false);
        expect(matchesCivicLaneKeyword(undefined as unknown as string)).toBe(false);
        expect(matchesCivicLaneKeyword('Salom hammaga, qandaysizlar?')).toBe(false);
        expect(matchesCivicLaneKeyword('Ertaga soat 10:00 da majlis')).toBe(false);
        expect(matchesCivicLaneKeyword('Rahmat katta')).toBe(false);
      });
    });

    describe('Mixed punctuation, emojis, newlines, and case formatting', () => {
      it('matches keywords surrounded by punctuation, quotes, brackets, and underscores', () => {
        expect(matchesCivicLaneKeyword('(gaz)')).toBe(true);
        expect(matchesCivicLaneKeyword('[svet]')).toBe(true);
        expect(matchesCivicLaneKeyword('{suv}')).toBe(true);
        expect(matchesCivicLaneKeyword('«ҳоким»')).toBe(true);
        expect(matchesCivicLaneKeyword('"musor"')).toBe(true);
        expect(matchesCivicLaneKeyword('musor... kelmadi')).toBe(true);
        expect(matchesCivicLaneKeyword("chiqindi? yo'q")).toBe(true);
        expect(matchesCivicLaneKeyword('suv! suv! suv!')).toBe(true);
        expect(matchesCivicLaneKeyword('_gaz_')).toBe(true);
        expect(matchesCivicLaneKeyword('gaz: past')).toBe(true);
        expect(matchesCivicLaneKeyword('svet; uchdi')).toBe(true);
      });

      it('matches keywords adjacent to emojis', () => {
        expect(matchesCivicLaneKeyword("🔥gaz yo'q!")).toBe(true);
        expect(matchesCivicLaneKeyword("svet💡o'chdi")).toBe(true);
        expect(matchesCivicLaneKeyword("🚰 suv qachon bo'ladi?")).toBe(true);
        expect(matchesCivicLaneKeyword("🗑️ musor to'ldi")).toBe(true);
        expect(matchesCivicLaneKeyword("gaz🔥")).toBe(true);
      });

      it('matches keywords across newlines and tabs', () => {
        expect(matchesCivicLaneKeyword('Bugun\ngaz\nkelmadi')).toBe(true);
        expect(matchesCivicLaneKeyword('\t\tsvet\t\t')).toBe(true);
        expect(matchesCivicLaneKeyword('\n\nsuv\n\n')).toBe(true);
      });

      it('matches uppercase and titlecase variants case-insensitively', () => {
        expect(matchesCivicLaneKeyword('GAZ')).toBe(true);
        expect(matchesCivicLaneKeyword('ГАЗ')).toBe(true);
        expect(matchesCivicLaneKeyword('SVET')).toBe(true);
        expect(matchesCivicLaneKeyword('СВЕТ')).toBe(true);
        expect(matchesCivicLaneKeyword('SUV')).toBe(true);
        expect(matchesCivicLaneKeyword('СУВ')).toBe(true);
        expect(matchesCivicLaneKeyword('VODA')).toBe(true);
        expect(matchesCivicLaneKeyword('ВОДА')).toBe(true);
        expect(matchesCivicLaneKeyword('MUSOR')).toBe(true);
        expect(matchesCivicLaneKeyword('МУСОР')).toBe(true);
        expect(matchesCivicLaneKeyword('HOKIM')).toBe(true);
        expect(matchesCivicLaneKeyword('ҲОКИМ')).toBe(true);
        expect(matchesCivicLaneKeyword('TEPADAGILAR')).toBe(true);
        expect(matchesCivicLaneKeyword('ТЕПАДАГИЛАР')).toBe(true);
        expect(matchesCivicLaneKeyword('YUQORIDAGILAR')).toBe(true);
        expect(matchesCivicLaneKeyword('ЮҚОРИДАГИЛАР')).toBe(true);
      });
    });
  });

  describe('Milestone 1: Canonical Uzbek Script Normalization & Open Civic Roots', () => {
    describe('normalizeUzbekScript', () => {
      it('normalizes various apostrophe/quote variants to standard single quote', () => {
        expect(normalizeUzbekScript("ko`cha koʻcha koʼcha ko‘cha ko’cha koˈcha koˊcha ko′cha")).toBe(
          "ko'cha ko'cha ko'cha ko'cha ko'cha ko'cha ko'cha ko'cha",
        );
      });

      it('normalizes mobile keyboard diacritics and breves (ŏ, ō, ö -> o\', yŭq -> yo\'q, bŏpti -> bo\'pti)', () => {
        expect(normalizeUzbekScript('ŏchdi ōchdi ödigan')).toBe("o'chdi o'chdi o'digan");
        expect(normalizeUzbekScript('yŭq yūq yüq')).toBe("yo'q yo'q yo'q");
        expect(normalizeUzbekScript('bŏpti bōpti böpti')).toBe("bo'pti bo'pti bo'pti");
        expect(normalizeUzbekScript('Bizdayam yŭq nima bŏpti gazga... Nega ŏchipti gaz')).toBe(
          "bizdayam yo'q nima bo'pti gazga... nega o'chipti gaz",
        );
      });

      it('normalizes common SMS contractions and colloquial forms', () => {
        expect(normalizeUzbekScript('yuq yoq bopti uchdi ucdi ochdi uchipti')).toBe(
          "yo'q yo'q bo'pti o'chdi o'chdi o'chdi o'chipti",
        );
      });
    });

    describe('Open Civic Roots matching', () => {
      it('matches open roots for Gas across Latin and Cyrillic', () => {
        expect(matchesCivicLaneKeyword('raygaz')).toBe(true);
        expect(matchesCivicLaneKeyword('hududgaz')).toBe(true);
        expect(matchesCivicLaneKeyword('mingaz')).toBe(true);
        expect(matchesCivicLaneKeyword('gazimiz')).toBe(true);
        expect(matchesCivicLaneKeyword('райгаз')).toBe(true);
        expect(matchesCivicLaneKeyword('ҳудудгаз')).toBe(true);
        expect(matchesCivicLaneKeyword('мингаз')).toBe(true);
        expect(matchesCivicLaneKeyword('газимиз')).toBe(true);
        // Exclusions
        expect(matchesCivicLaneKeyword('gazeta')).toBe(false);
        expect(matchesCivicLaneKeyword('газета')).toBe(false);
        expect(matchesCivicLaneKeyword('gazon')).toBe(false);
        expect(matchesCivicLaneKeyword('газон')).toBe(false);
        expect(matchesCivicLaneKeyword('gazel')).toBe(false);
        expect(matchesCivicLaneKeyword('газель')).toBe(false);
      });

      it('matches open roots for Electricity across Latin and Cyrillic', () => {
        expect(matchesCivicLaneKeyword('chiroq')).toBe(true);
        expect(matchesCivicLaneKeyword('chirogimiz')).toBe(true);
        expect(matchesCivicLaneKeyword('elektr')).toBe(true);
        expect(matchesCivicLaneKeyword('tok')).toBe(true);
        expect(matchesCivicLaneKeyword('voltaj')).toBe(true);
        expect(matchesCivicLaneKeyword('napryajeniya')).toBe(true);
        expect(matchesCivicLaneKeyword('transformator')).toBe(true);
        expect(matchesCivicLaneKeyword('свет')).toBe(true);
        expect(matchesCivicLaneKeyword('чироқ')).toBe(true);
        expect(matchesCivicLaneKeyword('электр')).toBe(true);
        expect(matchesCivicLaneKeyword('вольтаж')).toBe(true);
        expect(matchesCivicLaneKeyword('трансформатор')).toBe(true);
        // Exclusions
        expect(matchesCivicLaneKeyword('svetofor')).toBe(false);
        expect(matchesCivicLaneKeyword('светофор')).toBe(false);
      });

      it('matches open roots for Water across Latin and Cyrillic', () => {
        expect(matchesCivicLaneKeyword('vodokanal')).toBe(true);
        expect(matchesCivicLaneKeyword('vodovoz')).toBe(true);
        expect(matchesCivicLaneKeyword('vodoprovod')).toBe(true);
        expect(matchesCivicLaneKeyword('quvur')).toBe(true);
        expect(matchesCivicLaneKeyword('truba')).toBe(true);
        expect(matchesCivicLaneKeyword('kanalizatsiya')).toBe(true);
        expect(matchesCivicLaneKeyword('lyuk')).toBe(true);
        expect(matchesCivicLaneKeyword('nasos')).toBe(true);
        expect(matchesCivicLaneKeyword('водоканал')).toBe(true);
        expect(matchesCivicLaneKeyword('водовоз')).toBe(true);
        expect(matchesCivicLaneKeyword('водопровод')).toBe(true);
        expect(matchesCivicLaneKeyword('қувур')).toBe(true);
        expect(matchesCivicLaneKeyword('труба')).toBe(true);
        expect(matchesCivicLaneKeyword('люк')).toBe(true);
        expect(matchesCivicLaneKeyword('насос')).toBe(true);
      });

      it('matches open roots for Waste and Road across Latin and Cyrillic', () => {
        expect(matchesCivicLaneKeyword('toza hudud')).toBe(true);
        expect(matchesCivicLaneKeyword('maxsustrans')).toBe(true);
        expect(matchesCivicLaneKeyword('тоза ҳудуд')).toBe(true);
        expect(matchesCivicLaneKeyword('махсустранс')).toBe(true);
        expect(matchesCivicLaneKeyword('asfalt')).toBe(true);
        expect(matchesCivicLaneKeyword("ko'chamiz")).toBe(true);
        expect(matchesCivicLaneKeyword("yo'llar")).toBe(true);
        expect(matchesCivicLaneKeyword('асфальт')).toBe(true);
        expect(matchesCivicLaneKeyword('кўчамиз')).toBe(true);
        expect(matchesCivicLaneKeyword('йўллар')).toBe(true);
      });
    });

    describe('hasContextualFollowUpSignal', () => {
      it('matches contextual outage and repair follow-ups in Latin and Cyrillic', () => {
        expect(hasContextualFollowUpSignal('Ремонт.')).toBe(true);
        expect(hasContextualFollowUpSignal('Qayerda avariya ekan yana')).toBe(true);
        expect(hasContextualFollowUpSignal("Bizdayam yo'q")).toBe(true);
        expect(hasContextualFollowUpSignal("Nega o'chdi")).toBe(true);
        expect(hasContextualFollowUpSignal('қачон беришади?')).toBe(true);
        expect(hasContextualFollowUpSignal('профилактика бўляптими')).toBe(true);
        expect(hasContextualFollowUpSignal('таъмир ишлари кетмоқда')).toBe(true);
      });

      it('returns false for general chatter without follow-up signals', () => {
        expect(hasContextualFollowUpSignal('Ха.айтманг')).toBe(false);
        expect(hasContextualFollowUpSignal('Salom hammaga')).toBe(false);
        expect(hasContextualFollowUpSignal('Rahmat kattakon')).toBe(false);
        expect(hasContextualFollowUpSignal("Ertaga ko'rishamiz")).toBe(false);
      });
    });

    describe('hasSelfContainedCivicSignal with normalized scripts and stems', () => {
      it('returns true for prompt-specified edge cases', () => {
        expect(hasSelfContainedCivicSignal('Газ сизиб чиқаяптийкан')).toBe(true);
        expect(
          hasSelfContainedCivicSignal('Bizdayam yŭq nima bŏpti gazga... Nega ŏchipti gaz'),
        ).toBe(true);
      });
    });
  });
});

