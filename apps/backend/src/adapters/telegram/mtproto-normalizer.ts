/**
 * MTProto to Canonical Envelope Normalizer (Ticket 08).
 * Pure domain normalization unit converting MTProto updates into
 * Bot-API-compatible canonical ingest envelopes.
 *
 * Adheres strictly to AD-1 (Hexagonal Architecture / Pure Domain Logic),
 * pure functions over OOP classes, no default parameter values,
 * and zero external I/O / DB / network dependencies.
 */

import { getTashkentCalendarDay, type GroupTransport } from '@mahalla-ovozi/api-contracts';
import type {
  TelegramIncomingMessage,
  TelegramMessageEntity,
  TelegramUser,
  TelegramChat,
  TelegramMessageOrigin,
} from './telegram-types.js';

export interface CanonicalIngestEnvelope {
  transport: GroupTransport;
  chatId: string;
  messageId: string;
  originalTimestamp: Date;
  calendarDay: string; // Tashkent YYYY-MM-DD
  normalizedMessage: TelegramIncomingMessage; // Bot-API-compatible
  rawPayload: unknown;
}

export type MtprotoDropReason =
  | 'SERVICE_MESSAGE'
  | 'UNSUPPORTED_UPDATE_TYPE'
  | 'EMPTY_MESSAGE'
  | 'MALFORMED_UPDATE';

export type MtprotoNormalizationResult =
  | {
      status: 'NORMALIZED';
      envelope: CanonicalIngestEnvelope;
    }
  | {
      status: 'DROPPED';
      reason: MtprotoDropReason;
      rawPayload?: unknown;
    };

interface MtprotoUserRecord {
  id?: unknown;
  bot?: boolean;
  is_bot?: boolean;
  firstName?: string;
  first_name?: string;
  lastName?: string;
  last_name?: string;
  username?: string;
  [key: string]: unknown;
}

function getTypeName(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  if (typeof record._ === 'string') {
    return record._;
  }
  if (typeof record.className === 'string') {
    return record.className;
  }
  return undefined;
}

function cleanIdString(id: unknown): string {
  if (typeof id === 'bigint') {
    return id.toString().replace(/^-/, '');
  }
  if (typeof id === 'number') {
    return Math.abs(id).toString();
  }
  if (typeof id === 'string') {
    return id.replace(/^-/, '');
  }
  return String(id ?? '');
}

function extractChatInfo(
  peer: unknown,
  isPost: boolean,
): { chatIdStr: string; chatIdNum: number; chatType: 'supergroup' | 'channel' | 'group' | 'private' } | null {
  if (!peer) {
    return null;
  }

  if (typeof peer === 'object') {
    const p = peer as Record<string, unknown>;
    const typeName = getTypeName(p);

    // Supergroup or Channel: PeerChannel
    if (p.channelId !== undefined || typeName === 'PeerChannel' || typeName === 'peerChannel') {
      const rawStr = p.channelId !== undefined ? String(p.channelId) : '';
      let chatIdStr: string;
      if (rawStr.startsWith('-100')) {
        chatIdStr = rawStr;
      } else {
        const positiveStr = rawStr.replace(/^-/, '');
        chatIdStr = `-100${positiveStr}`;
      }
      const chatIdNum = Number(chatIdStr);
      const chatType = isPost ? 'channel' : 'supergroup';
      return {
        chatIdStr,
        chatIdNum: Number.isFinite(chatIdNum) ? chatIdNum : Number(chatIdStr.slice(0, 15)),
        chatType,
      };
    }

    // Basic Group: PeerChat
    if (p.chatId !== undefined || typeName === 'PeerChat' || typeName === 'peerChat') {
      const rawStr = p.chatId !== undefined ? String(p.chatId) : '';
      let chatIdStr: string;
      if (rawStr.startsWith('-') && !rawStr.startsWith('-100')) {
        chatIdStr = rawStr;
      } else {
        const positiveStr = rawStr.replace(/^-/, '');
        chatIdStr = `-${positiveStr}`;
      }
      const chatIdNum = Number(chatIdStr);
      return {
        chatIdStr,
        chatIdNum: Number.isFinite(chatIdNum) ? chatIdNum : 0,
        chatType: 'group',
      };
    }

    // Private Chat: PeerUser
    if (p.userId !== undefined || typeName === 'PeerUser' || typeName === 'peerUser') {
      const rawStr = p.userId !== undefined ? String(p.userId) : '';
      const cleanUser = rawStr.replace(/^-/, '');
      const chatIdNum = Number(cleanUser);
      return {
        chatIdStr: cleanUser,
        chatIdNum: Number.isFinite(chatIdNum) ? chatIdNum : 0,
        chatType: 'private',
      };
    }
  }

  if (typeof peer === 'number' || typeof peer === 'bigint' || typeof peer === 'string') {
    const str = String(peer);
    if (str.startsWith('-100')) {
      return {
        chatIdStr: str,
        chatIdNum: Number(str),
        chatType: isPost ? 'channel' : 'supergroup',
      };
    }
    if (str.startsWith('-')) {
      return {
        chatIdStr: str,
        chatIdNum: Number(str),
        chatType: 'group',
      };
    }
    return {
      chatIdStr: str,
      chatIdNum: Number(str),
      chatType: 'private',
    };
  }

  return null;
}

