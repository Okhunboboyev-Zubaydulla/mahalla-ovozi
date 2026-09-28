import { describe, it, expect } from 'vitest';
import {
  filterTelegramMessage,
  TelegramIncomingMessage,
} from '../src/modules/telegram-intake/telegram-content-qualification.js';

describe('Telegram Message Filter Predicate (Pure)', () => {
  it('accepts a valid ordinary human text message', () => {
    const message: TelegramIncomingMessage = {
      message_id: 101,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup', title: 'Navbahor Mahalla' },
      from: { id: 987654321, is_bot: false, first_name: 'Anvar' },
      text: 'Маҳалламизда йўл таъмири бўйича мурожаат бор эди.',
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(true);
    expect(result.text).toBe('Маҳалламизда йўл таъмири бўйича мурожаат бор эди.');
  });

  it('accepts a message with photo caption as text', () => {
    const message: TelegramIncomingMessage = {
      message_id: 102,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'group', title: 'Navbahor Mahalla' },
      from: { id: 987654321, is_bot: false, first_name: 'Dilshod' },
      caption: 'Чиқиндихона ҳолати тўғрисида фотоҳисобот.',
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(true);
    expect(result.text).toBe('Чиқиндихона ҳолати тўғрисида фотоҳисобот.');
  });

  it('rejects bot senders (from.is_bot === true)', () => {
    const message: TelegramIncomingMessage = {
      message_id: 103,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 111222333, is_bot: true, first_name: 'SomeBot' },
      text: 'Автоматик бот хабари',
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('BOT_SENDER');
  });

  it('rejects channel/sender_chat senders', () => {
    const message: TelegramIncomingMessage = {
      message_id: 104,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      sender_chat: { id: -100999888777, type: 'channel', title: 'Kanal' },
      text: 'Канал номидан юборилган хабар',
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('BOT_SENDER');
  });

  it('rejects modern forward_origin (Bot API 7.0+ user origin)', () => {
    const message: TelegramIncomingMessage = {
      message_id: 105,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 987654321, is_bot: false, first_name: 'Rustam' },
      text: 'Форвард қилинган матн',
      forward_origin: {
        type: 'user',
        date: 1699999000,
        sender_user: { id: 12345, is_bot: false, first_name: 'Asror' },
      },
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('FORWARDED_MESSAGE');
  });

  it('rejects legacy forward fields (forward_date / forward_from)', () => {
    const message: TelegramIncomingMessage = {
      message_id: 106,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 987654321, is_bot: false, first_name: 'Rustam' },
      text: 'Эски форматдаги форвард',
      forward_date: 1699999000,
      forward_from: { id: 12345, is_bot: false, first_name: 'Asror' },
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('FORWARDED_MESSAGE');
  });

  it('rejects slash-command text (/start, /help)', () => {
    const message: TelegramIncomingMessage = {
      message_id: 107,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 987654321, is_bot: false, first_name: 'Rustam' },
      text: '/start test-token',
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('BOT_COMMAND');
  });

  it('rejects messages containing bot_command entities', () => {
    const message: TelegramIncomingMessage = {
      message_id: 108,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 987654321, is_bot: false, first_name: 'Rustam' },
      text: 'Бу ерда буйруқ бор /status текшириш',
      entities: [{ type: 'bot_command', offset: 18, length: 7 }],
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('BOT_COMMAND');
  });

  it('rejects empty or whitespace-only messages', () => {
    const message: TelegramIncomingMessage = {
      message_id: 109,
      date: 1700000000,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 987654321, is_bot: false, first_name: 'Rustam' },
      text: '   \n   ',
    };

    const result = filterTelegramMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('EMPTY_CONTENT');
  });

  it('rejects null/undefined message gracefully', () => {
    const result = filterTelegramMessage(null);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('EMPTY_CONTENT');
  });
});
