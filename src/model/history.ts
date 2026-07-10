import type { InboundMessage } from "./message.ts";
import type { GroupParticipant } from "./group.ts";

export interface HistoryChat {
  readonly id: string;
  readonly subject?: string;
  readonly isGroup: boolean;
  readonly lastMessageAt?: number;
  readonly participants?: readonly GroupParticipant[];
}

export interface HistoryContact {
  readonly id: string;
  readonly displayName?: string;
}

export interface ConversationSyncBatch {
  readonly chats: readonly HistoryChat[];
  readonly contacts: readonly HistoryContact[];
  readonly self?: HistoryContact;
  readonly messages: readonly InboundMessage[];
}

export type ConversationSyncChat = HistoryChat;
export type ConversationSyncContact = HistoryContact;
export type HistoryBatch = ConversationSyncBatch;
