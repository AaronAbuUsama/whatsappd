import type { MessageRef } from "../model/outbound.ts";
import type { PresenceKind } from "../model/presence.ts";
import type { Status, WaIdentity } from "../model/status.ts";
import type { Unsubscribe } from "../subscription.ts";
import type { ChatRecord, ContactRecord, GroupRecord, MessageRecord } from "./contracts.ts";
import type {
  ClientOperationOptions,
  ClientPhoneHistoryRequest,
  ClientSendOptions,
} from "./client-operations.ts";
import type { ClientPairInput, PairingOperation, WhatsAppLinkState } from "./lifecycle.ts";
import type { MediaOutbound, WhatsAppOperation } from "./operations.ts";

/** One chat's retained saved/live messages and local-mirror paging state. */
export interface ClientChatMessages {
  readonly chatId: string;
  readonly messages: readonly MessageRecord[];
  readonly older: "stored" | "loading" | "exhausted";
  readonly error?: unknown;
}

/** One account's durable facts, safe link state, and current live observations. */
export interface ClientAccountState {
  readonly accountId: string;
  readonly link?: WhatsAppLinkState;
  readonly lastConnectedAt?: number;
  readonly lastDisconnectedAt?: number;
  readonly connection?: Status;
  readonly identity?: WaIdentity;
  readonly closed: boolean;
  readonly error?: unknown;
}

export interface ClientSubscribeOptions {
  readonly signal?: AbortSignal;
}

/** One synchronized Client namespace and its post-commit notifications. */
export interface ClientNamespace {
  subscribe(listener: () => void, options?: ClientSubscribeOptions): Unsubscribe;
}

/** One account's synchronized application state and durable action surface. */
export interface WhatsAppClient {
  readonly account: ClientNamespace & {
    get(): ClientAccountState;
    pair(input: ClientPairInput, options?: ClientOperationOptions): Promise<PairingOperation>;
    unlink(options?: ClientOperationOptions): Promise<WhatsAppOperation>;
  };
  readonly chats: ClientNamespace & { list(): readonly ChatRecord[] };
  readonly contacts: ClientNamespace & {
    list(): readonly ContactRecord[];
    resolve(nativeId: string): ContactRecord | undefined;
    presence(nativeId: string): PresenceKind | undefined;
  };
  readonly groups: ClientNamespace & { list(): readonly GroupRecord[] };
  readonly operations: {
    get(operationId: string): Promise<WhatsAppOperation | undefined>;
    get(operationIds: readonly string[]): Promise<readonly (WhatsAppOperation | undefined)[]>;
    subscribe(
      operationId: string,
      listener: (operation: WhatsAppOperation) => void,
      options?: ClientSubscribeOptions,
    ): Unsubscribe;
  };
  readonly messages: ClientNamespace & {
    readonly send: {
      text(chatId: string, text: string, options?: ClientSendOptions): Promise<WhatsAppOperation>;
      media(
        chatId: string,
        content: MediaOutbound,
        options?: ClientSendOptions,
      ): Promise<WhatsAppOperation>;
    };
    markRead(
      refs: readonly MessageRef[],
      options?: ClientOperationOptions,
    ): Promise<WhatsAppOperation>;
    setTyping(
      chatId: string,
      on: boolean,
      options?: ClientOperationOptions,
    ): Promise<WhatsAppOperation>;
    requestPhoneHistory(
      chatId: string,
      request: ClientPhoneHistoryRequest,
      options?: ClientOperationOptions,
    ): Promise<WhatsAppOperation>;
    get(chatId: string): ClientChatMessages;
    older(chatId: string): void;
  };
  /** Release only this Client's subscriptions and in-flight stored-page reads. */
  close(): Promise<void>;
}
