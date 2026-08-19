/**
 * A Convex-backed {@link WhatsAppBackend}: credentials, the accepted source log
 * and Current Mirror, the Account Lease, and WhatsApp Operations, against one
 * Convex deployment. Media bytes stay with the {@link MediaStore} the caller
 * supplies, because durable media is its own capability (ADR-0004).
 *
 * @remarks
 * The Convex functions in `whatsappd/convex` must be deployed first — see that
 * module for the two files an application adds to its `convex/` directory.
 *
 * **Where the work runs.** The Current Mirror projection stays in this process
 * rather than moving into a Convex mutation, because it reaches for
 * `node:crypto` and `node:util`, which the Convex runtime does not have. So
 * acceptance reads the records it needs, projects here, and commits once
 * through `commit`, which refuses the write unless the account's source cursor
 * is still the one the projection was computed against. Acceptance is the only
 * writer of mirror rows and advances that cursor on every batch, so the cursor
 * is a complete read-set check rather than a heuristic: it cannot still match
 * while any record the projection read has changed. A refusal projects again —
 * with an Account Lease held there is one writer per account, so that is the
 * case which should not arise rather than the case which does.
 *
 * @packageDocumentation
 */
import type { CredentialStore } from "../ports.ts";
import {
  StaleAccountClaimError,
  type AcceptedWhatsAppBatch,
  type AccountLeaseStore,
  type AccountRecord,
  type ChatRecord,
  type ContactRecord,
  type GroupRecord,
  type MediaStore,
  type MessageRecord,
  type MirrorView,
  type WhatsAppBackend,
  type WhatsAppDataEvent,
  type WhatsAppDataStore,
  type WhatsAppPatch,
} from "./contracts.ts";
import {
  lazyConvexClient,
  type ConvexCalls,
  type ConvexRecordKey,
  type ConvexRowWrite,
} from "./convex-client.ts";
import { convexOperationStore } from "./convex-operations.ts";
import { validatePage } from "./mirror-page.ts";
import {
  projectCurrentMirror,
  type CurrentMirrorMutation,
  type CurrentMirrorRecords,
} from "./projection.ts";

export interface ConvexBackendOptions {
  /** The deployment URL, e.g. `http://127.0.0.1:3210` or a `.convex.cloud` one. */
  readonly url: string;
  readonly accountId: string;
  readonly media: MediaStore;
  /**
   * The Convex module the functions were re-exported from — the file name
   * under `convex/`, without its extension.
   *
   * @defaultValue `"whatsappd"`
   */
  readonly module?: string;
}

export interface ConvexBackend extends WhatsAppBackend, AsyncDisposable {
  close(): Promise<void>;
}

/**
 * How many times acceptance re-projects against a moved source cursor before
 * giving up. A single writer per account never reaches two; the bound exists so
 * a misconfigured deployment fails loudly instead of spinning.
 */
const ACCEPT_ATTEMPTS = 8;

/** Digits enough for any millisecond timestamp inside the safe integer range. */
const ORDER_DIGITS = 16;

/**
 * The `(timestamp, messageId)` page position as one orderable string.
 *
 * @remarks
 * A Convex index range compares one field, so the pair a Stored Message Page is
 * ordered by (ADR-0010) cannot be carried as a two-column cursor: the page
 * boundary would have to fall inside a timestamp collision, which a history
 * sync produces constantly. Zero-padding the timestamp makes its lexicographic
 * order its numeric order, and the separator keeps a longer message id from
 * outranking a shorter one that shares its prefix.
 */
function orderKey(timestamp: number, messageId: string): string {
  if (timestamp < 0)
    throw new RangeError(
      `a message position must not carry a negative timestamp, got ${timestamp}`,
    );
  return `${String(timestamp).padStart(ORDER_DIGITS, "0")} ${messageId}`;
}

const decode = <T>(value: string): T => JSON.parse(value) as T;

