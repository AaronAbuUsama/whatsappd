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
import type { InboundMessage } from "../model/message.ts";
import { memoryStore } from "../stores/memory.ts";
import {
  StaleAccountClaimError,
  UnsupportedDurableEventError,
  type AcceptedWhatsAppBatch,
  type AccountLease,
  type AccountLeaseStore,
  type ChatRecord,
  type MediaStore,
  type MessageRecord,
  type MirrorRecord,
  type WhatsAppBackend,
  type WhatsAppDataEvent,
  type WhatsAppDataStore,
} from "./contracts.ts";

interface AccountMirror {
  revision: number;
  /** The newest fencing token this account has accepted a write from. */
  claim: number;
  chats: Map<string, ChatRecord>;
  messages: Map<string, MessageRecord>;
  batches: AcceptedWhatsAppBatch[];
}

const messageKey = (chatId: string, messageId: string): string => `${chatId}\0${messageId}`;

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
      const { context, chats, messages } = event.batch;
      // Deleting on a sync needs explicit, scope-bounded replacement metadata
      // that no live protocol mapping has proven yet (ADR-0014).
      if (context.projection.mode !== "upsert")
        throw new UnsupportedDurableEventError("an authoritative conversation-sync replacement");
      // The batch's contacts are recorded with it and simply move nothing: the
      // mirror has no contact record yet. Refusing them here would only teach
      // callers to strip them before accepting, which loses the observation.
      for (const chat of chats)
        projectChat(pending, upserts, {
          accountId,
          chatId: chat.id,
          isGroup: chat.isGroup,
          ...(chat.subject !== undefined && { subject: chat.subject }),
          lastMessageAt: chat.lastMessageAt ?? 0,
        });
      for (const message of messages) projectMessage(pending, upserts, accountId, message);
      return;
    }
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
      chats: new Map(),
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
      mirror.chats = pending.chats;
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
        chats: [...mirror.chats.values()],
        messages: [...mirror.messages.values()],
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
