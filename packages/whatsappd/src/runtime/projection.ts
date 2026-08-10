import { isDeepStrictEqual } from "node:util";
import type { GroupParticipant, GroupUpdate } from "../model/group.ts";
import type { HistoryChat } from "../model/history.ts";
import { refOf } from "../model/outbound.ts";
import {
  UnsupportedDurableEventError,
  type AccountRecord,
  type ChatRecord,
  type ContactRecord,
  type DurableInboundMessage,
  type DurableUpdate,
  type GroupRecord,
  type MessageRecord,
  type MirrorAlias,
  type MirrorDelete,
  type MirrorRecord,
  type ObservedInstant,
  type WhatsAppDataEvent,
} from "./contracts.ts";

/** Keyed reads required by the backend-independent Current Mirror projection. */
export interface CurrentMirrorRecords {
  account(): Promise<AccountRecord>;
  chat(chatId: string): Promise<ChatRecord | undefined>;
  contact(contactId: string): Promise<ContactRecord | undefined>;
  contactId(nativeId: string): Promise<string | undefined>;
  group(groupId: string): Promise<GroupRecord | undefined>;
  message(chatId: string, messageId: string): Promise<MessageRecord | undefined>;
}

export type CurrentMirrorMutation =
  | { readonly type: "upsert"; readonly record: MirrorRecord }
  | { readonly type: "delete"; readonly record: MirrorDelete }
  | { readonly type: "contact_alias"; readonly nativeId: string; readonly contactId: string };

export interface CurrentMirrorProjection {
  readonly upserts: readonly MirrorRecord[];
  readonly deletes: readonly MirrorDelete[];
  /** Only the aliases whose owner changed — see {@link WhatsAppPatch.aliases}. */
  readonly aliases: readonly MirrorAlias[];
  readonly mutations: readonly CurrentMirrorMutation[];
}

interface ProjectionState {
  account(): Promise<AccountRecord>;
  chat(chatId: string): Promise<ChatRecord | undefined>;
  contact(contactId: string): Promise<ContactRecord | undefined>;
  contactId(nativeId: string): Promise<string | undefined>;
  group(groupId: string): Promise<GroupRecord | undefined>;
  message(chatId: string, messageId: string): Promise<MessageRecord | undefined>;
  upsert(record: MirrorRecord): void;
  delete(record: MirrorDelete): void;
  alias(nativeId: string, contactId: string): Promise<void>;
}

function projectionState(
  records: CurrentMirrorRecords,
  upserts: MirrorRecord[],
  deletes: MirrorDelete[],
  aliases: MirrorAlias[],
  mutations: CurrentMirrorMutation[],
): ProjectionState {
  let account: AccountRecord | undefined;
  const chats = new Map<string, ChatRecord | undefined>();
  const contacts = new Map<string, ContactRecord | undefined>();
  const contactIds = new Map<string, string | undefined>();
  const groups = new Map<string, GroupRecord | undefined>();
  const messages = new Map<string, MessageRecord | undefined>();
  const messageKey = (chatId: string, messageId: string): string => `${chatId}\0${messageId}`;

  return {
    async account() {
      return (account ??= await records.account());
    },
    async chat(chatId) {
      if (!chats.has(chatId)) chats.set(chatId, await records.chat(chatId));
      return chats.get(chatId);
    },
    async contact(contactId) {
      if (!contacts.has(contactId)) contacts.set(contactId, await records.contact(contactId));
      return contacts.get(contactId);
    },
    async contactId(nativeId) {
      if (!contactIds.has(nativeId)) contactIds.set(nativeId, await records.contactId(nativeId));
      return contactIds.get(nativeId);
    },
    async group(groupId) {
      if (!groups.has(groupId)) groups.set(groupId, await records.group(groupId));
      return groups.get(groupId);
    },
    async message(chatId, messageId) {
      const key = messageKey(chatId, messageId);
      if (!messages.has(key)) messages.set(key, await records.message(chatId, messageId));
      return messages.get(key);
    },
    upsert(record) {
      switch (record.type) {
        case "account":
          account = record.account;
          break;
        case "chat":
          chats.set(record.chat.chatId, record.chat);
          break;
        case "contact":
          contacts.set(record.contact.contactId, record.contact);
          break;
        case "group":
          groups.set(record.group.groupId, record.group);
          break;
        case "message":
          messages.set(messageKey(record.message.chatId, record.message.messageId), record.message);
          break;
      }
      upserts.push(record);
      mutations.push({ type: "upsert", record });
    },
    delete(record) {
      contacts.set(record.contactId, undefined);
      deletes.push(record);
      mutations.push({ type: "delete", record });
    },
    async alias(nativeId, contactId) {
      // The mutation is written unconditionally — the store's alias write is an
      // idempotent upsert — but only a change is a delta. Re-observing a
      // contact re-asserts every alias it already had, and a patch carrying
      // those would move the revision on an observation that changed nothing.
      const owner = await this.contactId(nativeId);
      contactIds.set(nativeId, contactId);
      mutations.push({ type: "contact_alias", nativeId, contactId });
      if (owner !== contactId) aliases.push({ nativeId, contactId });
    },
  };
}

