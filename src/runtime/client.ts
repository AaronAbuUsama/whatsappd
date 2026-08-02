import { isDeepStrictEqual } from "node:util";

import type { PresenceUpdate } from "../model/index.ts";
import type { Unsubscribe } from "../subscription.ts";
import { WhatsAppClientClosedError } from "./contracts.ts";
import type {
  AccountRecord,
  ChatRecord,
  ContactRecord,
  GroupRecord,
  MessageRecord,
  StoredMessageCursor,
  SubscriptionOptions,
  WhatsAppAccountState,
  WhatsAppClient,
  WhatsAppClientFrame,
  WhatsAppConversation,
  WhatsAppConversationState,
  WhatsAppPatch,
  WhatsAppSnapshot,
} from "./contracts.ts";
import { getWhatsAppClientSource, type WhatsAppRuntime } from "./runtime.ts";

const chatOrder = (left: ChatRecord, right: ChatRecord): number =>
  right.lastMessageAt - left.lastMessageAt || left.chatId.localeCompare(right.chatId);
const byContactId = (left: ContactRecord, right: ContactRecord): number =>
  left.contactId.localeCompare(right.contactId);
const byGroupId = (left: GroupRecord, right: GroupRecord): number =>
  left.groupId.localeCompare(right.groupId);
const messageOrder = (left: MessageRecord, right: MessageRecord): number =>
  right.timestamp - left.timestamp || right.messageId.localeCompare(left.messageId);

interface OpenConversation {
  readonly public: WhatsAppConversation;
  hydrate(): Promise<void>;
  loadOlder(): Promise<void>;
  replaceWindow(): Promise<void>;
  receive(message: MessageRecord): void;
  receivePresence(presence: PresenceUpdate, expiresAt: number): void;
  refreshChat(): void;
  close(): void;
}

