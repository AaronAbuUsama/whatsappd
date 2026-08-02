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
  StoredMessagePage,
  SubscriptionOptions,
  WhatsAppAccountState,
  WhatsAppBackendResource,
  WhatsAppClient,
  WhatsAppClientFrame,
  WhatsAppConversation,
  WhatsAppConversationState,
  WhatsAppPatch,
  WhatsAppSnapshot,
} from "./contracts.ts";
import {
  createWhatsAppRuntime,
  getWhatsAppClientSource,
  type WhatsAppRuntime,
  type WhatsAppRuntimeConfig,
} from "./runtime.ts";

const compareId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const chatOrder = (left: ChatRecord, right: ChatRecord): number =>
  right.lastMessageAt - left.lastMessageAt || compareId(left.chatId, right.chatId);
const byContactId = (left: ContactRecord, right: ContactRecord): number =>
  compareId(left.contactId, right.contactId);
const byGroupId = (left: GroupRecord, right: GroupRecord): number =>
  compareId(left.groupId, right.groupId);
const messageOrder = (left: MessageRecord, right: MessageRecord): number =>
  right.timestamp - left.timestamp || compareId(right.messageId, left.messageId);

interface OpenConversation {
  readonly public: WhatsAppConversation;
  hydrate(): Promise<void>;
  loadOlder(): Promise<void>;
  readWindow(): Promise<StoredMessagePage | undefined>;
  replaceWindow(page: StoredMessagePage): void;
  receive(message: MessageRecord): void;
  receivePresence(presence: PresenceUpdate, expiresAt: number): void;
  clearPresence(): void;
  stage(): void;
  flush(): void;
  close(): void;
}

export type WhatsAppClientOptions = Omit<WhatsAppRuntimeConfig, "backend"> & {
  /** Open the Backend instance this Client owns and closes. */
  openBackend(): WhatsAppBackendResource | Promise<WhatsAppBackendResource>;
};

