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

export type ConversationSyncSource =
  | "initial_bootstrap"
  | "recent"
  | "on_demand"
  | "full"
  | "unknown";

export interface ConversationSyncContext {
  readonly source: ConversationSyncSource;
  readonly isLatest?: boolean;
  readonly chunkOrder?: number;
  readonly progress?: number;
  readonly requestSessionId?: string;
  readonly projection:
    | { readonly mode: "upsert" }
    | {
        readonly mode: "authoritative_replacement";
        readonly scope: "account" | { readonly chatId: string };
      };
}

export interface ConversationSyncBatch {
  readonly context: ConversationSyncContext;
  readonly chats: readonly HistoryChat[];
  readonly contacts: readonly HistoryContact[];
  readonly self?: HistoryContact;
  readonly messages: readonly InboundMessage[];
}
