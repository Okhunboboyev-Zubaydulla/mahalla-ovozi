/**
 * MTProto Userbot Client Port & Factory Interface (Ticket 07 & Ticket 18).
 * Defines client abstraction for MTProto connections per District session.
 *
 * INVARIANT: Passive-only intake. This port intentionally exposes NO write methods
 * (no message sending, invitations, reactions, or chat joining).
 */

export type UserbotSignalCategory =
  | 'ACCOUNT_BANNED'
  | 'AUTH_KEY_DUPLICATED'
  | 'ACCOUNT_DELETED'
  | 'SESSION_REVOKED'
  | 'FLOOD_WAIT'
  | 'PEER_FLOOD'
  | 'ACCOUNT_RESTRICTION'
  | 'UNRECOVERABLE_GAP'
  | 'TRANSIENT_DISCONNECT'
  | 'UNCLASSIFIED';

export interface UserbotSignalBase {
  category: UserbotSignalCategory;
  reason: string;
  error?: Error;
}

export interface UserbotAccountBannedSignal extends UserbotSignalBase {
  category: 'ACCOUNT_BANNED';
}

export interface UserbotAuthKeyDuplicatedSignal extends UserbotSignalBase {
  category: 'AUTH_KEY_DUPLICATED';
}

export interface UserbotAccountDeletedSignal extends UserbotSignalBase {
  category: 'ACCOUNT_DELETED';
}

export interface UserbotSessionRevokedSignal extends UserbotSignalBase {
  category: 'SESSION_REVOKED';
}

export interface UserbotFloodWaitSignal extends UserbotSignalBase {
  category: 'FLOOD_WAIT';
  waitSeconds: number;
}

export interface UserbotPeerFloodSignal extends UserbotSignalBase {
  category: 'PEER_FLOOD';
}

export interface UserbotAccountRestrictionSignal extends UserbotSignalBase {
  category: 'ACCOUNT_RESTRICTION';
}

export interface UserbotUnrecoverableGapSignal extends UserbotSignalBase {
  category: 'UNRECOVERABLE_GAP';
  lastKnownPosition?: string | null;
}

export interface UserbotTransientDisconnectSignal extends UserbotSignalBase {
  category: 'TRANSIENT_DISCONNECT';
}

export interface UserbotUnclassifiedSignal extends UserbotSignalBase {
  category: 'UNCLASSIFIED';
}

export type ClassifiedUserbotSignal =
  | UserbotAccountBannedSignal
  | UserbotAuthKeyDuplicatedSignal
  | UserbotAccountDeletedSignal
  | UserbotSessionRevokedSignal
  | UserbotFloodWaitSignal
  | UserbotPeerFloodSignal
  | UserbotAccountRestrictionSignal
  | UserbotUnrecoverableGapSignal
  | UserbotTransientDisconnectSignal
  | UserbotUnclassifiedSignal;

export class UserbotSignalError extends Error {
  readonly category: UserbotSignalCategory;
  readonly signal: ClassifiedUserbotSignal;

  constructor(signal: ClassifiedUserbotSignal) {
    super(signal.reason);
    this.name = 'UserbotSignalError';
    this.category = signal.category;
    this.signal = signal;
    if (signal.error?.stack) {
      this.stack = signal.error.stack;
    }
  }
}

export interface UserbotClientEvents {
  message: (update: unknown) => void;
  disconnect: (reason?: string | Error) => void;
  reconnect: () => void;
  error: (err: Error) => void;
  ban: (details?: { reason?: string; error?: Error }) => void;
  gap: (details?: { reason?: string; lastKnownPosition?: string | null; error?: Error }) => void;
  signal: (signal: ClassifiedUserbotSignal) => void;
}

export type UserbotClientEvent = keyof UserbotClientEvents;

export interface UserbotClientPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  off?<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  getUpdatePosition?(): string | null;
}

// Compile-time guard ensuring UserbotClientPort does not define any write methods
type ForbiddenWriteMethodNames =
  | 'send'
  | 'sendMessage'
  | 'sendMedia'
  | 'invite'
  | 'inviteToChannel'
  | 'react'
  | 'sendReaction'
  | 'join'
  | 'joinChat'
  | 'joinChannel'
  | 'leave'
  | 'leaveChat'
  | 'deleteMessage'
  | 'deleteMessages'
  | 'editMessage';

type ValidateNoWriteMethods<T> = keyof T & ForbiddenWriteMethodNames extends never ? true : never;

export type _AssertPassiveOnlyPort = ValidateNoWriteMethods<UserbotClientPort>;

export interface UserbotClientFactoryOptions {
  districtId: string;
  sessionString: string;
  apiId: string;
  apiHash?: string | null;
  phoneNumber: string;
  initialUpdatePosition?: string | null;
}

export type UserbotClientFactory = (params: UserbotClientFactoryOptions) => UserbotClientPort;