function findUserInPayload(payload: Record<string, unknown>, userId: string): MtprotoUserRecord | undefined {
  if (Array.isArray(payload.users)) {
    for (const u of payload.users) {
      if (u && typeof u === 'object') {
        const uRec = u as MtprotoUserRecord;
        if (uRec.id !== undefined && String(uRec.id) === userId) {
          return uRec;
        }
      }
    }
  }
  return undefined;
}

function resolveUserFromPeer(
  peer: unknown,
  payload: Record<string, unknown>,
): TelegramUser | undefined {
  if (!peer) {
    return undefined;
  }

  if (typeof peer === 'object') {
    const p = peer as Record<string, unknown>;
    const peerType = getTypeName(p);

    if (
      peerType === 'PeerChannel' ||
      peerType === 'peerChannel' ||
      peerType === 'PeerChat' ||
      peerType === 'peerChat' ||
      p.channelId !== undefined ||
      p.channel_id !== undefined ||
      p.chatId !== undefined ||
      p.chat_id !== undefined
    ) {
      return undefined;
    }

    if (
      p.userId !== undefined ||
      p.user_id !== undefined ||
      peerType === 'PeerUser' ||
      peerType === 'peerUser' ||
      p.id !== undefined
    ) {
      const rawUserId = p.userId ?? p.user_id ?? p.id;
      const userIdStr = cleanIdString(rawUserId);
      if (!userIdStr) return undefined;
      const userRec = findUserInPayload(payload, userIdStr);
      const userIdNum = Number(userIdStr);
      return {
        id: Number.isFinite(userIdNum) ? userIdNum : userIdStr,
        is_bot: Boolean(userRec?.bot || userRec?.is_bot),
        first_name: userRec?.firstName || userRec?.first_name || `User ${userIdStr}`,
        ...(userRec?.lastName || userRec?.last_name ? { last_name: userRec.lastName || userRec.last_name } : {}),
        ...(userRec?.username ? { username: userRec.username } : {}),
      };
    }
  }

  if (typeof peer === 'number' || typeof peer === 'bigint' || typeof peer === 'string') {
    const str = String(peer);
    if (str.startsWith('-')) {
      return undefined;
    }
    const userIdStr = cleanIdString(peer);
    if (!userIdStr) return undefined;
    const userRec = findUserInPayload(payload, userIdStr);
    const userIdNum = Number(userIdStr);
    return {
      id: Number.isFinite(userIdNum) ? userIdNum : userIdStr,
      is_bot: Boolean(userRec?.bot || userRec?.is_bot),
      first_name: userRec?.firstName || userRec?.first_name || `User ${userIdStr}`,
      ...(userRec?.lastName || userRec?.last_name ? { last_name: userRec.lastName || userRec.last_name } : {}),
      ...(userRec?.username ? { username: userRec.username } : {}),
    };
  }

  return undefined;
}

