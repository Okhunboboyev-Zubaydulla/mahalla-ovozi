/**
 * MTProto Userbot Client Port & Factory Interface (Ticket 07 & Ticket 18).
 * Defines client abstraction for MTProto connections per District session.
 *
 * INVARIANT: Passive-only intake. This port intentionally exposes NO write methods
 * (no message sending, invitations, reactions, or chat joining).
 */

export interface UserbotClientEvents {
  message: (update: unknown) => void;
  disconnect: (reason?: string | Error) => void;
  reconnect: () => void;
  error: (err: Error) => void;
  ban: (details?: { reason?: string; error?: Error }) => void;
}

export type UserbotClientEvent = keyof UserbotClientEvents;

export interface UserbotClientPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  on<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
  off?<E extends keyof UserbotClientEvents>(event: E, listener: UserbotClientEvents[E]): void;
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

export type UserbotClientFactory = (params: {
  districtId: string;
  sessionString: string;
  apiId: string;
  apiHash?: string | null;
  phoneNumber: string;
}) => UserbotClientPort;