/** One projection mutation as the row write the acceptance mutation applies. */
function rowWrite(mutation: CurrentMirrorMutation): ConvexRowWrite {
  switch (mutation.type) {
    case "pending_updates":
      return {
        kind: "pendingUpdates",
        id: mutation.chatId,
        messageId: mutation.messageId,
        // No updates left is a delete: an empty row would answer "some are
        // pending" to the next thing that asks about this message key.
        ...(mutation.updates.length > 0 && { data: JSON.stringify(mutation.updates) }),
      };
    case "contact_alias":
      return { kind: "alias", id: mutation.nativeId, data: mutation.contactId };
    case "delete":
      return { kind: "contactDelete", id: mutation.record.contactId };
    case "upsert":
      switch (mutation.record.type) {
        case "account":
          return {
            kind: "account",
            id: mutation.record.account.accountId,
            data: JSON.stringify(mutation.record.account),
          };
        case "chat":
          return {
            kind: "chat",
            id: mutation.record.chat.chatId,
            data: JSON.stringify(mutation.record.chat),
          };
        case "contact":
          return {
            kind: "contact",
            id: mutation.record.contact.contactId,
            data: JSON.stringify(mutation.record.contact),
          };
        case "group":
          return {
            kind: "group",
            id: mutation.record.group.groupId,
            data: JSON.stringify(mutation.record.group),
          };
        case "message":
          return {
            kind: "message",
            id: mutation.record.message.chatId,
            messageId: mutation.record.message.messageId,
            timestamp: mutation.record.message.timestamp,
            order: orderKey(mutation.record.message.timestamp, mutation.record.message.messageId),
            data: JSON.stringify(mutation.record.message),
          };
      }
  }
}

type RecordKind = ConvexRecordKey["kind"];

const cacheKey = (kind: RecordKind, id: string, messageId?: string): string =>
  `${kind} ${id} ${messageId ?? ""}`;

/**
 * The records one batch is about to read, discovered by projecting it against
 * an empty mirror and keeping the questions rather than the answers.
 *
 * @remarks
 * Read demand here is not derivable from an event's shape without a second
 * copy of the projection's rules — which is the copy that eventually disagrees
 * with the first. Asking the projection itself costs one extra pass over the
 * batch in memory and turns a round trip per record into one round trip for
 * the batch, which is what keeps acceptance off the network for every message
 * a history sync delivers.
 *
 * The answers it gets are wrong on purpose: nothing exists in the mirror it
 * projects against. Only the keys survive, and the real pass reads every one
 * of them for real. A batch this pass cannot project at all — an unsupported
 * event, most likely — is left to the real pass to refuse, with its own error.
 */
async function batchKeys(
  accountId: string,
  events: readonly WhatsAppDataEvent[],
): Promise<readonly ConvexRecordKey[]> {
  const keys: ConvexRecordKey[] = [];
  const asked = new Set<string>();
  const note = (kind: RecordKind, id: string, messageId?: string): undefined => {
    const key = cacheKey(kind, id, messageId);
    if (asked.has(key)) return undefined;
    asked.add(key);
    keys.push({ kind, id, ...(messageId !== undefined && { messageId }) });
    return undefined;
  };
  try {
    await projectCurrentMirror(
      {
        account: async () => ({ accountId }),
        chat: async (chatId) => note("chat", chatId),
        contact: async (contactId) => note("contact", contactId),
        contactId: async (nativeId) => note("alias", nativeId),
        group: async (groupId) => note("group", groupId),
        message: async (chatId, messageId) => note("message", chatId, messageId),
        pendingUpdates: async (chatId, messageId) => {
          note("pendingUpdates", chatId, messageId);
          return [];
        },
      },
      accountId,
      events,
    );
  } catch {
    // Whatever this batch cannot do, the real pass does it too, and its error
    // is the one the caller should see.
  }
  return keys;
}

/**
 * The keyed reads the projection makes, answered from `held` when the batched
 * read already fetched them and one round trip at a time when it did not.
 *
 * @remarks
 * The map is not only about the round trip: a projection that read one key
 * twice and got two answers would be projecting against two states, which is
 * what the source-cursor check downstream assumes cannot have happened.
 */
