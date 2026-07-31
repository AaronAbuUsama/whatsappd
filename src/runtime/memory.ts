/**
 * In-memory implementations of the real backend contracts.
 *
 * @remarks
 * These are the reference implementations: same contracts, same account
 * scoping, same acceptance semantics as a database backend, with the durable
 * part held in a `Map`. They exist for deterministic tests and single-process
 * composition — libSQL is the first backend that survives a restart.
 *
 * @packageDocumentation
 */
import { isDeepStrictEqual } from "node:util";
import type { GroupParticipant, GroupUpdate } from "../model/group.ts";
import type { HistoryChat } from "../model/history.ts";
import type { InboundMessage } from "../model/message.ts";
import { memoryStore } from "../stores/memory.ts";
import {
  StaleAccountClaimError,
  UnsupportedDurableEventError,
  type AcceptedWhatsAppBatch,
  type AccountLease,
  type AccountLeaseStore,
  type AccountRecord,
  type ChatRecord,
  type ContactRecord,
  type GroupRecord,
  type MediaStore,
  type MessageRecord,
  type MirrorRecord,
  type ObservedInstant,
  type StoredMessageCursor,
  type WhatsAppBackend,
  type WhatsAppDataEvent,
  type WhatsAppDataStore,
} from "./contracts.ts";

interface AccountMirror {
  revision: number;
  /** The newest fencing token this account has accepted a write from. */
  claim: number;
  account: AccountRecord;
  chats: Map<string, ChatRecord>;
  contacts: Map<string, ContactRecord>;
  /** Every known native id → the contact record that owns it (PN ↔ LID). */
  contactKeys: Map<string, string>;
  groups: Map<string, GroupRecord>;
  messages: Map<string, MessageRecord>;
  batches: AcceptedWhatsAppBatch[];
}

const messageKey = (chatId: string, messageId: string): string => `${chatId}\0${messageId}`;

/**
 * Order two stored messages newest first.
 *
 * @remarks
 * The `(timestamp, messageId)` order a {@link StoredMessageCursor} names. The
 * id is not decoration: a history sync lands many messages on one second, and
 * an order that left those tied would let a page boundary fall inside the tie
 * and drop or repeat one of them.
 */
const newestFirst = (a: StoredMessageCursor, b: StoredMessageCursor): number =>
  b.timestamp - a.timestamp || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0);

/**
 * Project one chat into the pending mirror.
 *
 * @remarks
 * Merged into the existing record rather than replacing it: a live message
 * knows a chat's newest timestamp but not its subject, and an upsert must never
 * erase what another observation established.
 */
function projectChat(pending: AccountMirror, upserts: MirrorRecord[], chat: ChatRecord): void {
  const existing = pending.chats.get(chat.chatId);
  const merged: ChatRecord = existing
    ? {
        ...existing,
        ...chat,
        lastMessageAt: Math.max(existing.lastMessageAt, chat.lastMessageAt),
      }
    : chat;
  if (existing && isDeepStrictEqual(existing, merged)) return;
  pending.chats.set(chat.chatId, merged);
  upserts.push({ type: "chat", chat: merged });
}

/** Move an observed instant forward only; an older one is still true, not newer. */
const advance = (current: number | undefined, at: number): number => Math.max(current ?? at, at);

/**
 * Project one contact into the pending mirror.
 *
 * @remarks
 * Merged like a chat: a presence observation knows an address's last-seen
 * instant and nothing else, and must not blank the name a contact event
 * established. `nativeIds` unions rather than replaces for the same reason —
 * WhatsApp delivers a contact's PN and LID forms in different events, and a
 * host joining the two schemes needs both to survive.
 *
 * The record is found through *any* id the observation claims, not through
 * whichever form happens to be primary this time. `ContactUpdate.nativeIds`
 * exists to be matched on, and without doing so a LID-keyed update naming its
 * PN would open a second record — leaving the name on one snapshot entry and
 * the last-seen on another.
 */