async function projectChat(state: ProjectionState, chat: ChatRecord): Promise<void> {
  const existing = await state.chat(chat.chatId);
  const merged: ChatRecord = existing
    ? { ...existing, ...chat, lastMessageAt: Math.max(existing.lastMessageAt, chat.lastMessageAt) }
    : chat;
  if (existing && isDeepStrictEqual(existing, merged)) return;
  state.upsert({ type: "chat", chat: merged });
}

async function projectContact(state: ProjectionState, contact: ContactRecord): Promise<void> {
  const reachedIds: string[] = [];
  /** Which of this observation's forms reached each owner, record or not. */
  const reachedBy = new Map<string, string[]>();
  for (const nativeId of contact.nativeIds) {
    const reached = await state.contactId(nativeId);
    if (reached === undefined) continue;
    if (!reachedIds.includes(reached)) reachedIds.push(reached);
    reachedBy.set(reached, [...(reachedBy.get(reached) ?? []), nativeId]);
  }
  const contactId = reachedIds[0] ?? contact.contactId;
  const reached: ContactRecord[] = [];
  for (const id of reachedIds) {
    const record = await state.contact(id);
    if (record !== undefined) reached.push(record);
  }
  const existing = await state.contact(contactId);
  const nativeIds = [
    ...new Set([...reached.flatMap((record) => record.nativeIds), ...contact.nativeIds]),
  ];
  const seen = [...reached.flatMap((record) => record.lastSeenAt ?? []), contact.lastSeenAt].filter(
    (at): at is number => at !== undefined,
  );
  const merged: ContactRecord = {
    ...Object.assign({}, ...reached.toReversed()),
    ...contact,
    contactId,
    nativeIds,
    ...(seen.length > 0 && { lastSeenAt: Math.max(...seen) }),
  };

  for (const id of reachedIds.slice(1)) {
    // What this delete frees is the record's own native ids, plus the forms
    // that reached it — which is all there is to name when the record itself
    // is missing. Both are in `merged.nativeIds`, so the aliases below
    // re-point every one of them.
    const freedNativeIds = [
      ...new Set([
        ...(reached.find((record) => record.contactId === id)?.nativeIds ?? []),
        ...(reachedBy.get(id) ?? []),
      ]),
    ];
    state.delete({
      type: "contact",
      contactId: id,
      ...(freedNativeIds.length > 0 && { freedNativeIds }),
    });
  }
  for (const id of merged.nativeIds) await state.alias(id, contactId);
  if (existing && isDeepStrictEqual(existing, merged)) return;
  state.upsert({ type: "contact", contact: merged });
}

function rosterAfter(
  existing: readonly GroupParticipant[],
  update: Extract<GroupUpdate, { kind: "participants" }>,
): readonly GroupParticipant[] {
  const roster = new Map(existing.map((participant) => [participant.id, participant]));
  for (const participant of update.participants) {
    if (update.action === "remove") roster.delete(participant.id);
    else roster.set(participant.id, participant);
  }
  return [...roster.values()];
}

async function projectGroup(state: ProjectionState, group: GroupRecord): Promise<void> {
  const existing = await state.group(group.groupId);
  const merged: GroupRecord = existing ? { ...existing, ...group } : group;
  if (existing && isDeepStrictEqual(existing, merged)) return;
  state.upsert({ type: "group", group: merged });
}

async function projectSyncedChat(
  state: ProjectionState,
  accountId: string,
  chat: HistoryChat,
): Promise<void> {
  await projectChat(state, {
    accountId,
    chatId: chat.id,
    isGroup: chat.isGroup,
    ...(chat.subject !== undefined && { subject: chat.subject }),
    lastMessageAt: chat.lastMessageAt ?? 0,
  });
  if (!chat.isGroup) return;
  const participants = chat.participants ?? (await state.group(chat.id))?.participants;
  await projectGroup(state, {
    accountId,
    groupId: chat.id,
    ...(chat.subject !== undefined && { subject: chat.subject }),
    ...(participants !== undefined && { participants }),
  });
}

const advance = (current: number | undefined, at: number): number => Math.max(current ?? at, at);