function projectionRecords(
  calls: ConvexCalls,
  accountId: string,
  account: AccountRecord,
  held: Map<string, string | null>,
): CurrentMirrorRecords {
  const read = async (kind: RecordKind, id: string, messageId?: string): Promise<string | null> => {
    const key = cacheKey(kind, id, messageId);
    const seen = held.get(key);
    if (seen !== undefined) return seen;
    const value = await calls.query("record", {
      accountId,
      kind,
      id,
      ...(messageId !== undefined && { messageId }),
    });
    held.set(key, value);
    return value;
  };
  const record = async <T>(
    kind: "chat" | "contact" | "group" | "message",
    id: string,
    messageId?: string,
  ): Promise<T | undefined> => {
    const value = await read(kind, id, messageId);
    return value === null ? undefined : decode<T>(value);
  };
  return {
    account: async () => account,
    chat: (chatId) => record<ChatRecord>("chat", chatId),
    contact: (contactId) => record<ContactRecord>("contact", contactId),
    contactId: async (nativeId) => (await read("alias", nativeId)) ?? undefined,
    group: (groupId) => record<GroupRecord>("group", groupId),
    message: (chatId, messageId) => record<MessageRecord>("message", chatId, messageId),
    async pendingUpdates(chatId, messageId) {
      const value = await read("pendingUpdates", chatId, messageId);
      return value === null ? [] : decode(value);
    },
  };
}

function convexCredentialStore(calls: ConvexCalls, account: string): CredentialStore {
  return {
    read: (key) => calls.query("credentialRead", { account, key }),
    async write(entries) {
      await calls.mutation("credentialWrite", {
        account,
        entries: Object.entries(entries).map(([key, value]) => ({ key, value })),
      });
    },
    async clear() {
      await calls.mutation("credentialClear", { account });
    },
  };
}

function convexLeaseStore(calls: ConvexCalls): AccountLeaseStore {
  return {
    acquire: (accountId, holderId, ttlMs) =>
      calls.mutation("leaseAcquire", { accountId, holderId, ttlMs }),
    renew: (held, ttlMs) =>
      calls.mutation("leaseRenew", {
        accountId: held.accountId,
        holderId: held.holderId,
        fencingToken: held.fencingToken,
        ttlMs,
      }),
    release: (held) =>
      calls.mutation("leaseRelease", {
        accountId: held.accountId,
        holderId: held.holderId,
        fencingToken: held.fencingToken,
      }),
  };
}

/** One account's mirror, answered through one call surface. */
function view(calls: ConvexCalls, accountId: string): MirrorView {
  return {
    async snapshot() {
      const state = await calls.query("snapshot", { accountId });
      return {
        accountId,
        revision: state.revision,
        account: state.account === null ? { accountId } : decode<AccountRecord>(state.account),
        chats: state.chats.map((chat) => decode<ChatRecord>(chat)),
        contacts: state.contacts.map((contact) => decode<ContactRecord>(contact)),
        contactAliases: Object.fromEntries(
          state.aliases.map(({ nativeId, contactId }) => [nativeId, contactId]),
        ),
        groups: state.groups.map((group) => decode<GroupRecord>(group)),
      };
    },

    async messages(chatId, options) {
      const limit = validatePage(options);
      const before = options?.before;
      // One row past the page, so `nextBefore` is named only when an older
      // stored message really exists and following it never yields nothing.
      const page = await calls.query("messages", {
        accountId,
        chatId,
        limit: limit + 1,
        ...(before && { before: orderKey(before.timestamp, before.messageId) }),
      });
      const messages = page.messages.slice(0, limit).map((row) => decode<MessageRecord>(row));
      const last = page.messages.length > limit ? messages.at(-1) : undefined;
      return {
        accountId,
        chatId,
        revision: page.revision,
        messages,
        ...(last && { nextBefore: { timestamp: last.timestamp, messageId: last.messageId } }),
      };
    },
  };
}

function assertToken(fencingToken: number): void {
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 0)
    throw new RangeError(`fencingToken must be a non-negative integer, got ${fencingToken}`);
}