function mapEntityType(typeName: string | undefined): string {
  if (!typeName) {
    return 'unknown';
  }
  switch (typeName) {
    case 'MessageEntityBotCommand':
    case 'messageEntityBotCommand':
      return 'bot_command';
    case 'MessageEntityBold':
    case 'messageEntityBold':
      return 'bold';
    case 'MessageEntityItalic':
    case 'messageEntityItalic':
      return 'italic';
    case 'MessageEntityUnderline':
    case 'messageEntityUnderline':
      return 'underline';
    case 'MessageEntityStrike':
    case 'messageEntityStrike':
      return 'strikethrough';
    case 'MessageEntityCode':
    case 'messageEntityCode':
      return 'code';
    case 'MessageEntityPre':
    case 'messageEntityPre':
      return 'pre';
    case 'MessageEntityMention':
    case 'messageEntityMention':
      return 'mention';
    case 'MessageEntityHashtag':
    case 'messageEntityHashtag':
      return 'hashtag';
    case 'MessageEntityUrl':
    case 'messageEntityUrl':
      return 'url';
    case 'MessageEntityTextUrl':
    case 'messageEntityTextUrl':
      return 'text_url';
    case 'MessageEntityCustomEmoji':
    case 'messageEntityCustomEmoji':
      return 'custom_emoji';
    case 'MessageEntityBlockquote':
    case 'messageEntityBlockquote':
      return 'blockquote';
    default:
      return typeName.replace(/^MessageEntity/i, '').toLowerCase();
  }
}

function normalizeEntities(rawEntities: unknown): TelegramMessageEntity[] {
  if (!Array.isArray(rawEntities)) {
    return [];
  }
  const result: TelegramMessageEntity[] = [];
  for (const item of rawEntities) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const ent = item as Record<string, unknown>;
    const type = typeof ent.type === 'string' ? ent.type : mapEntityType(getTypeName(ent));
    const offset = Number(ent.offset ?? 0);
    const length = Number(ent.length ?? 0);
    const url = typeof ent.url === 'string' ? ent.url : undefined;
    result.push({
      type,
      offset,
      length,
      ...(url ? { url } : {}),
    });
  }
  return result;
}

/**
 * Pure normalization function converting MTProto updates into a canonical Bot-API envelope.
 * Returns either a NORMALIZED result containing the canonical envelope,
 * or a DROPPED result with an explicit MTProto drop reason.
 */