async function projectObserved(
  state: ProjectionState,
  accountId: string,
  observed: ObservedInstant,
): Promise<void> {
  if (observed.type === "last_seen") {
    const contactId = await state.contactId(observed.contactId);
    if (contactId === undefined) return;
    return projectContact(state, {
      accountId,
      contactId,
      nativeIds: [observed.contactId],
      lastSeenAt: observed.at,
    });
  }
  const existing = await state.account();
  const merged: AccountRecord =
    observed.kind === "connected"
      ? { ...existing, lastConnectedAt: advance(existing.lastConnectedAt, observed.at) }
      : { ...existing, lastDisconnectedAt: advance(existing.lastDisconnectedAt, observed.at) };
  if (isDeepStrictEqual(existing, merged)) return;
  state.upsert({ type: "account", account: merged });
}

type CurrentMessageBase = Pick<
  MessageRecord,
  | "accountId"
  | "chatId"
  | "messageId"
  | "sender"
  | "ref"
  | "fromMe"
  | "timestamp"
  | "pushName"
  | "context"
  | "flags"
  | "receipts"
  | "reactions"
  | "editedAt"
>;

function withCurrentContent(
  base: CurrentMessageBase,
  message: DurableInboundMessage,
): MessageRecord {
  switch (message.kind) {
    case "text":
      return { ...base, kind: "text", text: message.text };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return {
        ...base,
        kind: message.kind,
        media: message.media,
        ...(message.text !== undefined && { text: message.text }),
      };
    case "location":
      return {
        ...base,
        kind: "location",
        lat: message.lat,
        lng: message.lng,
        ...(message.name !== undefined && { name: message.name }),
        ...(message.address !== undefined && { address: message.address }),
      };
    case "contacts":
      return { ...base, kind: "contacts", contacts: message.contacts };
    case "poll":
      return {
        ...base,
        kind: "poll",
        name: message.name,
        options: message.options,
        selectableCount: message.selectableCount,
      };
    case "unsupported":
      return { ...base, kind: "unsupported", rawType: message.rawType };
  }
}

async function projectMessage(
  state: ProjectionState,
  accountId: string,
  message: DurableInboundMessage,
): Promise<void> {
  if (message.sender.alt !== undefined)
    await projectContact(state, {
      accountId,
      contactId: message.sender.id,
      nativeIds: [message.sender.id, message.sender.alt],
    });

  const existing = await state.message(message.chatId, message.id);
  if (!existing) {
    const base = {
      accountId,
      chatId: message.chatId,
      messageId: message.id,
      sender: message.sender,
      ref: refOf(message),
      fromMe: message.fromMe,
      timestamp: message.timestamp,
      ...(message.pushName !== undefined && { pushName: message.pushName }),
      ...(message.context !== undefined && { context: message.context }),
      ...(message.flags !== undefined && { flags: message.flags }),
      receipts: [],
      reactions: [],
    };
    state.upsert({ type: "message", message: withCurrentContent(base, message) });
  }
  await projectChat(state, {
    accountId,
    chatId: message.chatId,
    isGroup: message.isGroup,
    lastMessageAt: message.timestamp,
  });
}

async function projectMessageUpdate(state: ProjectionState, update: DurableUpdate): Promise<void> {
  const existing = await state.message(update.ref.chatId, update.ref.id);
  if (!existing) return;

  if (update.kind === "receipt") {
    const subject = update.by === undefined ? "aggregate" : `participant:${update.by}`;
    const receipt = {
      subject,
      status: update.status,
      ...(update.by !== undefined && { by: update.by }),
      ...(update.at !== undefined && { at: update.at }),
    };
    const index = existing.receipts.findIndex((current) => current.subject === subject);
    const receipts =
      index === -1
        ? [...existing.receipts, receipt]
        : existing.receipts.map((current, currentIndex) =>
            currentIndex === index ? receipt : current,
          );
    const message = { ...existing, receipts };
    if (!isDeepStrictEqual(existing, message)) state.upsert({ type: "message", message });
    return;
  }

  if (update.kind === "reaction") {
    const subject = update.by ?? "aggregate";
    const index = existing.reactions.findIndex((current) => current.subject === subject);
    const reactions = update.removed
      ? existing.reactions.filter((current) => current.subject !== subject)
      : update.emoji === undefined
        ? existing.reactions
        : index === -1
          ? [
              ...existing.reactions,
              {
                subject,
                emoji: update.emoji,
                ...(update.by !== undefined && { by: update.by }),
                ...(update.at !== undefined && { at: update.at }),
              },
            ]
          : existing.reactions.map((current, currentIndex) =>
              currentIndex === index
                ? {
                    subject,
                    emoji: update.emoji!,
                    ...(update.by !== undefined && { by: update.by }),
                    ...(update.at !== undefined && { at: update.at }),
                  }
                : current,
            );
    const message = { ...existing, reactions };
    if (!isDeepStrictEqual(existing, message)) state.upsert({ type: "message", message });
    return;
  }

  if (update.kind === "edit") {
    if (existing.kind === "revoked") return;
    const editedAt = update.at ?? existing.editedAt;
    const pushName = update.message.pushName ?? existing.pushName;
    const message = withCurrentContent(
      {
        accountId: existing.accountId,
        chatId: existing.chatId,
        messageId: existing.messageId,
        sender: existing.sender,
        ref: existing.ref,
        fromMe: existing.fromMe,
        timestamp: existing.timestamp,
        ...(pushName !== undefined && { pushName }),
        ...(update.message.context !== undefined && { context: update.message.context }),
        ...(update.message.flags !== undefined && { flags: update.message.flags }),
        receipts: existing.receipts,
        reactions: existing.reactions,
        ...(editedAt !== undefined && { editedAt }),
      },
      update.message,
    );
    if (!isDeepStrictEqual(existing, message)) state.upsert({ type: "message", message });
    return;
  }

  if (update.kind === "revoke") {
    const message: MessageRecord = {
      accountId: existing.accountId,
      chatId: existing.chatId,
      messageId: existing.messageId,
      sender: existing.sender,
      ref: existing.ref,
      fromMe: existing.fromMe,
      timestamp: existing.timestamp,
      ...(existing.pushName !== undefined && { pushName: existing.pushName }),
      ...(existing.context !== undefined && { context: existing.context }),
      ...(existing.flags !== undefined && { flags: existing.flags }),
      receipts: existing.receipts,
      reactions: existing.reactions,
      ...(existing.editedAt !== undefined && { editedAt: existing.editedAt }),
      kind: "revoked",
      ...(update.at !== undefined && { revokedAt: update.at }),
      ...(update.by !== undefined && { revokedBy: update.by }),
    };
    if (!isDeepStrictEqual(existing, message)) state.upsert({ type: "message", message });
  }
}