async function createClientState(
  runtime: WhatsAppRuntime,
  start: () => Promise<void>,
): Promise<WhatsAppClient> {
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
  const clientSubscriptions = new Set<Unsubscribe>();
  const queued: WhatsAppClientFrame[] = [];
  let generation = 0;
  let revision = -1;
  let account: AccountRecord;
  let accountState: WhatsAppAccountState;
  let publishedChats: readonly ChatRecord[] = [];
  let publishedContacts: readonly ContactRecord[] = [];
  let publishedGroups: readonly GroupRecord[] = [];
  let hydrating = true;
  let terminated = false;
  let closed = false;
  let closeCause: unknown;
  let recovering: Promise<void> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let off: Unsubscribe = () => {};
  let rejectHydration!: (reason: WhatsAppClientClosedError) => void;
  const hydrationTerminated = new Promise<never>((_, reject) => {
    rejectHydration = reject;
  });

  const requireClient = (): void => {
    if (closed) throw new WhatsAppClientClosedError("Client", closeCause);
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

  const closeClient = (failure?: { readonly error: unknown }): void => {
    if (closed) return;
    closed = true;
    closeCause = failure?.error;
    if (failure) {
      accountState = { record: account, closed: { error: failure.error } };
      notify(accountListeners, accountState);
    }
    off();
    if (connectionTimer) clearTimeout(connectionTimer);
    for (const conversation of conversations) conversation.close();
    for (const unsubscribe of clientSubscriptions) unsubscribe();
  };

  const replace = (snapshot: WhatsAppSnapshot): (() => void) => {
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
    generation += 1;
    return () => {
      if (!isDeepStrictEqual(previousAccount, accountState)) notify(accountListeners, accountState);
      if (!isDeepStrictEqual(previousChats, publishedChats)) notify(chatListeners, publishedChats);
      if (!isDeepStrictEqual(previousContacts, publishedContacts))
        notify(contactListeners, publishedContacts);
      if (!isDeepStrictEqual(previousGroups, publishedGroups))
        notify(groupListeners, publishedGroups);
    };
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
    const affectedConversations = new Set<OpenConversation>();
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
          for (const conversation of conversations)
            if (conversation.public.chatId === record.chat.chatId)
              affectedConversations.add(conversation);
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
            if (conversation.public.chatId === record.message.chatId) {
              conversation.receive(record.message);
              affectedConversations.add(conversation);
            }
          break;
      }
    }
    for (const deletion of patch.deletes ?? []) {
      contacts.delete(deletion.contactId);
      contactsChanged = true;
    }
    revision = patch.revision;
    if (chatsChanged) publishedChats = [...chats.values()].sort(chatOrder);
    if (contactsChanged) {
      rebuildAliases();
      publishedContacts = [...contacts.values()].sort(byContactId);
    }
    if (groupsChanged) publishedGroups = [...groups.values()].sort(byGroupId);
    for (const conversation of affectedConversations) conversation.stage();
    for (const conversation of affectedConversations) conversation.flush();
    if (accountChanged) notify(accountListeners, accountState);
    if (chatsChanged) notify(chatListeners, publishedChats);
    if (contactsChanged) notify(contactListeners, publishedContacts);
    if (groupsChanged) notify(groupListeners, publishedGroups);
  };

  const consume = (frame: WhatsAppClientFrame): void => {
    if (closed || terminated) return;
    if (frame.type === "closed") {
      if (hydrating) {
        rejectHydration(
          new WhatsAppClientClosedError("Client", "error" in frame ? frame.error : undefined),
        );
        return;
      }
      terminated = true;
      queued.length = 0;
      recovering = undefined;
      if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = undefined;
      }
      accountState = {
        record: account,
        closed: "error" in frame ? { error: frame.error } : {},
      };
      for (const conversation of conversations) conversation.clearPresence();
      notify(accountListeners, accountState);
      for (const conversation of conversations) conversation.flush();
      return;
    }
    if (hydrating || recovering) {
      queued.push(frame);
      return;
    }
    if (frame.type === "connection") {
      if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = undefined;
      }
      const identity = source.identity();
      if (frame.state.expiresAt <= Date.now()) {
        const next = { record: account, ...(identity && { identity }) };
        if (!isDeepStrictEqual(accountState, next)) {
          accountState = next;
          notify(accountListeners, accountState);
        }
        return;
      }
      accountState = {
        record: account,
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
          connectionTimer = undefined;
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
    if (frame.type !== "patch") return;
    if (frame.patch.revision <= revision) return;
    if (frame.patch.fromRevision === revision) {
      apply(frame.patch);
      return;
    }
    let task!: Promise<void>;
    task = (async () => {
      try {
        const snapshot = await source.snapshot();
        const replacing = [...conversations];
        const windows = await Promise.all(
          replacing.map(
            async (conversation) => [conversation, await conversation.readWindow()] as const,
          ),
        );
        if (closed || terminated) return;
        const flushGlobal = replace(snapshot);
        for (const [conversation, page] of windows) if (page) conversation.replaceWindow(page);
        flushGlobal();
        for (const conversation of replacing) conversation.flush();
      } catch (error) {
        closeClient({ error });
      } finally {
        if (recovering === task) recovering = undefined;
        if (!closed && !terminated)
          for (const queuedFrame of queued.splice(0)) consume(queuedFrame);
      }
    })();
    recovering = task;
  };

  off = source.onFrame(consume);
  try {
    await Promise.race([start(), hydrationTerminated]);
    replace(await Promise.race([source.snapshot(), hydrationTerminated]));
    hydrating = false;
    for (const frame of queued.splice(0)) consume(frame);
  } catch (error) {
    off();
    throw error;
  }

  const subscribe = <Value>(
    listeners: Set<(value: Value) => void>,
    listener: (value: Value) => void,
    subscriptions: Set<Unsubscribe>,
    options?: SubscriptionOptions,
  ): Unsubscribe => {
    listeners.add(listener);
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      options?.signal?.removeEventListener("abort", unsubscribe);
      subscriptions.delete(unsubscribe);
    };
    subscriptions.add(unsubscribe);
    if (options?.signal?.aborted) unsubscribe();
    else options?.signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  };

  const open = async (
    chatId: string,
    options?: { readonly pageSize?: number },
  ): Promise<WhatsAppConversation> => {
    requireClient();
    const openingGeneration = generation;
    const pageSize = options?.pageSize ?? 25;
    if (!Number.isInteger(pageSize) || pageSize < 1)
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);

    const messages = new Map<string, MessageRecord>();
    const presences = new Map<
      string,
      { readonly value: PresenceUpdate; readonly timer: ReturnType<typeof setTimeout> }
    >();
    const conversationListeners = new Set<(value: WhatsAppConversationState) => void>();
    const conversationSubscriptions = new Set<Unsubscribe>();
    let cursor: StoredMessageCursor | undefined;
    let pageRead: Promise<void> | undefined;
    let replacementRead: Promise<StoredMessagePage | undefined> | undefined;
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
    let publishedState = state;
    const stage = (next: Partial<WhatsAppConversationState> = {}): void => {
      state = {
        ...state,
        ...next,
        messages: [...messages.values()].sort(messageOrder),
        presence: [...presences.entries()]
          .sort(([left], [right]) => compareId(left, right))
          .map(([, entry]) => entry.value),
      };
    };
    const flush = (): void => {
      if (isDeepStrictEqual(publishedState, state)) return;
      publishedState = state;
      notify(conversationListeners, state);
    };
    const publish = (next: Partial<WhatsAppConversationState> = {}): void => {
      stage(next);
      flush();
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
          return subscribe(
            conversationListeners,
            listener,
            conversationSubscriptions,
            subscriptionOptions,
          );
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
        if (replacementRead) return replacementRead.then(() => {});
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
      readWindow() {
        if (replacementRead) return replacementRead;
        let task!: Promise<StoredMessagePage | undefined>;
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
            try {
              return await Promise.race([
                source.messages(chatId, { limit: Math.max(pageSize, messages.size) }),
                closedConversation,
              ]);
            } catch (error) {
              if (conversationClosed) return;
              throw error;
            }
          } finally {
            if (replacementRead === task) replacementRead = undefined;
          }
        })();
        replacementRead = task;
        return task;
      },
      replaceWindow(page) {
        if (conversationClosed) return;
        messages.clear();
        for (const message of page.messages) messages.set(message.messageId, message);
        cursor = page.nextBefore;
        stage({
          chat: chats.get(chatId),
          loadingOlder: false,
          hasOlderSaved: cursor !== undefined,
          error: undefined,
        });
      },
      receive(message) {
        if (conversationClosed) return;
        messages.set(message.messageId, message);
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
      clearPresence() {
        if (conversationClosed || presences.size === 0) return;
        for (const presence of presences.values()) clearTimeout(presence.timer);
        presences.clear();
        stage();
      },
      stage() {
        if (conversationClosed) return;
        stage({ chat: chats.get(chatId) });
      },
      flush() {
        if (conversationClosed) return;
        flush();
      },
      close() {
        if (conversationClosed) return;
        conversationClosed = true;
        rejectClosed(new WhatsAppClientClosedError("conversation"));
        for (const presence of presences.values()) clearTimeout(presence.timer);
        presences.clear();
        for (const unsubscribe of conversationSubscriptions) unsubscribe();
        conversations.delete(internal);
      },
    };
    // Registered before storage is read so a live upsert cannot fall between
    // opening the conversation and its first coherent saved/live state.
    conversations.add(internal);
    try {
      await internal.hydrate();
      for (;;) {
        while (recovering) await recovering;
        requireConversation();
        if (terminated || generation === openingGeneration) return internal.public;
        const expectedGeneration = generation;
        const page = await internal.readWindow();
        requireConversation();
        if (!terminated && !recovering && generation === expectedGeneration && page) {
          internal.replaceWindow(page);
          internal.flush();
          return internal.public;
        }
      }
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
        return subscribe(accountListeners, listener, clientSubscriptions, options);
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
        return subscribe(chatListeners, listener, clientSubscriptions, options);
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
        return subscribe(contactListeners, listener, clientSubscriptions, options);
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
        return subscribe(groupListeners, listener, clientSubscriptions, options);
      },
    },
    async close() {
      closeClient();
    },
  };
}

/** Open one owned, hydrated WhatsApp Client. */
export async function createWhatsAppClient(
  options: WhatsAppClientOptions,
): Promise<WhatsAppClient> {
  const backend = await options.openBackend();
  const runtime = createWhatsAppRuntime({ ...options, backend });
  const dispose = async (state?: WhatsAppClient): Promise<void> => {
    let failed = false;
    let failure: unknown;
    for (const close of [() => state?.close(), () => runtime.stop(), () => backend.close()]) {
      try {
        await close();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
  };
  let state: WhatsAppClient;
  try {
    state = await createClientState(runtime, () => runtime.start());
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
  let closing: Promise<void> | undefined;

  return { ...state, close: () => (closing ??= dispose(state)) };
}
