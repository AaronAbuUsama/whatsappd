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
import { randomUUID } from "node:crypto";
import { memoryStore } from "../stores/memory.ts";
import { immutableMediaRef } from "./media.ts";
import {
  OperationIdempotencyConflictError,
  announceOperationChanges,
  operationSubscription,
  operationInputJson,
  validatedOperationResult,
  validatedOperationSubmission,
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
  type MirrorView,
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

  const view = (accountId: string, mirror: AccountMirror): MirrorView => ({
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

/** In-process reference implementation of the durable operation state machine. */
export function memoryOperationStore(): WhatsAppOperationStore {
  const accounts = new Map<
    string,
    {
      readonly byId: Map<string, WhatsAppOperation>;
      readonly byKey: Map<string, string>;
      nextSequence: number;
    }
  >();
  const listeners = new Map<
    string,
    Set<{ readonly notify: (operation: WhatsAppOperation) => void }>
  >();
  let writes: Promise<void> = Promise.resolve();

  const account = (accountId: string) => {
    const held = accounts.get(accountId);
    if (held) return held;
    const created = {
      byId: new Map<string, WhatsAppOperation>(),
      byKey: new Map<string, string>(),
      nextSequence: 1,
    };
    accounts.set(accountId, created);
    return created;
  };
  const copy = <T>(value: T): T => structuredClone(value);
  const serialize = <T>(work: () => T): Promise<T> => {
    const result = writes.then(work);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const write = async <T>(
    accountId: string,
    work: (held: ReturnType<typeof account>) => {
      readonly result: T;
      readonly changed: WhatsAppOperation[];
    },
  ): Promise<T> => {
    const committed = await serialize(() => work(account(accountId)));
    announceOperationChanges(listeners, accountId, committed.changed);
    return copy(committed.result);
  };
  const replace = (
    held: ReturnType<typeof account>,
    current: WhatsAppOperation,
    state: WhatsAppOperation["state"],
    at: number,
  ): WhatsAppOperation => {
    const next = { ...current, state, revision: current.revision + 1, updatedAt: at };
    held.byId.set(current.id, next);
    return next;
  };
  const complete = (
    accountId: string,
    operationId: string,
    attemptId: string,
    expected: "claimed" | "executing",
    state: (at: number, current: WhatsAppOperation) => WhatsAppOperation["state"],
  ): Promise<WhatsAppOperation | undefined> =>
    write(accountId, (held) => {
      const current = held.byId.get(operationId);
      if (
        !current ||
        !("attemptId" in current.state) ||
        current.state.status !== expected ||
        current.state.attemptId !== attemptId
      )
        return { result: undefined, changed: [] };
      const at = Date.now();
      const completed = replace(held, current, state(at, current), at);
      return { result: completed, changed: [completed] };
    });

  return {
    submit(request) {
      const submission = validatedOperationSubmission(request);
      return write(submission.accountId, (held) => {
        const existingId = held.byKey.get(submission.idempotencyKey);
        if (existingId) {
          const existing = held.byId.get(existingId)!;
          if (operationInputJson(existing.input) !== operationInputJson(submission.input))
            throw new OperationIdempotencyConflictError(
              submission.accountId,
              submission.idempotencyKey,
            );
          return { result: existing, changed: [] };
        }
        if (held.byId.has(submission.id))
          throw new Error(`operation id "${submission.id}" already exists`);
        const now = Date.now();
        const operation: WhatsAppOperation = {
          ...submission,
          revision: 0,
          sequence: held.nextSequence,
          state: { status: "queued" },
          submittedAt: now,
          updatedAt: now,
        };
        held.nextSequence += 1;
        held.byId.set(operation.id, operation);
        held.byKey.set(operation.idempotencyKey, operation.id);
        return { result: operation, changed: [operation] };
      });
    },

    async get(accountId, operationId) {
      await writes;
      const operation = account(accountId).byId.get(operationId);
      return operation && copy(operation);
    },

    async list(accountId) {
      await writes;
      return copy([...account(accountId).byId.values()].sort((a, b) => a.sequence - b.sequence));
    },

    claim(accountId, attemptId, ttlMs) {
      return write(accountId, (held) => {
        const now = Date.now();
        const changed: WhatsAppOperation[] = [];
        for (const operation of held.byId.values()) {
          if (operation.state.status === "claimed" && operation.state.expiresAt <= now) {
            changed.push(replace(held, operation, { status: "queued" }, now));
          } else if (operation.state.status === "executing" && operation.state.expiresAt <= now) {
            changed.push(
              replace(
                held,
                operation,
                {
                  status: "outcome_unknown",
                  reason: "execution attempt expired after the WhatsApp boundary",
                  completedAt: now,
                },
                now,
              ),
            );
          }
        }
        const queued = [...held.byId.values()]
          .filter((operation) => operation.state.status === "queued")
          .sort((a, b) => a.sequence - b.sequence)[0];
        if (!queued) return { result: undefined, changed };
        const claimed = replace(
          held,
          queued,
          { status: "claimed", attemptId, expiresAt: now + ttlMs },
          now,
        );
        changed.push(claimed);
        return { result: claimed, changed };
      });
    },

    async recoveryDelay(accountId) {
      await writes;
      const now = Date.now();
      const expiries = [...account(accountId).byId.values()].flatMap((operation) =>
        operation.state.status === "claimed" || operation.state.status === "executing"
          ? [operation.state.expiresAt]
          : [],
      );
      return expiries.length === 0 ? undefined : Math.max(0, Math.min(...expiries) - now);
    },

    start(accountId, operationId, attemptId, ttlMs) {
      return write(accountId, (held) => {
        const current = held.byId.get(operationId);
        const now = Date.now();
        if (
          !current ||
          current.state.status !== "claimed" ||
          current.state.attemptId !== attemptId ||
          current.state.expiresAt <= now
        )
          return { result: undefined, changed: [] };
        const started = replace(
          held,
          current,
          { status: "executing", attemptId, startedAt: now, expiresAt: now + ttlMs },
          now,
        );
        return { result: started, changed: [started] };
      });
    },

    release: (accountId, operationId, attemptId) =>
      complete(accountId, operationId, attemptId, "claimed", () => ({ status: "queued" })),

    succeed(accountId, operationId, attemptId, result) {
      return complete(accountId, operationId, attemptId, "executing", (at, current) => ({
        status: "succeeded",
        result: validatedOperationResult(current.input, result),
        completedAt: at,
      }));
    },

    fail(accountId, operationId, attemptId, error) {
      return complete(accountId, operationId, attemptId, "claimed", (at) => ({
        status: "failed",
        error: copy(error),
        completedAt: at,
      }));
    },

    unknown(accountId, operationId, attemptId, reason) {
      return complete(accountId, operationId, attemptId, "executing", (at) => ({
        status: "outcome_unknown",
        reason,
        completedAt: at,
      }));
    },

    acknowledge(accountId, operationId) {
      return write(accountId, (held) => {
        const current = held.byId.get(operationId);
        if (!current || current.acknowledgedAt !== undefined)
          return { result: current, changed: [] };
        if (
          current.state.status !== "succeeded" &&
          current.state.status !== "failed" &&
          current.state.status !== "outcome_unknown"
        )
          return { result: current, changed: [] };
        const now = Date.now();
        const acknowledged = {
          ...current,
          revision: current.revision + 1,
          acknowledgedAt: now,
          updatedAt: now,
        };
        held.byId.set(operationId, acknowledged);
        return { result: acknowledged, changed: [acknowledged] };
      });
    },

    subscribe(accountId, listener) {
      return operationSubscription(listeners, accountId, listener);
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
  const blobs = new Map<
    string,
    {
      readonly accountId: string;
      readonly bytes: Uint8Array;
      readonly leases: Set<string>;
      permanent: boolean;
    }
  >();
  return {
    async put({ accountId, owner, kind, bytes, temporary }) {
      const ref = immutableMediaRef({ accountId, owner, kind, bytes });
      const blob = blobs.get(ref) ?? {
        accountId,
        bytes: Uint8Array.from(bytes),
        leases: new Set<string>(),
        permanent: false,
      };
      const leaseId = temporary ? randomUUID() : undefined;
      if (leaseId) blob.leases.add(leaseId);
      else blob.permanent = true;
      blobs.set(ref, blob);
      return { ref, byteLength: bytes.byteLength, ...(leaseId && { leaseId }) };
    },
    async read({ accountId, ref }) {
      const blob = blobs.get(ref);
      return blob?.accountId === accountId ? Uint8Array.from(blob.bytes) : null;
    },
    async retain({ accountId, ref, leaseId }) {
      const blob = blobs.get(ref);
      if (!blob || blob.accountId !== accountId || !blob.leases.delete(leaseId))
        throw new Error("media staging lease does not exist");
      blob.permanent = true;
    },
    async discard({ accountId, ref, leaseId }) {
      const blob = blobs.get(ref);
      if (!blob || blob.accountId !== accountId || !blob.leases.delete(leaseId)) return;
      if (!blob.permanent && blob.leases.size === 0) blobs.delete(ref);
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
export function memoryBackend(): WhatsAppBackend {
  return {
    credentials: memoryStore(),
    data: memoryDataStore(),
    leases: memoryLeaseStore(),
    media: memoryMediaStore(),
    operations: memoryOperationStore(),
  };
}
