import type { PresenceKind } from "../model/presence.ts";
import type { Unsubscribe } from "../subscription.ts";
import type { ChatRecord, ContactRecord, GroupRecord } from "./contracts.ts";
import type { ClientAccountState, ClientChatMessages } from "./client.ts";
import type { ClientMessageActions, ClientOperations } from "./client-operations.ts";

/** Options every Client subscription accepts. */
export interface ClientSubscribeOptions {
  readonly signal?: AbortSignal;
}

/** Observe one namespace after each fully committed transition that changed it. */
export interface ClientNamespace {
  subscribe(listener: () => void, options?: ClientSubscribeOptions): Unsubscribe;
}

/** One account's synchronized application state. */
export interface WhatsAppClient {
  readonly account: ClientNamespace & { get(): ClientAccountState };
  readonly chats: ClientNamespace & { list(): readonly ChatRecord[] };
  readonly contacts: ClientNamespace & {
    list(): readonly ContactRecord[];
    resolve(nativeId: string): ContactRecord | undefined;
    presence(nativeId: string): PresenceKind | undefined;
  };
  readonly groups: ClientNamespace & { list(): readonly GroupRecord[] };
  readonly messages: ClientNamespace &
    ClientMessageActions & {
      get(chatId: string): ClientChatMessages;
      older(chatId: string): void;
    };
  readonly operations: ClientOperations;
  /** Release subscriptions and stop following without closing the Runtime or Backend. */
  close(): Promise<void>;
}
