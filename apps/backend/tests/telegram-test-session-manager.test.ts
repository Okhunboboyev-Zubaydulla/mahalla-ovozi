import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramTestSessionManager } from '../src/modules/telegram-groups/telegram-test-session-store.js';

describe('TelegramTestSessionManager (In-Memory)', () => {
  let manager: TelegramTestSessionManager;

  beforeEach(() => {
    manager = new TelegramTestSessionManager();
  });

  it('creates and retrieves a new test session', () => {
    const session = manager.createSession({
      districtId: 'dist_1',
      groupId: 'grp_1',
      chatId: '-1001234567890',
      botId: 'bot_123',
    });

    expect(session.status).toBe('PENDING');
    expect(session.districtId).toBe('dist_1');
    expect(session.groupId).toBe('grp_1');
    expect(session.chatId).toBe('-1001234567890');
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const retrieved = manager.getSession('dist_1', 'grp_1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.status).toBe('PENDING');
  });

  it('finds active session by chatId', () => {
    manager.createSession({
      districtId: 'dist_1',
      groupId: 'grp_1',
      chatId: '-1001234567890',
      botId: 'bot_123',
    });

    const session = manager.findActiveSessionByChatId('-1001234567890');
    expect(session).toBeDefined();
    expect(session?.groupId).toBe('grp_1');
  });

  it('resolves session successfully when test message is received', () => {
    manager.createSession({
      districtId: 'dist_1',
      groupId: 'grp_1',
      chatId: '-1001234567890',
      botId: 'bot_123',
    });

    const resolved = manager.resolveSessionSuccess('dist_1', 'grp_1');
    expect(resolved?.status).toBe('SUCCESS');
    expect(resolved?.testMessageReceivedAt).toBeDefined();

    // Verify subsequent getSession returns SUCCESS
    const current = manager.getSession('dist_1', 'grp_1');
    expect(current?.status).toBe('SUCCESS');
  });

  it('marks session as TIMEOUT when requested or expired', () => {
    vi.useFakeTimers();

    manager.createSession({
      districtId: 'dist_1',
      groupId: 'grp_1',
      chatId: '-1001234567890',
      botId: 'bot_123',
      ttlMs: 65000,
    });

    // Advance time past 65s
    vi.advanceTimersByTime(70000);

    const session = manager.getSession('dist_1', 'grp_1');
    expect(session?.status).toBe('TIMEOUT');

    // Should not find active session by chatId after timeout
    const active = manager.findActiveSessionByChatId('-1001234567890');
    expect(active).toBeNull();

    vi.useRealTimers();
  });

  it('overwrites previous session for the same group cleanly', () => {
    manager.createSession({
      districtId: 'dist_1',
      groupId: 'grp_1',
      chatId: '-1001111111111',
      botId: 'bot_123',
    });

    manager.createSession({
      districtId: 'dist_1',
      groupId: 'grp_1',
      chatId: '-1002222222222',
      botId: 'bot_123',
    });

    expect(manager.findActiveSessionByChatId('-1001111111111')).toBeNull();
    expect(manager.findActiveSessionByChatId('-1002222222222')).toBeDefined();
  });
});