function projectContact(
  pending: AccountMirror,
  upserts: MirrorRecord[],
  contact: ContactRecord,
): void {
  const known = contact.nativeIds
    .map((id) => pending.contactKeys.get(id))
    .find((id) => id !== undefined);
  const contactId = known ?? contact.contactId;
  const existing = pending.contacts.get(contactId);
  const merged: ContactRecord = existing
    ? {
        ...existing,
        ...contact,
        // The record keeps the identity it was first stored under: a newly
        // delivered form joins it rather than renaming it out from under every
        // consumer holding the old key.
        contactId,
        nativeIds: [...new Set([...existing.nativeIds, ...contact.nativeIds])],
        ...(contact.lastSeenAt !== undefined && {
          lastSeenAt: advance(existing.lastSeenAt, contact.lastSeenAt),
        }),
      }
    : contact;
  // Indexed before the no-change bail, so a form this observation was the first
  // to name still resolves next time even when it moved nothing.
  for (const id of merged.nativeIds) pending.contactKeys.set(id, contactId);
  if (existing && isDeepStrictEqual(existing, merged)) return;
  pending.contacts.set(contactId, merged);
  upserts.push({ type: "contact", contact: merged });
}

/**
 * Apply a participant change to the roster a group record already holds.
 *
 * @remarks
 * A removal edits the group record's participant list; it does not remove a
 * mirror record, so ADR-0019 is untouched — nothing here produces a patch
 * delete.
 */
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

/** Project one group into the pending mirror, merging as a chat does. */
function projectGroup(pending: AccountMirror, upserts: MirrorRecord[], group: GroupRecord): void {
  const existing = pending.groups.get(group.groupId);
  const merged: GroupRecord = existing ? { ...existing, ...group } : group;
  if (existing && isDeepStrictEqual(existing, merged)) return;
  pending.groups.set(group.groupId, merged);
  upserts.push({ type: "group", group: merged });
}

/**
 * Project one chat a sync delivered, and the group that chat describes.
 *
 * @remarks
 * A bootstrap sync is where a real account's groups arrive — its chat rows
 * carry the subject and roster. Waiting for a separate `group` event instead
 * would leave the first Snapshot Window listing group chats and no groups.
 */
function projectSyncedChat(
  pending: AccountMirror,
  upserts: MirrorRecord[],
  accountId: string,
  chat: HistoryChat,
): void {
  projectChat(pending, upserts, {
    accountId,
    chatId: chat.id,
    isGroup: chat.isGroup,
    ...(chat.subject !== undefined && { subject: chat.subject }),
    lastMessageAt: chat.lastMessageAt ?? 0,
  });
  if (!chat.isGroup) return;
  projectGroup(pending, upserts, {
    accountId,
    groupId: chat.id,
    ...(chat.subject !== undefined && { subject: chat.subject }),
    participants: chat.participants ?? pending.groups.get(chat.id)?.participants ?? [],
  });
}

/**
 * Project one derived instant: an address's last-seen, or this account's own
 * connection timestamps (ADR-0020).
 *
 * @remarks
 * A last-seen lands on a contact that already exists and creates nothing —
 * see the note inside, which is the reason one contact can never split into
 * two records this slice would then have to merge away.
 */
