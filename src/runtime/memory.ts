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
import { memoryStore } from "../stores/memory.ts";
import { immutableMediaRef } from "./media.ts";
import {
  OperationIdempotencyConflictError,
  fanoutOperationListeners,
  notifyOperationListener,
  operationId,
  sameOperationInput,
  type OperationClock,
  type SerializedOperationError,
  type WhatsAppOperation,
  type WhatsAppOperationStore,
} from "./operations.ts";
import { projectCurrentMirror } from "./projection.ts";
import {
  StaleAccountClaimError,
  type AcceptedWhatsAppBatch,
  type AccountLease,
  type AccountLeaseStore,
  type AccountRecord,
  type ChatRecord,
  type ContactRecord,
  type GroupRecord,
  type MediaStore,
  type MessageRecord,
  type CurrentMirrorView,
  type StoredMessageCursor,
  type WhatsAppBackend,
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
  // ponytail: one in-memory transaction chain preserves atomic call order;
  // split it per account only if test-backend contention becomes measurable.
  let operations: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = operations.then(operation);
    operations = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const copy = <T>(value: T): T => structuredClone(value);
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

  /**
   * The account's mirror as it stands right now.
   *
   * @remarks
   * The read transaction, in a process that has no database to open one in.
   * Acceptance replaces map entries rather than mutating records in place, so
   * copying the maps is enough: every later write lands in the live mirror and
   * none of it is visible through these.
   */
  const pin = (mirror: AccountMirror): AccountMirror => ({
    ...mirror,
    chats: new Map(mirror.chats),
    contacts: new Map(mirror.contacts),
    contactKeys: new Map(mirror.contactKeys),
    groups: new Map(mirror.groups),
    messages: new Map(mirror.messages),
  });

  const view = (accountId: string, mirror: AccountMirror): CurrentMirrorView => ({
    async snapshot() {
      return copy({
        accountId,
        revision: mirror.revision,
        account: mirror.account,
        chats: [...mirror.chats.values()],
        contacts: [...mirror.contacts.values()],
        contactAliases: Object.fromEntries(mirror.contactKeys),
        groups: [...mirror.groups.values()],
      });
    },

    async messages(chatId, options) {
      const limit = options?.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError(`limit must be a positive integer, got ${limit}`);
      const before = options?.before;
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
      return copy({
        accountId,
        chatId,
        // Read from the same mirror state as the rows above, so a consumer can
        // tell which patches this page already reflects.
        revision: mirror.revision,
        messages,
        ...(last && { nextBefore: { timestamp: last.timestamp, messageId: last.messageId } }),
      });
    },
  });

  const read: WhatsAppDataStore["read"] = async (accountId, fn) => {
    // Every acceptance already offered is applied first, as a direct read would
    // wait for it — then the mirror is pinned, so nothing offered afterwards
    // can reach any of the answers `fn` gets.
    await operations;
    return fn(view(accountId, pin(mirrorOf(accountId))));
  };

  return {
    async accept(accountId, events, fencingToken) {
      const ownedEvents = copy(events);
      return serialize(async () => {
        const mirror = mirrorOf(accountId);
        // A resumed writer whose claim has moved on must not reach the mirror,
        // however long its event has been buffered (ADR-0009).
        if (fencingToken < mirror.claim)
          throw new StaleAccountClaimError(accountId, fencingToken, mirror.claim);

        // Project into an overlay so a rejected event leaves nothing behind:
        // the append, projection, and revision commit together or not at all.
        const { upserts, deletes, aliases, mutations } = await projectCurrentMirror(
          {
            account: async () => mirror.account,
            chat: async (chatId) => mirror.chats.get(chatId),
            contact: async (contactId) => mirror.contacts.get(contactId),
            contactId: async (nativeId) => mirror.contactKeys.get(nativeId),
            group: async (groupId) => mirror.groups.get(groupId),
            message: async (chatId, messageId) =>
              mirror.messages.get(messageKey(chatId, messageId)),
          },
          accountId,
          ownedEvents,
        );
        const fromRevision = mirror.revision;
        const revision =
          upserts.length === 0 && deletes.length === 0 && aliases.length === 0
            ? fromRevision
            : fromRevision + 1;
        const batch: AcceptedWhatsAppBatch = {
          accountId,
          seq: mirror.batches.length + 1,
          fromRevision,
          revision,
          events: ownedEvents,
          patch: {
            accountId,
            fromRevision,
            revision,
            upserts,
            ...(deletes.length > 0 && { deletes }),
            ...(aliases.length > 0 && { aliases }),
          },
        };
        for (const mutation of mutations) {
          if (mutation.type === "contact_alias") {
            mirror.contactKeys.set(mutation.nativeId, mutation.contactId);
            continue;
          }
          if (mutation.type === "delete") {
            mirror.contacts.delete(mutation.record.contactId);
            continue;
          }
          const record = mutation.record;
          switch (record.type) {
            case "account":
              mirror.account = record.account;
              break;
            case "chat":
              mirror.chats.set(record.chat.chatId, record.chat);
              break;
            case "contact":
              mirror.contacts.set(record.contact.contactId, record.contact);
              break;
            case "group":
              mirror.groups.set(record.group.groupId, record.group);
              break;
            case "message":
              mirror.messages.set(
                messageKey(record.message.chatId, record.message.messageId),
                record.message,
              );
              break;
          }
        }
        mirror.revision = revision;
        mirror.claim = fencingToken;
        mirror.batches.push(batch);
        return copy(batch);
      });
    },

    claim(accountId, fencingToken) {
      return serialize(() => {
        const mirror = mirrorOf(accountId);
        if (fencingToken < mirror.claim)
          throw new StaleAccountClaimError(accountId, fencingToken, mirror.claim);
        mirror.claim = fencingToken;
      });
    },

    read,
    snapshot: (accountId) => read(accountId, (mirror) => mirror.snapshot()),
    messages: (accountId, chatId, options) =>
      read(accountId, (mirror) => mirror.messages(chatId, options)),

    async accepted(accountId, afterSeq, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError(`limit must be a positive integer, got ${limit}`);
      await operations;
      return copy(
        mirrorOf(accountId)
          .batches.filter((batch) => batch.seq > afterSeq)
          .slice(0, limit),
      );
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
 * message, kind, and byte content.
 */
export function memoryMediaStore(): MediaStore {
  const blobs = new Map<string, { readonly accountId: string; readonly bytes: Uint8Array }>();
  return {
    async put({ accountId, message, kind, bytes }) {
      const ref = immutableMediaRef({ accountId, message, kind, bytes });
      blobs.set(ref, { accountId, bytes: Uint8Array.from(bytes) });
      return { ref, byteLength: bytes.byteLength };
    },
    async read({ accountId, ref }) {
      const blob = blobs.get(ref);
      return blob?.accountId === accountId ? Uint8Array.from(blob.bytes) : null;
    },
  };
}

export interface MemoryOperationStoreOptions {
  readonly clock?: OperationClock;
}

/** An in-memory durable-operation Adapter with the same conditional transitions as libSQL. */
export function memoryOperationStore(
  options: MemoryOperationStoreOptions = {},
): WhatsAppOperationStore {
  const clock = options.clock ?? { now: () => Date.now() };
  const records = new Map<string, WhatsAppOperation>();
  const idempotency = new Map<string, string>();
  const listeners = new Map<string, Set<(operation: WhatsAppOperation) => void>>();
  let writes: Promise<void> = Promise.resolve();
  const key = (accountId: string, operationId: string): string => `${accountId}\0${operationId}`;
  const keyForIdempotency = (accountId: string, idempotencyKey: string): string =>
    `${accountId}\0${idempotencyKey}`;
  const copy = <T>(value: T): T => structuredClone(value);
  const serialize = <T>(write: () => Promise<T>): Promise<T> => {
    const result = writes.then(write);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const publish = (operation: WhatsAppOperation): void => {
    fanoutOperationListeners(
      listeners.get(key(operation.accountId, operation.id)) ?? new Set(),
      operation,
    );
  };
  const replace = (operation: WhatsAppOperation): WhatsAppOperation => {
    records.set(key(operation.accountId, operation.id), operation);
    publish(operation);
    return copy(operation);
  };
  const now = async (): Promise<number> => {
    const at = await clock.now();
    if (!Number.isSafeInteger(at)) throw new RangeError(`operation clock returned ${at}`);
    return at;
  };
  const transition = async (
    accountId: string,
    operationId: string,
    attemptId: string,
    allowed: "claimed" | "executing",
    state: WhatsAppOperation["state"],
    updatedAt: number,
  ): Promise<boolean> => {
    const current = records.get(key(accountId, operationId));
    if (
      !current ||
      current.state.status !== allowed ||
      current.state.attemptId !== attemptId ||
      current.state.expiresAt <= updatedAt
    )
      return false;
    replace({ ...current, state, updatedAt });
    return true;
  };

  return {
    submit({ accountId, id, idempotencyKey, operation }) {
      return serialize(async () => {
        const replayId = idempotency.get(keyForIdempotency(accountId, idempotencyKey));
        if (replayId) {
          const replay = records.get(key(accountId, replayId));
          if (!replay) throw new Error("in-memory operation idempotency index is corrupt");
          if (!sameOperationInput(replay.input, operation))
            throw new OperationIdempotencyConflictError(accountId, idempotencyKey);
          return copy(replay);
        }
        const submittedAt = await now();
        const created: WhatsAppOperation = {
          accountId,
          id,
          idempotencyKey,
          input: copy(operation),
          state: { status: "queued" },
          submittedAt,
          updatedAt: submittedAt,
        };
        idempotency.set(keyForIdempotency(accountId, idempotencyKey), id);
        return replace(created);
      });
    },
    async get(accountId, operationId) {
      await writes;
      const operation = records.get(key(accountId, operationId));
      return operation && copy(operation);
    },
    subscribe(accountId, operationId, listener) {
      const operationKey = key(accountId, operationId);
      const subscriptions = listeners.get(operationKey) ?? new Set();
      subscriptions.add(listener);
      listeners.set(operationKey, subscriptions);
      const current = records.get(operationKey);
      if (current) notifyOperationListener(listener, current);
      return () => {
        subscriptions.delete(listener);
        if (subscriptions.size === 0) listeners.delete(operationKey);
      };
    },
    recoverExpired(accountId) {
      return serialize(async () => {
        const at = await now();
        let recovered = 0;
        for (const current of records.values()) {
          if (
            current.accountId !== accountId ||
            (current.state.status !== "claimed" && current.state.status !== "executing") ||
            current.state.expiresAt > at
          )
            continue;
          const state: WhatsAppOperation["state"] =
            current.state.status === "claimed"
              ? { status: "queued" }
              : {
                  status: "outcome_unknown",
                  reason: "execution_lease_expired",
                  completedAt: at,
                };
          replace({ ...current, state, updatedAt: at });
          recovered += 1;
        }
        return recovered;
      });
    },
    claimNext(accountId, ttlMs) {
      return serialize(async () => {
        const current = [...records.values()]
          .filter(
            (operation) => operation.accountId === accountId && operation.state.status === "queued",
          )
          .sort(
            (left, right) =>
              left.submittedAt - right.submittedAt || left.id.localeCompare(right.id),
          )[0];
        if (!current) return undefined;
        const at = await now();
        return replace({
          ...current,
          state: { status: "claimed", attemptId: operationId(), expiresAt: at + ttlMs },
          updatedAt: at,
        });
      });
    },
    start(accountId, operationIdValue, attemptId, ttlMs) {
      return serialize(async () => {
        const at = await now();
        return transition(
          accountId,
          operationIdValue,
          attemptId,
          "claimed",
          {
            status: "executing",
            attemptId,
            startedAt: at,
            expiresAt: at + ttlMs,
          },
          at,
        );
      });
    },
    succeed(accountId, operationIdValue, attemptId, result) {
      return serialize(async () => {
        const at = await now();
        return transition(
          accountId,
          operationIdValue,
          attemptId,
          "executing",
          {
            status: "succeeded",
            result: copy(result),
            completedAt: at,
          },
          at,
        );
      });
    },
    fail(accountId, operationIdValue, attemptId, error: SerializedOperationError) {
      return serialize(async () => {
        const at = await now();
        return transition(
          accountId,
          operationIdValue,
          attemptId,
          "claimed",
          {
            status: "failed",
            error: copy(error),
            completedAt: at,
          },
          at,
        );
      });
    },
    markUnknown(accountId, operationIdValue, attemptId, reason) {
      return serialize(async () => {
        const at = await now();
        return transition(
          accountId,
          operationIdValue,
          attemptId,
          "executing",
          {
            status: "outcome_unknown",
            reason,
            completedAt: at,
          },
          at,
        );
      });
    },
  };
}

/**
 * Group in-memory implementations of every capability one runtime needs.
 *
 * @remarks
 * The capabilities are constructed independently and can be replaced one at a
 * time by passing a different implementation of the corresponding contract.
 *
 * @returns A backend whose state vanishes with the process.
 */
export function memoryBackend(options: MemoryOperationStoreOptions = {}): WhatsAppBackend {
  return {
    credentials: memoryStore(),
    data: memoryDataStore(),
    leases: memoryLeaseStore(),
    media: memoryMediaStore(),
    operations: memoryOperationStore(options),
  };
}
