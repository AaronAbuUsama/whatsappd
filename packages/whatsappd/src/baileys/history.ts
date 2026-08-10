import { isJidGroup, proto, type BaileysEventMap, type WAMessage } from "baileys";
import type {
  ConversationSyncBatch,
  HistoryChat,
  HistoryContact,
  InboundMessage,
  WhatsAppAddress,
} from "../model/index.ts";
import { isContactNativeId } from "../model/contact.ts";
import { contactNativeIds } from "./contacts.ts";
import { noDownloader, type DownloadThunk } from "./download.ts";
import { toInbound } from "./inbound.ts";

type HistoryPayload = BaileysEventMap["messaging-history.set"];
type ConversationSyncPayload = Pick<HistoryPayload, "chats" | "contacts" | "messages"> &
  Partial<
    Pick<
      HistoryPayload,
      "syncType" | "isLatest" | "chunkOrder" | "progress" | "peerDataRequestSessionId"
    >
  >;
type NumericLike = number | { toNumber(): number } | null | undefined;
type HistoryChatParticipant = {
  readonly id?: string | null;
  readonly admin?: string | null;
};

type HistoryChatWithParticipants = HistoryPayload["chats"][number] & {
  readonly participants?: readonly HistoryChatParticipant[] | null;
};

function num(v: NumericLike): number | undefined {
  if (v == null) return undefined;
  return typeof v === "number" ? v : v.toNumber();
}

function secondsToMillis(v: NumericLike): number | undefined {
  const seconds = num(v);
  return seconds == null ? undefined : seconds * 1000;
}

function firstText(...values: (string | null | undefined)[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.length > 0);
}

function toHistoryParticipants(
  participants: readonly HistoryChatParticipant[] | null | undefined,
): HistoryChat["participants"] | undefined {
  if (!participants) return undefined;
  const out: { id: string; role?: string }[] = [];
  for (const participant of participants) {
    if (!participant.id) continue;
    out.push({
      id: participant.id,
      ...(participant.admin ? { role: participant.admin } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function toHistoryChat(chat: HistoryPayload["chats"][number]): HistoryChat | undefined {
  if (!chat.id) return undefined;
  const subject = firstText(chat.name, chat.displayName);
  const lastMessageAt = secondsToMillis(
    chat.lastMsgTimestamp ?? chat.lastMessageRecvTimestamp ?? chat.conversationTimestamp,
  );
  const participants = toHistoryParticipants((chat as HistoryChatWithParticipants).participants);
  return {
    id: chat.id,
    ...(subject && { subject }),
    isGroup: isJidGroup(chat.id) ?? false,
    ...(lastMessageAt != null && { lastMessageAt }),
    ...(participants ? { participants } : {}),
  };
}

function toHistoryContact(contact: HistoryPayload["contacts"][number]): HistoryContact | undefined {
  const nativeIds = contactNativeIds(contact);
  const id = nativeIds[0];
  if (!id || !nativeIds.every(isContactNativeId)) return undefined;
  const displayName = firstText(
    contact.name,
    contact.notify,
    contact.verifiedName,
    contact.username,
  );
  return {
    id,
    nativeIds,
    ...(displayName && { displayName }),
  };
}

export function toConversationSyncBatch(
  payload: ConversationSyncPayload,
  self: WhatsAppAddress,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): ConversationSyncBatch {
  const chats = payload.chats.flatMap((chat) => {
    const mapped = toHistoryChat(chat);
    return mapped ? [mapped] : [];
  });
  const contacts = payload.contacts.flatMap((contact) => {
    const mapped = toHistoryContact(contact);
    return mapped ? [mapped] : [];
  });
  const messages = toConversationSyncMessages(payload.messages, self, makeDownload);
  const source = (() => {
    switch (payload.syncType) {
      case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
        return "initial_bootstrap";
      case proto.HistorySync.HistorySyncType.RECENT:
        return "recent";
      case proto.HistorySync.HistorySyncType.ON_DEMAND:
        return "on_demand";
      case proto.HistorySync.HistorySyncType.FULL:
        return "full";
      default:
        return "unknown";
    }
  })();
  const requestSessionId =
    typeof payload.peerDataRequestSessionId === "string"
      ? payload.peerDataRequestSessionId
      : undefined;
  return {
    context: {
      source,
      ...(payload.isLatest != null && { isLatest: payload.isLatest }),
      ...(payload.chunkOrder != null && { chunkOrder: payload.chunkOrder }),
      ...(payload.progress != null && { progress: payload.progress }),
      ...(requestSessionId !== undefined && { requestSessionId }),
      projection: { mode: "upsert" },
    },
    chats,
    contacts,
    messages,
  };
}

function toConversationSyncMessages(
  messages: readonly WAMessage[],
  self: WhatsAppAddress,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): InboundMessage[] {
  return messages.flatMap((raw) => {
    const msg = toInbound(raw, false, self, makeDownload);
    return msg ? [msg] : [];
  });
}