export function normalizeMtprotoUpdate(update: unknown): MtprotoNormalizationResult {
  if (!update || typeof update !== 'object') {
    return {
      status: 'DROPPED',
      reason: 'MALFORMED_UPDATE',
      rawPayload: update,
    };
  }

  const payload = update as Record<string, unknown>;
  const rootType = getTypeName(payload);

  // 1. Explicit non-message updates
  if (
    rootType === 'UpdateDeleteMessages' ||
    rootType === 'UpdateDeleteChannelMessages' ||
    rootType === 'UpdateUserStatus' ||
    rootType === 'UpdateUserTyping' ||
    rootType === 'UpdateChatUserTyping' ||
    rootType === 'UpdateReadHistoryInbox' ||
    rootType === 'UpdateReadHistoryOutbox' ||
    rootType === 'UpdateChannel' ||
    rootType === 'UpdateChat' ||
    rootType === 'UpdateDraftMessage' ||
    rootType === 'UpdateDialogPinned' ||
    rootType === 'UpdatePinnedDialogs'
  ) {
    return {
      status: 'DROPPED',
      reason: 'UNSUPPORTED_UPDATE_TYPE',
      rawPayload: update,
    };
  }

  // 2. Locate the candidate message object
  const rawMsg = (
    payload.message !== undefined && payload.message !== null && typeof payload.message === 'object'
      ? payload.message
      : payload
  ) as Record<string, unknown>;

  const msgType = getTypeName(rawMsg);

  // 3. Service messages (pin, edit title, join, leave, etc.)
  if (
    msgType === 'MessageService' ||
    msgType === 'messageService' ||
    (rawMsg.action !== undefined && rawMsg.action !== null && typeof rawMsg.action === 'object')
  ) {
    return {
      status: 'DROPPED',
      reason: 'SERVICE_MESSAGE',
      rawPayload: update,
    };
  }

  // 4. Empty messages
  if (msgType === 'MessageEmpty' || msgType === 'messageEmpty') {
    return {
      status: 'DROPPED',
      reason: 'EMPTY_MESSAGE',
      rawPayload: update,
    };
  }

  // 5. If root update is an Update... but has no valid message
  if (rootType && rootType.startsWith('Update') && !('message' in payload)) {
    return {
      status: 'DROPPED',
      reason: 'UNSUPPORTED_UPDATE_TYPE',
      rawPayload: update,
    };
  }

  // 6. Structural message integrity validation
  const rawId = rawMsg.id;
  const rawPeerId = rawMsg.peerId ?? rawMsg.peer_id;
  const rawDate = rawMsg.date;

  if (
    rawId === undefined ||
    rawId === null ||
    rawPeerId === undefined ||
    rawPeerId === null ||
    rawDate === undefined ||
    rawDate === null ||
    typeof rawDate !== 'number' ||
    !Number.isFinite(rawDate) ||
    rawDate <= 0
  ) {
    if (
      Object.keys(payload).length === 0 ||
      msgType === 'Message' ||
      msgType === 'message' ||
      rawId !== undefined ||
      rawPeerId !== undefined ||
      rawDate !== undefined ||
      payload.message !== undefined
    ) {
      return {
        status: 'DROPPED',
        reason: 'MALFORMED_UPDATE',
        rawPayload: update,
      };
    }
    return {
      status: 'DROPPED',
      reason: 'UNSUPPORTED_UPDATE_TYPE',
      rawPayload: update,
    };
  }

  const messageIdNum = Number(rawId);
  const messageIdStr = String(rawId);
  const isPost = rawMsg.post === true;

  // 7. Resolve Chat
  const chatInfo = extractChatInfo(rawPeerId, isPost);
  if (!chatInfo) {
    return {
      status: 'DROPPED',
      reason: 'MALFORMED_UPDATE',
      rawPayload: update,
    };
  }

  const chat: TelegramChat = {
    id: chatInfo.chatIdNum,
    type: chatInfo.chatType,
  };

  // 8. Resolve Sender (from vs sender_chat)
  let from: TelegramUser | undefined;
  let senderChat: TelegramChat | undefined;

  const fromId = (rawMsg.fromId ?? rawMsg.from_id) as Record<string, unknown> | undefined;
  const fromType = getTypeName(fromId);

  if (
    isPost ||
    fromType === 'PeerChannel' ||
    fromType === 'peerChannel' ||
    fromId?.channelId !== undefined ||
    fromId?.channel_id !== undefined
  ) {
    const senderChannelId =
      fromId?.channelId !== undefined
        ? cleanIdString(fromId.channelId)
        : fromId?.channel_id !== undefined
          ? cleanIdString(fromId.channel_id)
          : cleanIdString(chatInfo.chatIdStr);
    senderChat = {
      id: Number(`-100${senderChannelId}`),
      type: 'channel',
    };
  } else if (
    fromId &&
    (fromId.userId !== undefined ||
      fromId.user_id !== undefined ||
      fromType === 'PeerUser' ||
      fromType === 'peerUser' ||
      typeof fromId === 'number' ||
      typeof fromId === 'string')
  ) {
    from = resolveUserFromPeer(fromId, payload);
  } else if (chatInfo.chatType === 'private') {
    from = resolveUserFromPeer(chatInfo.chatIdStr, payload);
  }

  // 9. Timestamps & Calendar Day
  const unixSeconds = rawDate > 1e11 ? Math.floor(rawDate / 1000) : Math.floor(rawDate);
  const originalTimestamp = new Date(unixSeconds * 1000);
  const calendarDay = getTashkentCalendarDay(originalTimestamp);

  // 10. Forward metadata
  let forwardOrigin: TelegramMessageOrigin | undefined;
  let forwardDate: number | undefined;
  let forwardFrom: TelegramUser | undefined;
  let forwardFromChat: TelegramChat | undefined;
  let forwardFromMessageId: number | undefined;
  let forwardSenderName: string | undefined;

  const fwdFrom = (rawMsg.fwdFrom ?? rawMsg.fwd_from) as Record<string, unknown> | undefined;
  if (fwdFrom && typeof fwdFrom === 'object') {
    forwardDate = typeof fwdFrom.date === 'number' ? fwdFrom.date : unixSeconds;

    const fwdFromId = (fwdFrom.fromId ?? fwdFrom.from_id) as Record<string, unknown> | undefined;
    const fwdFromType = getTypeName(fwdFromId);

    if (
      fwdFromId &&
      (fwdFromId.userId !== undefined ||
        fwdFromId.user_id !== undefined ||
        fwdFromType === 'PeerUser' ||
        fwdFromType === 'peerUser' ||
        typeof fwdFromId === 'number' ||
        typeof fwdFromId === 'string')
    ) {
      forwardFrom = resolveUserFromPeer(fwdFromId, payload);
      if (forwardFrom) {
        forwardOrigin = {
          type: 'user',
          date: forwardDate,
          sender_user: forwardFrom,
        };
      }
    } else if (
      fwdFromId &&
      (fwdFromId.channelId !== undefined ||
        fwdFromId.channel_id !== undefined ||
        fwdFromType === 'PeerChannel' ||
        fwdFromType === 'peerChannel')
    ) {
      const fwdChannelIdStr = cleanIdString(fwdFromId.channelId ?? fwdFromId.channel_id);
      const channelChatIdStr = `-100${fwdChannelIdStr}`;
      forwardFromChat = {
        id: channelChatIdStr,
        type: 'channel',
      };
      const channelPost = fwdFrom.channelPost ?? fwdFrom.channel_post;
      forwardFromMessageId = typeof channelPost === 'number' ? channelPost : undefined;
      forwardOrigin = {
        type: 'channel',
        date: forwardDate,
        chat: {
          id: channelChatIdStr,
          type: 'channel',
        },
        message_id: forwardFromMessageId ?? 0,
      };
    } else if (
      fwdFromId &&
      (fwdFromId.chatId !== undefined ||
        fwdFromId.chat_id !== undefined ||
        fwdFromType === 'PeerChat' ||
        fwdFromType === 'peerChat')
    ) {
      const fwdChatIdStr = cleanIdString(fwdFromId.chatId ?? fwdFromId.chat_id);
      const groupChatIdStr = `-${fwdChatIdStr}`;
      forwardFromChat = {
        id: groupChatIdStr,
        type: 'group',
      };
      forwardOrigin = {
        type: 'chat',
        date: forwardDate,
        sender_chat: {
          id: groupChatIdStr,
          type: 'group',
        },
      };
    } else if (typeof fwdFrom.fromName === 'string' && fwdFrom.fromName.trim().length > 0) {
      forwardSenderName = fwdFrom.fromName;
      forwardOrigin = {
        type: 'hidden_user',
        date: forwardDate,
        sender_user_name: fwdFrom.fromName,
      };
    } else if (typeof fwdFrom.from_name === 'string' && fwdFrom.from_name.trim().length > 0) {
      forwardSenderName = fwdFrom.from_name;
      forwardOrigin = {
        type: 'hidden_user',
        date: forwardDate,
        sender_user_name: fwdFrom.from_name,
      };
    } else {
      forwardOrigin = {
        type: 'hidden_user',
        date: forwardDate,
        sender_user_name: 'Forwarded Message',
      };
    }
  }

  // 11. Reply metadata
  let replyToMessage: TelegramIncomingMessage | undefined;
  const replyHeader =
    rawMsg.replyTo && typeof rawMsg.replyTo === 'object'
      ? (rawMsg.replyTo as Record<string, unknown>)
      : rawMsg.reply_to && typeof rawMsg.reply_to === 'object'
        ? (rawMsg.reply_to as Record<string, unknown>)
        : undefined;

  const replyMsgId =
    replyHeader?.replyToMsgId ??
    replyHeader?.reply_to_msg_id ??
    rawMsg.replyToMsgId ??
    rawMsg.reply_to_msg_id;

  if (replyMsgId !== undefined && replyMsgId !== null) {
    const replyFwd =
      replyHeader?.replyFrom && typeof replyHeader.replyFrom === 'object'
        ? (replyHeader.replyFrom as Record<string, unknown>)
        : replyHeader?.reply_from && typeof replyHeader.reply_from === 'object'
          ? (replyHeader.reply_from as Record<string, unknown>)
          : undefined;

    const replyFromPeer =
      replyHeader?.fromId ??
      replyHeader?.from_id ??
      replyFwd?.fromId ??
      replyFwd?.from_id ??
      replyHeader?.replyToPeerId ??
      replyHeader?.reply_to_peer_id ??
      replyHeader?.replyToUserId ??
      replyHeader?.reply_to_user_id ??
      rawMsg.replyToUserId ??
      rawMsg.reply_to_user_id;

    const replyFrom = resolveUserFromPeer(replyFromPeer, payload);

    let replyForwardOrigin: TelegramMessageOrigin | undefined;
    let replyForwardDate: number | undefined;

    if (replyFwd) {
      replyForwardDate = typeof replyFwd.date === 'number' ? replyFwd.date : 0;
      const rfFromId = replyFwd.fromId ?? replyFwd.from_id;
      const rfUser = resolveUserFromPeer(rfFromId, payload);
      const rfName =
        typeof replyFwd.fromName === 'string'
          ? replyFwd.fromName
          : typeof replyFwd.from_name === 'string'
            ? replyFwd.from_name
            : undefined;

      if (rfUser) {
        replyForwardOrigin = {
          type: 'user',
          date: replyForwardDate,
          sender_user: rfUser,
        };
      } else if (rfName && rfName.trim().length > 0) {
        replyForwardOrigin = {
          type: 'hidden_user',
          date: replyForwardDate,
          sender_user_name: rfName,
        };
      } else {
        replyForwardOrigin = {
          type: 'hidden_user',
          date: replyForwardDate,
          sender_user_name: 'Forwarded Message',
        };
      }
    }

    replyToMessage = {
      message_id: Number(replyMsgId),
      date: 0,
      chat,
      ...(replyFrom ? { from: replyFrom } : {}),
      ...(replyForwardOrigin ? { forward_origin: replyForwardOrigin } : {}),
      ...(replyForwardDate !== undefined ? { forward_date: replyForwardDate } : {}),
    };
  }

  // 12. Entities, Media & Text/Caption
  const mappedEntities = normalizeEntities(rawMsg.entities);
  const rawText = typeof rawMsg.message === 'string' ? rawMsg.message : '';
  const rawEditDate = rawMsg.edit_date ?? rawMsg.editDate;
  const editDate = typeof rawEditDate === 'number' && Number.isFinite(rawEditDate) ? rawEditDate : undefined;

  const normalizedMessage: TelegramIncomingMessage = {
    message_id: Number.isFinite(messageIdNum) ? messageIdNum : messageIdStr,
    date: unixSeconds,
    chat,
    ...(from ? { from } : {}),
    ...(senderChat ? { sender_chat: senderChat } : {}),
    ...(forwardOrigin ? { forward_origin: forwardOrigin } : {}),
    ...(forwardDate !== undefined ? { forward_date: forwardDate } : {}),
    ...(forwardFrom ? { forward_from: forwardFrom } : {}),
    ...(forwardFromChat ? { forward_from_chat: forwardFromChat } : {}),
    ...(forwardFromMessageId !== undefined ? { forward_from_message_id: forwardFromMessageId } : {}),
    ...(forwardSenderName ? { forward_sender_name: forwardSenderName } : {}),
    ...(replyToMessage ? { reply_to_message: replyToMessage } : {}),
    ...(editDate !== undefined ? { edit_date: editDate } : {}),
  };

  const media = rawMsg.media as Record<string, unknown> | undefined;
  const mediaType = getTypeName(media);

  if (media && mediaType !== 'MessageMediaEmpty' && mediaType !== 'MessageMediaWebPage') {
    if (mediaType === 'MessageMediaPhoto' || media.photo !== undefined) {
      const photoObj = media.photo as Record<string, unknown> | undefined;
      if (!photoObj || photoObj.id === undefined || photoObj.id === null) {
        return {
          status: 'DROPPED',
          reason: 'MALFORMED_UPDATE',
          rawPayload: update,
        };
      }
      const photoId = cleanIdString(photoObj.id);
      if (!photoId) {
        return {
          status: 'DROPPED',
          reason: 'MALFORMED_UPDATE',
          rawPayload: update,
        };
      }

      const photoSizes: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[] = [];
      if (Array.isArray(photoObj.sizes)) {
        for (const s of photoObj.sizes) {
          if (s && typeof s === 'object') {
            const sObj = s as Record<string, unknown>;
            const w = Number(sObj.w ?? sObj.width ?? 0);
            const h = Number(sObj.h ?? sObj.height ?? 0);
            if (w > 0 && h > 0) {
              photoSizes.push({
                file_id: photoId,
                file_unique_id: photoId,
                width: w,
                height: h,
                ...(typeof sObj.size === 'number' ? { file_size: sObj.size } : {}),
              });
            }
          }
        }
      }

      if (photoSizes.length === 0) {
        const w = Number(photoObj.w ?? photoObj.width ?? 0);
        const h = Number(photoObj.h ?? photoObj.height ?? 0);
        photoSizes.push({
          file_id: photoId,
          file_unique_id: photoId,
          width: w,
          height: h,
        });
      }

      normalizedMessage.photo = photoSizes;
      if (rawText) {
        normalizedMessage.caption = rawText;
      }
      if (mappedEntities.length > 0) {
        normalizedMessage.caption_entities = mappedEntities;
      }
    } else if (mediaType === 'MessageMediaDocument' || media.document !== undefined) {
      const doc = media.document as Record<string, unknown> | undefined;
      if (!doc || doc.id === undefined || doc.id === null) {
        return {
          status: 'DROPPED',
          reason: 'MALFORMED_UPDATE',
          rawPayload: update,
        };
      }
      const docId = cleanIdString(doc.id);
      if (!docId) {
        return {
          status: 'DROPPED',
          reason: 'MALFORMED_UPDATE',
          rawPayload: update,
        };
      }

      const attrs = Array.isArray(doc.attributes) ? (doc.attributes as Record<string, unknown>[]) : [];
      const isVoice = attrs.some((a) => (getTypeName(a) === 'DocumentAttributeAudio' || a._ === 'DocumentAttributeAudio') && a.voice === true);
      const isAudio = !isVoice && attrs.some((a) => getTypeName(a) === 'DocumentAttributeAudio' || a._ === 'DocumentAttributeAudio');
      const isVideo = attrs.some((a) => getTypeName(a) === 'DocumentAttributeVideo' || a._ === 'DocumentAttributeVideo');
      const isRoundVideo = isVideo && attrs.some((a) => a.roundMessage === true);
      const isAnimation = attrs.some((a) => getTypeName(a) === 'DocumentAttributeAnimated' || a._ === 'DocumentAttributeAnimated');
      const isSticker = attrs.some((a) => getTypeName(a) === 'DocumentAttributeSticker' || a._ === 'DocumentAttributeSticker');

      if (isSticker) {
        // Stickers are out of scope - do not map as document or sticker; preserve text if any
        if (rawText) {
          normalizedMessage.text = rawText;
          if (mappedEntities.length > 0) normalizedMessage.entities = mappedEntities;
        }
      } else if (isRoundVideo) {
        normalizedMessage.video_note = { file_id: docId };
      } else if (isVoice) {
        normalizedMessage.voice = { file_id: docId };
        if (rawText) normalizedMessage.caption = rawText;
        if (mappedEntities.length > 0) normalizedMessage.caption_entities = mappedEntities;
      } else if (isAudio) {
        normalizedMessage.audio = { file_id: docId };
        if (rawText) normalizedMessage.caption = rawText;
        if (mappedEntities.length > 0) normalizedMessage.caption_entities = mappedEntities;
      } else if (isVideo) {
        normalizedMessage.video = { file_id: docId };
        if (rawText) normalizedMessage.caption = rawText;
        if (mappedEntities.length > 0) normalizedMessage.caption_entities = mappedEntities;
      } else if (isAnimation) {
        normalizedMessage.animation = { file_id: docId };
        if (rawText) normalizedMessage.caption = rawText;
        if (mappedEntities.length > 0) normalizedMessage.caption_entities = mappedEntities;
      } else {
        normalizedMessage.document = {
          file_id: docId,
          ...(typeof doc.mimeType === 'string' ? { mime_type: doc.mimeType } : {}),
        };
        if (rawText) normalizedMessage.caption = rawText;
        if (mappedEntities.length > 0) normalizedMessage.caption_entities = mappedEntities;
      }
    } else {
      // Out of scope media (poll, dice, geo, etc.) - do not fabricate fake IDs; preserve text if any
      if (rawText) {
        normalizedMessage.text = rawText;
        if (mappedEntities.length > 0) {
          normalizedMessage.entities = mappedEntities;
        }
      }
    }
  } else {
    // Plain text message
    if (rawText) {
      normalizedMessage.text = rawText;
      if (mappedEntities.length > 0) {
        normalizedMessage.entities = mappedEntities;
      }
    }
  }

  const envelope: CanonicalIngestEnvelope = {
    transport: 'USERBOT',
    chatId: chatInfo.chatIdStr,
    messageId: messageIdStr,
    originalTimestamp,
    calendarDay,
    normalizedMessage,
    rawPayload: update,
  };

  return {
    status: 'NORMALIZED',
    envelope,
  };
}