async function projectEvent(
  state: ProjectionState,
  accountId: string,
  { event }: WhatsAppDataEvent,
): Promise<void> {
  switch (event.type) {
    case "message":
      return projectMessage(state, accountId, event.message);
    case "update":
      return projectMessageUpdate(state, event.update);
    case "conversation_sync": {
      const { context, chats, contacts, messages } = event.batch;
      if (context.projection.mode !== "upsert")
        throw new UnsupportedDurableEventError("an authoritative conversation-sync replacement");
      for (const chat of chats) await projectSyncedChat(state, accountId, chat);
      for (const contact of contacts)
        await projectContact(state, {
          accountId,
          contactId: contact.id,
          nativeIds: [...new Set([contact.id, ...contact.nativeIds])],
          ...(contact.displayName !== undefined && { displayName: contact.displayName }),
        });
      for (const message of messages) await projectMessage(state, accountId, message);
      return;
    }
    case "contact": {
      const { contact } = event;
      return projectContact(state, {
        accountId,
        contactId: contact.id,
        nativeIds: [...new Set([contact.id, ...contact.nativeIds])],
        ...(contact.displayName !== undefined && { displayName: contact.displayName }),
        ...(contact.profileName !== undefined && { profileName: contact.profileName }),
        ...(contact.verifiedName !== undefined && { verifiedName: contact.verifiedName }),
        ...(contact.username !== undefined && { username: contact.username }),
        ...(contact.imgUrl !== undefined && { imgUrl: contact.imgUrl }),
        ...(contact.status !== undefined && { about: contact.status }),
      });
    }
    case "group": {
      const { group } = event;
      const roster = (await state.group(group.id))?.participants;
      const renamed = group.kind === "metadata" && group.subject !== undefined;
      const participants =
        group.kind === "participants"
          ? roster && rosterAfter(roster, group)
          : (group.participants ?? roster);
      await projectGroup(state, {
        accountId,
        groupId: group.id,
        ...(renamed && { subject: group.subject }),
        ...(participants !== undefined && { participants }),
      });
      if (renamed)
        await projectChat(state, {
          accountId,
          chatId: group.id,
          isGroup: true,
          subject: group.subject,
          lastMessageAt: 0,
        });
      return;
    }
    case "last_seen":
    case "account_connection":
      return projectObserved(state, accountId, event);
    default:
      throw new UnsupportedDurableEventError("an unknown event");
  }
}

/** Project a batch using only keyed reads, returning mutations for one Adapter transaction. */
export async function projectCurrentMirror(
  records: CurrentMirrorRecords,
  accountId: string,
  events: readonly WhatsAppDataEvent[],
): Promise<CurrentMirrorProjection> {
  const upserts: MirrorRecord[] = [];
  const deletes: MirrorDelete[] = [];
  const aliases: MirrorAlias[] = [];
  const mutations: CurrentMirrorMutation[] = [];
  const state = projectionState(records, upserts, deletes, aliases, mutations);
  for (const event of events) await projectEvent(state, accountId, event);
  return { upserts, deletes, aliases, mutations };
}