function convexDataStore(
  calls: ConvexCalls,
  consistent: () => Promise<ConvexCalls>,
): WhatsAppDataStore {
  /**
   * Writes commit in the order they were asked for.
   *
   * @remarks
   * A durable write is several round trips — read the state, project, commit —
   * and two of them interleaved would reach the deployment in whichever order
   * the network settled, so an acceptance issued before a claim could be
   * refused by it. That is not a race the caller can see or avoid: `accept` and
   * `claim` are the runtime's ordinary calls, and their order is the caller's
   * statement about what happened first. Reads are deliberately not in this
   * queue — a read that held writers back would make a conversation opening
   * stall the live session behind it (ADR-0030).
   */
  let writes: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.then(work, work);
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    accept: (accountId, events, fencingToken) =>
      serialize(async () => {
        assertToken(fencingToken);
        const ownedEvents: readonly WhatsAppDataEvent[] = structuredClone(events);
        const wanted = await batchKeys(accountId, ownedEvents);
        for (let attempt = 0; attempt < ACCEPT_ATTEMPTS; attempt += 1) {
          const state = await calls.query("begin", { accountId, keys: wanted });
          if (fencingToken < state.newestFencingToken)
            throw new StaleAccountClaimError(accountId, fencingToken, state.newestFencingToken);
          const account =
            state.account === null ? { accountId } : decode<AccountRecord>(state.account);
          const held = new Map(
            wanted.map((key, index) => [
              cacheKey(key.kind, key.id, key.messageId),
              state.records[index] ?? null,
            ]),
          );
          const projection = await projectCurrentMirror(
            projectionRecords(calls, accountId, account, held),
            accountId,
            ownedEvents,
          );
          // An observation the mirror already holds is appended -- it happened --
          // but takes no revision, so a replay produces no client update.
          const revision =
            projection.upserts.length === 0 &&
            projection.deletes.length === 0 &&
            projection.aliases.length === 0
              ? state.revision
              : state.revision + 1;
          const batch: AcceptedWhatsAppBatch = {
            accountId,
            seq: state.sourceSeq + 1,
            fromRevision: state.revision,
            revision,
            events: ownedEvents,
            patch: {
              accountId,
              fromRevision: state.revision,
              revision,
              upserts: projection.upserts,
              ...(projection.deletes.length > 0 && { deletes: projection.deletes }),
              ...(projection.aliases.length > 0 && { aliases: projection.aliases }),
            },
          };
          const committed = await calls.mutation("commit", {
            accountId,
            expectedSourceSeq: state.sourceSeq,
            fencingToken,
            seq: batch.seq,
            fromRevision: batch.fromRevision,
            revision: batch.revision,
            events: JSON.stringify(batch.events),
            patch: JSON.stringify(batch.patch),
            writes: projection.mutations.map(rowWrite),
          });
          if (committed.status === "stale")
            throw new StaleAccountClaimError(accountId, fencingToken, committed.currentToken);
          if (committed.status === "ok") return batch;
        }
        throw new Error(
          `WhatsApp account "${accountId}" could not accept a batch against a settled source cursor`,
        );
      }),

    claim: (accountId, fencingToken) =>
      serialize(async () => {
        assertToken(fencingToken);
        const claimed = await calls.mutation("claimAccount", { accountId, fencingToken });
        if (claimed.status !== "ok")
          throw new StaleAccountClaimError(accountId, fencingToken, claimed.currentToken);
      }),

    async read(accountId, fn) {
      return fn(view(await consistent(), accountId));
    },

    // Both are one Convex query, and one query is already one moment -- routing
    // them through `read` would buy a second client and nothing else.
    snapshot: (accountId) => view(calls, accountId).snapshot(),
    messages: (accountId, chatId, options) => view(calls, accountId).messages(chatId, options),

    async accepted(accountId, afterSeq, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError(`limit must be a positive integer, got ${limit}`);
      const rows = await calls.query("accepted", { accountId, afterSeq, limit });
      return rows.map((row) => ({
        accountId,
        seq: row.seq,
        fromRevision: row.fromRevision,
        revision: row.revision,
        events: decode<readonly WhatsAppDataEvent[]>(row.events),
        patch: decode<WhatsAppPatch>(row.patch),
      }));
    },
  };
}

/**
 * Open a Convex-backed backend for one account's credentials and every
 * account's durable state.
 *
 * @remarks
 * `accountId` names the account whose credentials this backend reads and
 * writes — the one capability scoped at construction, because it never learns
 * WhatsApp's shapes. Data, leases, and operations name their account per call.
 */
export function convexBackend(options: ConvexBackendOptions): ConvexBackend {
  const client = lazyConvexClient({ url: options.url, module: options.module ?? "whatsappd" });
  const close = (): Promise<void> => client.close();
  return {
    credentials: convexCredentialStore(client, options.accountId),
    data: convexDataStore(client, () => client.consistent()),
    leases: convexLeaseStore(client),
    media: options.media,
    operations: convexOperationStore(client),
    close,
    [Symbol.asyncDispose]: close,
  };
}