export async function createWhatsAppClient(runtime: WhatsAppRuntime): Promise<WhatsAppClient> {
  const source = getWhatsAppClientSource(runtime);
  const chats = new Map<string, ChatRecord>();
  const contacts = new Map<string, ContactRecord>();
  const aliases = new Map<string, string>();
  const groups = new Map<string, GroupRecord>();
  const accountListeners = new Set<(value: WhatsAppAccountState) => void>();
  const chatListeners = new Set<(value: readonly ChatRecord[]) => void>();
  const contactListeners = new Set<(value: readonly ContactRecord[]) => void>();
  const groupListeners = new Set<(value: readonly GroupRecord[]) => void>();
  const conversations = new Set<OpenConversation>();
  const queued: WhatsAppClientFrame[] = [];
  let revision = -1;
  let account: AccountRecord;
  let accountState: WhatsAppAccountState;
  let publishedChats: readonly ChatRecord[] = [];
  let publishedContacts: readonly ContactRecord[] = [];
  let publishedGroups: readonly GroupRecord[] = [];
  let hydrating = true;
  let closed = false;
  let recovering: Promise<void> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;

  const requireClient = (): void => {
    if (closed) throw new WhatsAppClientClosedError("Client");
  };

  const notify = <Value>(listeners: Set<(value: Value) => void>, value: Value): void => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const replace = (snapshot: WhatsAppSnapshot, publishChanges = false): void => {
    const previousAccount = accountState;
    const previousChats = publishedChats;
    const previousContacts = publishedContacts;
    const previousGroups = publishedGroups;
    account = snapshot.account;
    const identity = source.identity();
    accountState = {
      record: account,
      ...(previousAccount?.connection && previousAccount.connection.expiresAt > Date.now()
        ? { connection: previousAccount.connection }
        : {}),
      ...(identity && { identity }),
    };
    chats.clear();
    for (const chat of snapshot.chats) chats.set(chat.chatId, chat);
    contacts.clear();
    for (const contact of snapshot.contacts) contacts.set(contact.contactId, contact);
    aliases.clear();
    for (const [nativeId, contactId] of Object.entries(snapshot.contactAliases))
      aliases.set(nativeId, contactId);
    groups.clear();
    for (const group of snapshot.groups) groups.set(group.groupId, group);
    publishedChats = [...chats.values()].sort(chatOrder);
    publishedContacts = [...contacts.values()].sort(byContactId);
    publishedGroups = [...groups.values()].sort(byGroupId);
    revision = snapshot.revision;
    if (!publishChanges) return;
    if (!isDeepStrictEqual(previousAccount, accountState)) notify(accountListeners, accountState);
    if (!isDeepStrictEqual(previousChats, publishedChats)) {
      notify(chatListeners, publishedChats);
    }
    if (!isDeepStrictEqual(previousContacts, publishedContacts))
      notify(contactListeners, publishedContacts);
    if (!isDeepStrictEqual(previousGroups, publishedGroups))
      notify(groupListeners, publishedGroups);
  };

  const rebuildAliases = (): void => {
    aliases.clear();
    for (const contact of contacts.values())
      for (const nativeId of contact.nativeIds) aliases.set(nativeId, contact.contactId);
  };

  const apply = (patch: WhatsAppPatch): void => {
    if (patch.revision <= revision || patch.fromRevision !== revision) return;
    let accountChanged = false;
    let chatsChanged = false;
    let contactsChanged = false;
    let groupsChanged = false;
    for (const record of patch.upserts) {
      switch (record.type) {
        case "account":
          account = record.account;
          accountState = { ...accountState, record: account };
          accountChanged = true;
          break;
        case "chat":
          chats.set(record.chat.chatId, record.chat);
          chatsChanged = true;
          break;
        case "contact":
          contacts.set(record.contact.contactId, record.contact);
          contactsChanged = true;
          break;
        case "group":
          groups.set(record.group.groupId, record.group);
          groupsChanged = true;
          break;
        case "message":
          for (const conversation of conversations)
            if (conversation.public.chatId === record.message.chatId)
              conversation.receive(record.message);
          break;
      }
    }
    for (const deletion of patch.deletes ?? []) {
      contacts.delete(deletion.contactId);
      contactsChanged = true;
    }
    revision = patch.revision;
    if (accountChanged) notify(accountListeners, accountState);
    if (chatsChanged) {
      publishedChats = [...chats.values()].sort(chatOrder);
      notify(chatListeners, publishedChats);
      for (const conversation of conversations) conversation.refreshChat();
    }
    if (contactsChanged) {
      rebuildAliases();
      publishedContacts = [...contacts.values()].sort(byContactId);
      notify(contactListeners, publishedContacts);
    }
    if (groupsChanged) {
      publishedGroups = [...groups.values()].sort(byGroupId);
      notify(groupListeners, publishedGroups);
    }
  };

  const consume = (frame: WhatsAppClientFrame): void => {
    if (closed) return;
    if (hydrating || recovering) {
      queued.push(frame);
      return;
    }
    if (frame.type === "connection") {
      if (connectionTimer) clearTimeout(connectionTimer);
      const identity = source.identity();
      accountState = {
        ...accountState,
        connection: frame.state,
        ...(identity ? { identity } : {}),
      };
      notify(accountListeners, accountState);
      const observed = frame.state;
      connectionTimer = setTimeout(
        () => {
          if (closed || accountState.connection !== observed) return;
          const currentIdentity = source.identity();
          accountState = {
            record: account,
            ...(currentIdentity && { identity: currentIdentity }),
          };
          notify(accountListeners, accountState);
        },
        Math.max(0, observed.expiresAt - Date.now()),
      );
      connectionTimer.unref?.();
      return;
    }
    if (frame.type === "presence") {
      for (const conversation of conversations)
        if (conversation.public.chatId === frame.presence.chatId)
          conversation.receivePresence(frame.presence, frame.expiresAt);
      return;
    }
    if (frame.type === "closed") {
      if (connectionTimer) clearTimeout(connectionTimer);
      accountState = {
        record: account,
        closed: "error" in frame ? { error: frame.error } : {},
      };
      notify(accountListeners, accountState);
      return;
    }
    if (frame.type !== "patch") return;
    if (frame.patch.revision <= revision) return;
    if (frame.patch.fromRevision === revision) {
      apply(frame.patch);
      return;
    }
    let task!: Promise<void>;
    task = (async () => {
      try {
        replace(await source.snapshot(), true);
        await Promise.all([...conversations].map((conversation) => conversation.replaceWindow()));
      } finally {
        if (recovering === task) recovering = undefined;
        if (!closed) for (const queuedFrame of queued.splice(0)) consume(queuedFrame);
      }
    })();
    recovering = task;
    void task.catch(() => {});
  };

  const off = source.onFrame(consume);
  try {
    replace(await source.snapshot());
    hydrating = false;
    for (const frame of queued.splice(0)) consume(frame);
  } catch (error) {
    off();
    throw error;
  }

  const subscribe = <Value>(
    listeners: Set<(value: Value) => void>,
    listener: (value: Value) => void,
    options?: SubscriptionOptions,
  ): Unsubscribe => {
    listeners.add(listener);
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      options?.signal?.removeEventListener("abort", unsubscribe);
    };
    if (options?.signal?.aborted) unsubscribe();
    else options?.signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  };

  const open = async (
    chatId: string,
    options?: { readonly pageSize?: number },
  ): Promise<WhatsAppConversation> => {
    requireClient();
    const pageSize = options?.pageSize ?? 25;
    if (!Number.isInteger(pageSize) || pageSize < 1)
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);

    const messages = new Map<string, MessageRecord>();
    const presences = new Map<
      string,
      { readonly value: PresenceUpdate; readonly timer: ReturnType<typeof setTimeout> }
    >();
    const conversationListeners = new Set<(value: WhatsAppConversationState) => void>();
    let cursor: StoredMessageCursor | undefined;
    let pageRead: Promise<void> | undefined;
    let replacementRead: Promise<void> | undefined;
    let conversationClosed = false;
    let rejectClosed!: (error: WhatsAppClientClosedError) => void;
    const closedConversation = new Promise<never>((_, reject) => {
      rejectClosed = reject;
    });
    void closedConversation.catch(() => {});
    let state: WhatsAppConversationState = {
      chatId,
      ...(chats.get(chatId) && { chat: chats.get(chatId) }),
      messages: [],
      presence: [],
      loadingOlder: true,
      hasOlderSaved: false,
    };
    const publish = (next: Partial<WhatsAppConversationState> = {}): void => {
      const previous = state;
      state = {
        ...state,
        ...next,
        messages: [...messages.values()].sort(messageOrder),
        presence: [...presences.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, entry]) => entry.value),
      };
      if (!isDeepStrictEqual(previous, state)) notify(conversationListeners, state);
    };
    const requireConversation = (): void => {
      if (conversationClosed) throw new WhatsAppClientClosedError("conversation");
    };
    const internal: OpenConversation = {
      public: {
        chatId,
        get: () => {
          requireConversation();
          return state;
        },
        subscribe: (listener, subscriptionOptions) => {
          requireConversation();
          return subscribe(conversationListeners, listener, subscriptionOptions);
        },
        loadOlder: () => internal.loadOlder(),
        close: () => internal.close(),
      },
      hydrate() {
        let task!: Promise<void>;
        task = (async () => {
          try {
            const page = await Promise.race([
              source.messages(chatId, { limit: pageSize }),
              closedConversation,
            ]);
            for (const message of page.messages)
              if (!messages.has(message.messageId)) messages.set(message.messageId, message);
            cursor = page.nextBefore;
            publish({ loadingOlder: false, hasOlderSaved: cursor !== undefined });
          } finally {
            if (pageRead === task) pageRead = undefined;
          }
        })();
        pageRead = task;
        return task;
      },
      loadOlder() {
        if (conversationClosed)
          return Promise.reject(new WhatsAppClientClosedError("conversation"));
        if (replacementRead) return replacementRead;
        if (pageRead) return pageRead;
        if (!cursor) return Promise.resolve();
        const before = cursor;
        publish({ loadingOlder: true, error: undefined });
        let task!: Promise<void>;
        task = (async () => {
          try {
            const page = await Promise.race([
              source.messages(chatId, { limit: pageSize, before }),
              closedConversation,
            ]);
            if (conversationClosed) return;
            for (const message of page.messages)
              if (!messages.has(message.messageId)) messages.set(message.messageId, message);
            cursor = page.nextBefore;
            publish({ loadingOlder: false, hasOlderSaved: cursor !== undefined, error: undefined });
          } catch (error) {
            if (!conversationClosed) publish({ loadingOlder: false, error });
            throw error;
          } finally {
            if (pageRead === task) pageRead = undefined;
          }
        })();
        pageRead = task;
        return task;
      },
      replaceWindow() {
        if (replacementRead) return replacementRead;
        let task!: Promise<void>;
        task = (async () => {
          try {
            const pending = pageRead;
            if (pending)
              try {
                await pending;
              } catch {
                if (conversationClosed) return;
              }
            if (conversationClosed) return;
            let page;
            try {
              page = await Promise.race([
                source.messages(chatId, { limit: Math.max(pageSize, messages.size) }),
                closedConversation,
              ]);
            } catch (error) {
              if (conversationClosed) return;
              throw error;
            }
            if (conversationClosed) return;
            messages.clear();
            for (const message of page.messages) messages.set(message.messageId, message);
            cursor = page.nextBefore;
            publish({
              chat: chats.get(chatId),
              loadingOlder: false,
              hasOlderSaved: cursor !== undefined,
              error: undefined,
            });
          } finally {
            if (replacementRead === task) replacementRead = undefined;
          }
        })();
        replacementRead = task;
        return task;
      },
      receive(message) {
        if (conversationClosed) return;
        messages.set(message.messageId, message);
        publish();
      },
      receivePresence(presence, expiresAt) {
        if (conversationClosed) return;
        const subject = presence.participant ?? presence.chatId;
        const previous = presences.get(subject);
        if (previous) clearTimeout(previous.timer);
        if (presence.kind === "unavailable" || expiresAt <= Date.now()) {
          if (previous) {
            presences.delete(subject);
            publish();
          }
          return;
        }
        const timer = setTimeout(() => {
          if (conversationClosed || presences.get(subject)?.timer !== timer) return;
          presences.delete(subject);
          publish();
        }, expiresAt - Date.now());
        timer.unref?.();
        presences.set(subject, { value: presence, timer });
        publish();
      },
      refreshChat() {
        if (conversationClosed) return;
        publish({ chat: chats.get(chatId) });
      },
      close() {
        if (conversationClosed) return;
        conversationClosed = true;
        rejectClosed(new WhatsAppClientClosedError("conversation"));
        for (const presence of presences.values()) clearTimeout(presence.timer);
        presences.clear();
        conversationListeners.clear();
        conversations.delete(internal);
      },
    };
    // Registered before storage is read so a live upsert cannot fall between
    // opening the conversation and its first coherent saved/live state.
    conversations.add(internal);
    try {
      await internal.hydrate();
      while (recovering) await recovering;
      requireConversation();
      return internal.public;
    } catch (error) {
      internal.close();
      throw error;
    }
  };

  return {
    account: {
      get: () => {
        requireClient();
        return accountState;
      },
      subscribe: (listener, options) => {
        requireClient();
        return subscribe(accountListeners, listener, options);
      },
    },
    chats: {
      list: () => {
        requireClient();
        return publishedChats;
      },
      get: (chatId) => {
        requireClient();
        return chats.get(chatId);
      },
      subscribe: (listener, options) => {
        requireClient();
        return subscribe(chatListeners, listener, options);
      },
      open,
    },
    contacts: {
      list: () => {
        requireClient();
        return publishedContacts;
      },
      get: (contactId) => {
        requireClient();
        return contacts.get(contactId);
      },
      resolve: (nativeId) => {
        requireClient();
        return contacts.get(aliases.get(nativeId) ?? nativeId);
      },
      subscribe: (listener, options) => {
        requireClient();
        return subscribe(contactListeners, listener, options);
      },
    },
    groups: {
      list: () => {
        requireClient();
        return publishedGroups;
      },
      get: (groupId) => {
        requireClient();
        return groups.get(groupId);
      },
      subscribe: (listener, options) => {
        requireClient();
        return subscribe(groupListeners, listener, options);
      },
    },
    async close() {
      if (closed) return;
      closed = true;
      off();
      if (connectionTimer) clearTimeout(connectionTimer);
      for (const conversation of conversations) conversation.close();
      accountListeners.clear();
      chatListeners.clear();
      contactListeners.clear();
      groupListeners.clear();
    },
  };
}