function projectObserved(
  pending: AccountMirror,
  upserts: MirrorRecord[],
  accountId: string,
  observed: ObservedInstant,
): void {
  if (observed.type === "last_seen") {
    // A presence observation updates a contact; it never invents one. It knows
    // exactly one native form of an address and nothing that links it to the
    // others, so letting it create records is what lets a PN ping and a LID
    // ping open two records for one WhatsApp Address — and a later contact
    // event naming both could then only reconcile them by *removing* one, which
    // ADR-0019 does not allow a mirror to do. Contact and conversation-sync
    // observations always carry the full `nativeIds` set, so a record created
    // only by them can always be found again and never needs merging away.
    //
    // The cost is bounded and deliberate: an address WhatsApp has never named
    // in a contact or sync batch keeps no last-seen. WhatsApp only sends
    // presence for addresses a session subscribed to, which are the ones its
    // own sync already delivered.
    const contactId = pending.contactKeys.get(observed.contactId);
    if (contactId === undefined) return;
    return projectContact(pending, upserts, {
      accountId,
      contactId,
      nativeIds: [observed.contactId],
      lastSeenAt: observed.at,
    });
  }
  const existing = pending.account;
  const merged: AccountRecord =
    observed.kind === "connected"
      ? { ...existing, lastConnectedAt: advance(existing.lastConnectedAt, observed.at) }
      : { ...existing, lastDisconnectedAt: advance(existing.lastDisconnectedAt, observed.at) };
  if (isDeepStrictEqual(existing, merged)) return;
  pending.account = merged;
  upserts.push({ type: "account", account: merged });
}

/**
 * Project one message and the chat summary it advances.
 *
 * @throws {@link UnsupportedDurableEventError} for any non-text message — media
 * capture is a later slice and must not reach storage as a bodiless record.
 */
function projectMessage(
  pending: AccountMirror,
  upserts: MirrorRecord[],
  accountId: string,
  message: InboundMessage,
): void {
  if (message.kind !== "text")
    throw new UnsupportedDurableEventError(`a "${message.kind}" message`);

  const record: MessageRecord = {
    accountId,
    chatId: message.chatId,
    messageId: message.id,
    sender: message.sender,
    fromMe: message.fromMe,
    timestamp: message.timestamp,
    kind: "text",
    text: message.text,
  };
  const key = messageKey(record.chatId, record.messageId);
  const existing = pending.messages.get(key);
  // The same message replayed by history sync is the same record: no second
  // upsert, so no revision and no client update.
  if (!existing || !isDeepStrictEqual(existing, record)) {
    pending.messages.set(key, record);
    upserts.push({ type: "message", message: record });
  }
  projectChat(pending, upserts, {
    accountId,
    chatId: message.chatId,
    isGroup: message.isGroup,
    lastMessageAt: message.timestamp,
  });
}

/**
 * Project one observation.
 *
 * @param accountId - The account named in the `accept()` call. Every record is
 * scoped to it and to nothing else — never to an identifier carried by the
 * event, the chat, or the message.
 */
