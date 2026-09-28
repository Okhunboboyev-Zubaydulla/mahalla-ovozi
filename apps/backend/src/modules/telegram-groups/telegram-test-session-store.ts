export interface TestSession {
  districtId: string;
  groupId: string;
  chatId: string;
  botId: string;
  status: 'PENDING' | 'SUCCESS' | 'TIMEOUT' | 'FAILED';
  openedAt: Date;
  expiresAt: Date;
  testMessageReceivedAt?: Date;
  lastError?: string;
}

export interface CreateSessionParams {
  districtId: string;
  groupId: string;
  chatId: string;
  botId: string;
  ttlMs?: number;
}

export class TelegramTestSessionManager {
  private static readonly MAX_SESSIONS = 5000;
  private sessionsByGroup = new Map<string, TestSession>();
  private groupKeyByChatId = new Map<string, string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweepExpired(), 30_000);
    this.sweepTimer.unref();
  }

  private makeGroupKey(districtId: string, groupId: string): string {
    return `${districtId}:${groupId}`;
  }

  public sweepExpired(): void {
    const now = Date.now();
    for (const [key, session] of this.sessionsByGroup.entries()) {
      if (now > session.expiresAt.getTime()) {
        this.groupKeyByChatId.delete(session.chatId);
        this.sessionsByGroup.delete(key);
      }
    }
  }

  createSession(params: CreateSessionParams): TestSession {
    if (this.sessionsByGroup.size >= TelegramTestSessionManager.MAX_SESSIONS) {
      this.sweepExpired();
      if (this.sessionsByGroup.size >= TelegramTestSessionManager.MAX_SESSIONS) {
        const firstKey = this.sessionsByGroup.keys().next().value;
        if (firstKey) {
          const oldSession = this.sessionsByGroup.get(firstKey);
          if (oldSession) {
            this.groupKeyByChatId.delete(oldSession.chatId);
          }
          this.sessionsByGroup.delete(firstKey);
        }
      }
    }

    const groupKey = this.makeGroupKey(params.districtId, params.groupId);
    const ttl = params.ttlMs ?? 65_000;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl);

    const existing = this.sessionsByGroup.get(groupKey);
    if (existing) {
      this.groupKeyByChatId.delete(existing.chatId);
    }

    const session: TestSession = {
      districtId: params.districtId,
      groupId: params.groupId,
      chatId: params.chatId,
      botId: params.botId,
      status: 'PENDING',
      openedAt: now,
      expiresAt,
    };

    this.sessionsByGroup.set(groupKey, session);
    this.groupKeyByChatId.set(params.chatId, groupKey);

    return session;
  }

  getSession(districtId: string, groupId: string): TestSession | null {
    const groupKey = this.makeGroupKey(districtId, groupId);
    const session = this.sessionsByGroup.get(groupKey);
    if (!session) return null;

    if (session.status === 'PENDING' && Date.now() > session.expiresAt.getTime()) {
      session.status = 'TIMEOUT';
      session.lastError = 'Синов вақти (60 сония) тугади. Ҳақиқий одам томонидан хабар юборилмади.';
      this.groupKeyByChatId.delete(session.chatId);
    }

    return session;
  }

  findActiveSessionByChatId(chatId: string): TestSession | null {
    const groupKey = this.groupKeyByChatId.get(chatId);
    if (!groupKey) return null;

    const session = this.sessionsByGroup.get(groupKey);
    if (!session) {
      this.groupKeyByChatId.delete(chatId);
      return null;
    }

    if (session.status === 'PENDING' && Date.now() > session.expiresAt.getTime()) {
      session.status = 'TIMEOUT';
      session.lastError = 'Синов вақти (60 сония) тугади. Ҳақиқий одам томонидан хабар юборилмади.';
      this.groupKeyByChatId.delete(chatId);
      return null;
    }

    if (session.status !== 'PENDING') {
      return null;
    }

    return session;
  }

  resolveSessionSuccess(districtId: string, groupId: string, receivedAt: Date = new Date()): TestSession | null {
    const groupKey = this.makeGroupKey(districtId, groupId);
    const session = this.sessionsByGroup.get(groupKey);
    if (session) {
      session.status = 'SUCCESS';
      session.testMessageReceivedAt = receivedAt;
      session.lastError = undefined;
      this.groupKeyByChatId.delete(session.chatId);
      return session;
    }
    return null;
  }

  resolveSessionFailure(districtId: string, groupId: string, errorReason: string): TestSession | null {
    const groupKey = this.makeGroupKey(districtId, groupId);
    const session = this.sessionsByGroup.get(groupKey);
    if (session) {
      session.status = 'FAILED';
      session.lastError = errorReason;
      this.groupKeyByChatId.delete(session.chatId);
      return session;
    }
    return null;
  }

  clear(): void {
    this.sessionsByGroup.clear();
    this.groupKeyByChatId.clear();
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }
}

export const globalTestSessionManager = new TelegramTestSessionManager();
