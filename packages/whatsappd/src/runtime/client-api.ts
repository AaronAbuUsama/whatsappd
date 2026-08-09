import type { PresenceKind } from "../model/presence.ts";
import type {
  GroupMetadata,
  GroupParticipantAction,
  GroupParticipantUpdateResult,
  GroupSetting,
} from "../model/group.ts";
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
  readonly groups: ClientNamespace & {
    list(): readonly GroupRecord[];
    metadata(chatId: string): Promise<GroupMetadata>;
    create(subject: string, participants: readonly string[]): Promise<GroupMetadata>;
    leave(chatId: string): Promise<void>;
    updateSubject(chatId: string, subject: string): Promise<void>;
    updateDescription(chatId: string, description?: string): Promise<void>;
    updateParticipants(
      chatId: string,
      participants: readonly string[],
      action: GroupParticipantAction,
    ): Promise<readonly GroupParticipantUpdateResult[]>;
    updateSetting(chatId: string, setting: GroupSetting): Promise<void>;
    inviteCode(chatId: string): Promise<string | undefined>;
    revokeInvite(chatId: string): Promise<string | undefined>;
    updatePicture(chatId: string, image: Uint8Array): Promise<void>;
    removePicture(chatId: string): Promise<void>;
  };
  readonly messages: ClientNamespace &
    ClientMessageActions & {
      get(chatId: string): ClientChatMessages;
      older(chatId: string): void;
    };
  readonly operations: ClientOperations;
  /** Release subscriptions and stop following without closing the Runtime or Backend. */
  close(): Promise<void>;
}