function projectEvent(
  pending: AccountMirror,
  upserts: MirrorRecord[],
  accountId: string,
  { event }: WhatsAppDataEvent,
): void {
  switch (event.type) {
    case "message":
      return projectMessage(pending, upserts, accountId, event.message);
    case "conversation_sync": {
      const { context, chats, contacts, messages } = event.batch;
      // Deleting on a sync needs explicit, scope-bounded replacement metadata
      // that no live protocol mapping has proven yet (ADR-0014).
      if (context.projection.mode !== "upsert")
        throw new UnsupportedDurableEventError("an authoritative conversation-sync replacement");
      for (const chat of chats) projectSyncedChat(pending, upserts, accountId, chat);
      for (const contact of contacts)
        projectContact(pending, upserts, {
          accountId,
          contactId: contact.id,
          nativeIds: [contact.id],
          ...(contact.displayName !== undefined && { displayName: contact.displayName }),
        });
      for (const message of messages) projectMessage(pending, upserts, accountId, message);
      return;
    }
    case "contact": {
      const { contact } = event;
      return projectContact(pending, upserts, {
        accountId,
        contactId: contact.id,
        // The primary id first, then whatever equivalents the event carried.
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
      const roster = pending.groups.get(group.id)?.participants ?? [];
      const renamed = group.kind === "metadata" && group.subject !== undefined;
      projectGroup(pending, upserts, {
        accountId,
        groupId: group.id,
        ...(renamed && { subject: group.subject }),
        participants:
          group.kind === "participants"
            ? rosterAfter(roster, group)
            : (group.participants ?? roster),
      });
      // A rename reaches the chat summary too, exactly as a synced group's does.
      // Updating only the group record would leave one Snapshot Window carrying
      // two different names for the same group, and every consumer that renders
      // chat summaries would never see the rename at all.
      if (renamed)
        projectChat(pending, upserts, {
          accountId,
          chatId: group.id,
          isGroup: true,
          subject: group.subject,
          // Merged, so an existing chat keeps whatever newer message it holds.
          lastMessageAt: 0,
        });
      return;
    }
    case "last_seen":
    case "account_connection":
      return projectObserved(pending, upserts, accountId, event);
    default:
      throw new UnsupportedDurableEventError(`a "${event.type}" event`);
  }
}

/**
 * An in-memory {@link WhatsAppDataStore}.
 *
 * @remarks
 * One store may hold many accounts; every record is keyed by the account named
 * in the call, so two accounts never see each other's state.
 *
 * @returns A data store whose accepted batches and mirror live in this process.
 */
export function memoryDataStore(): WhatsAppDataStore {
  const accounts = new Map<string, AccountMirror>();
  const mirrorOf = (accountId: string): AccountMirror => {
    const existing = accounts.get(accountId);
    if (existing) return existing;
    const created: AccountMirror = {
      revision: 0,
      claim: 0,
      account: { accountId },
      chats: new Map(),
      contacts: new Map(),
      contactKeys: new Map(),
      groups: new Map(),
      messages: new Map(),
      batches: [],
    };
    accounts.set(accountId, created);
    return created;
  };

  return {
    async accept(accountId, events, fencingToken) {
      const mirror = mirrorOf(accountId);
      // A resumed writer whose claim has moved on must not reach the mirror,
      // however long its event has been buffered (ADR-0009).
      if (fencingToken < mirror.claim)
        throw new StaleAccountClaimError(accountId, fencingToken, mirror.claim);

      const fromRevision = mirror.revision;
      // Project into copies so a rejected event leaves nothing behind: the
      // append, the projection, and the revision stamp commit together or not
      // at all.
      const pending: AccountMirror = {
        ...mirror,
        chats: new Map(mirror.chats),
        contacts: new Map(mirror.contacts),
        contactKeys: new Map(mirror.contactKeys),
        groups: new Map(mirror.groups),
        messages: new Map(mirror.messages),
      };
      const upserts: MirrorRecord[] = [];
      for (const event of events) projectEvent(pending, upserts, accountId, event);

      // The observation is recorded either way — it happened. Only a real
      // change to current state takes a revision, so a replay leaves clients
      // with nothing to apply.
      const revision = upserts.length === 0 ? fromRevision : fromRevision + 1;
      const batch: AcceptedWhatsAppBatch = {
        accountId,
        seq: mirror.batches.length + 1,
        fromRevision,
        revision,
        events: [...events],
        patch: { accountId, fromRevision, revision, upserts },
      };
      mirror.account = pending.account;
      mirror.chats = pending.chats;
      mirror.contacts = pending.contacts;
      mirror.contactKeys = pending.contactKeys;
      mirror.groups = pending.groups;
      mirror.messages = pending.messages;
      mirror.revision = revision;
      mirror.claim = fencingToken;
      mirror.batches.push(batch);
      return batch;
    },

    async claim(accountId, fencingToken) {
      const mirror = mirrorOf(accountId);
      if (fencingToken < mirror.claim)
        throw new StaleAccountClaimError(accountId, fencingToken, mirror.claim);
      mirror.claim = fencingToken;
    },

    async snapshot(accountId) {
      const mirror = mirrorOf(accountId);
      return {
        accountId,
        revision: mirror.revision,
        account: mirror.account,
        chats: [...mirror.chats.values()],
        contacts: [...mirror.contacts.values()],
        groups: [...mirror.groups.values()],
      };
    },

    async messages(accountId, chatId, options) {
      const limit = options?.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError(`limit must be a positive integer, got ${limit}`);
      const before = options?.before;
      const mirror = mirrorOf(accountId);
      // ponytail: no ordering index, so a page sorts the chat's whole history.
      // Fine while the mirror is a Map in one process; the persistent backend
      // (#38) pages on a `(chat_id, timestamp desc, message_id desc)` index.
      const ordered = [...mirror.messages.values()]
        .filter((message) => message.chatId === chatId)
        .sort(newestFirst);
      // Strictly older than the cursor in that same order, so a message sharing
      // its timestamp is included or excluded by identity rather than by luck.
      const from = before ? ordered.findIndex((message) => newestFirst(before, message) < 0) : 0;
      const older = from === -1 ? [] : ordered.slice(from);
      const messages = older.slice(0, limit);
      // Named only when an older stored message really exists, so following the
      // cursor never hands a caller an empty page and calls that the end.
      const last = older.length > limit ? messages[messages.length - 1] : undefined;
      return {
        accountId,
        chatId,
        // Read from the same mirror state as the rows above, so a consumer can
        // tell which patches this page already reflects.
        revision: mirror.revision,
        messages,
        ...(last && { nextBefore: { timestamp: last.timestamp, messageId: last.messageId } }),
      };
    },

    async accepted(accountId, afterSeq) {
      return mirrorOf(accountId).batches.filter((batch) => batch.seq > afterSeq);
    },
  };
}

/**
 * An in-memory {@link AccountLeaseStore}.
 *
 * @remarks
 * Compare-and-swap within one process: a live claim blocks every other holder
 * until it is released or expires, and each claim gets a higher fencing token.
 * Separate processes need a backend that shares its clock and its table.
 *
 * @returns A lease store scoped to this process.
 */
export function memoryLeaseStore(): AccountLeaseStore {
  const held = new Map<string, AccountLease>();
  let issued = 0;

  return {
    async acquire(accountId, holderId, ttlMs) {
      const now = Date.now();
      const current = held.get(accountId);
      if (current && current.expiresAt > now)
        return { acquired: false, heldUntil: current.expiresAt };
      const lease: AccountLease = {
        accountId,
        holderId,
        fencingToken: ++issued,
        expiresAt: now + ttlMs,
      };
      held.set(accountId, lease);
      return { acquired: true, lease };
    },

    async renew(lease, ttlMs) {
      const current = held.get(lease.accountId);
      if (!current || current.fencingToken !== lease.fencingToken)
        return { renewed: false, reason: "lost" };
      if (current.expiresAt <= Date.now()) {
        held.delete(lease.accountId);
        return { renewed: false, reason: "expired" };
      }
      const renewed: AccountLease = { ...current, expiresAt: Date.now() + ttlMs };
      held.set(lease.accountId, renewed);
      return { renewed: true, lease: renewed };
    },

    async release(lease) {
      const current = held.get(lease.accountId);
      if (!current || current.fencingToken !== lease.fencingToken) return false;
      held.delete(lease.accountId);
      return true;
    },
  };
}

/**
 * An in-memory {@link MediaStore}.
 *
 * @returns A media store whose blobs are keyed idempotently by account,
 * message, and kind.
 */
export function memoryMediaStore(): MediaStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put({ accountId, message, kind, bytes }) {
      const ref = `memory:${accountId}:${message.chatId}:${message.id}:${kind}`;
      blobs.set(ref, bytes);
      return { ref, byteLength: bytes.byteLength };
    },
  };
}

/**
 * Group in-memory implementations of every capability one runtime needs.
 *
 * @remarks
 * The capabilities are constructed independently and can be replaced one at a
 * time — pass `{ ...memoryBackend(), data: libsqlDataStore(...) }` to mix.
 *
 * @returns A backend whose state vanishes with the process.
 */
export function memoryBackend(): WhatsAppBackend {
  return {
    credentials: memoryStore(),
    data: memoryDataStore(),
    leases: memoryLeaseStore(),
    media: memoryMediaStore(),
  };
}
