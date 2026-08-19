/**
 * The Convex functions this backend calls, deployed by the application:
 *
 * ```ts
 * // convex/whatsappd.ts
 * export * from "whatsappd/convex";
 * ```
 *
 * @remarks
 * Everything here runs in the Convex runtime, which is not Node — so this
 * module imports no runtime code from `whatsappd`, whose Current Mirror
 * projection reaches for `node:crypto` and `node:util`. The division that
 * follows from that is the design: the projection runs in the Account Worker,
 * and each function here is one durable read or one atomic write.
 *
 * {@link commit} is where the two meet. It re-checks the source cursor the
 * projection was computed against, so a write built on a read that has since
 * been superseded is refused rather than applied, and the worker projects
 * again (ADR-0014, ADR-0018).
 *
 * @packageDocumentation
 */
import {
  defineSchema,
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v, type Infer } from "convex/values";
import { whatsappdTables } from "./convex-schema.ts";

const schema = defineSchema(whatsappdTables);
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type Reader = GenericQueryCtx<DataModel>["db"];
type Writer = GenericMutationCtx<DataModel>["db"];

// The generic builders are the only ones available without generated code, and
// they answer `GenericDataModel` — every table name a string, every document a
// bag. Naming the data model once here is what makes every handler below
// typed: `ctx.db.query("waChats")` knows its fields and its indexes, and a
// column renamed in `schema.ts` fails to compile rather than at runtime.
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const recordKind = v.union(
  v.literal("chat"),
  v.literal("contact"),
  v.literal("group"),
  v.literal("alias"),
  v.literal("message"),
  v.literal("pendingUpdates"),
);

/** One durable row write, translated by the worker from a projection mutation. */
const rowWrite = v.object({
  kind: v.union(recordKind, v.literal("account"), v.literal("contactDelete")),
  /** A chat, contact, group, or native id — the account is named by the call. */
  id: v.string(),
  messageId: v.optional(v.string()),
  timestamp: v.optional(v.number()),
  /** The `(timestamp, messageId)` page key. Message rows only. */
  order: v.optional(v.string()),
  /** Absent means delete, which only pending updates ever ask for. */
  data: v.optional(v.string()),
});

const accountRow = (db: Reader, accountId: string) =>
  db
    .query("waAccounts")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();

const chatRow = (db: Reader, accountId: string, chatId: string) =>
  db
    .query("waChats")
    .withIndex("by_chat", (q) => q.eq("accountId", accountId).eq("chatId", chatId))
    .unique();

const contactRow = (db: Reader, accountId: string, contactId: string) =>
  db
    .query("waContacts")
    .withIndex("by_contact", (q) => q.eq("accountId", accountId).eq("contactId", contactId))
    .unique();

const groupRow = (db: Reader, accountId: string, groupId: string) =>
  db
    .query("waGroups")
    .withIndex("by_group", (q) => q.eq("accountId", accountId).eq("groupId", groupId))
    .unique();

const aliasRow = (db: Reader, accountId: string, nativeId: string) =>
  db
    .query("waContactAliases")
    .withIndex("by_native", (q) => q.eq("accountId", accountId).eq("nativeId", nativeId))
    .unique();

const messageRow = (db: Reader, accountId: string, chatId: string, messageId: string) =>
  db
    .query("waMessages")
    .withIndex("by_message", (q) =>
      q.eq("accountId", accountId).eq("chatId", chatId).eq("messageId", messageId),
    )
    .unique();

const pendingRow = (db: Reader, accountId: string, chatId: string, messageId: string) =>
  db
    .query("waPendingMessageUpdates")
    .withIndex("by_message", (q) =>
      q.eq("accountId", accountId).eq("chatId", chatId).eq("messageId", messageId),
    )
    .unique();

const leaseRow = (db: Reader, accountId: string) =>
  db
    .query("waAccountLeases")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();

const operationRow = (db: Reader, accountId: string, operationId: string) =>
  db
    .query("waOperations")
    .withIndex("by_operation", (q) => q.eq("accountId", accountId).eq("operationId", operationId))
    .unique();

/**
 * Read one optional field of a row write, refusing rather than defaulting when
 * it is absent. The write shape is one object across eight kinds, so `data`,
 * `timestamp`, and `order` are optional in the validator and required by the
 * branch that uses them — a missing one is a worker bug, not a durable state.
 */
const text = (value: string | undefined, label: string): string => {
  if (value === undefined) throw new Error(`a ${label} row write needs data`);
  return value;
};

const number = (value: number | undefined, label: string): number => {
  if (value === undefined) throw new Error(`a row write needs a ${label}`);
  return value;
};

/** The message id a row write names, refused rather than defaulted when absent. */
function keyedMessage(write: { readonly messageId?: string }): string {
  if (write.messageId === undefined) throw new Error("a message row write needs a messageId");
  return write.messageId;
}

/** Create the account row on first touch, so every later write can patch it. */
async function accountFor(db: Writer, accountId: string) {
  const existing = await accountRow(db, accountId);
  if (existing) return existing;
  const id = await db.insert("waAccounts", {
    accountId,
    revision: 0,
    sourceSeq: 0,
    newestFencingToken: 0,
    account: JSON.stringify({ accountId }),
  });
  const created = await db.get(id);
  if (!created) throw new Error("the account row was not readable after its insert");
  return created;
}

/** Apply one projected row write. Every branch is an upsert keyed by identity. */
async function applyWrite(
  db: Writer,
  accountId: string,
  write: Infer<typeof rowWrite>,
): Promise<void> {
  const data = write.data;
  switch (write.kind) {
    case "account": {
      const row = await accountFor(db, accountId);
      await db.patch(row._id, { account: text(data, "account") });
      return;
    }
    case "contactDelete": {
      const row = await contactRow(db, accountId, write.id);
      if (row) await db.delete(row._id);
      return;
    }
    case "alias": {
      const row = await aliasRow(db, accountId, write.id);
      const contactId = text(data, "alias");
      if (row) await db.patch(row._id, { contactId });
      else await db.insert("waContactAliases", { accountId, nativeId: write.id, contactId });
      return;
    }
    case "pendingUpdates": {
      const messageId = keyedMessage(write);
      const row = await pendingRow(db, accountId, write.id, messageId);
      if (data === undefined) {
        if (row) await db.delete(row._id);
      } else if (row) await db.patch(row._id, { data });
      else
        await db.insert("waPendingMessageUpdates", {
          accountId,
          chatId: write.id,
          messageId,
          data,
        });
      return;
    }
    case "message": {
      const messageId = keyedMessage(write);
      const row = await messageRow(db, accountId, write.id, messageId);
      const fields = {
        timestamp: number(write.timestamp, "message timestamp"),
        order: text(write.order, "message order"),
        data: text(data, "message"),
      };
      if (row) await db.patch(row._id, fields);
      else await db.insert("waMessages", { accountId, chatId: write.id, messageId, ...fields });
      return;
    }
    case "chat": {
      const row = await chatRow(db, accountId, write.id);
      if (row) await db.patch(row._id, { data: text(data, "chat") });
      else await db.insert("waChats", { accountId, chatId: write.id, data: text(data, "chat") });
      return;
    }
    case "contact": {
      const row = await contactRow(db, accountId, write.id);
      if (row) await db.patch(row._id, { data: text(data, "contact") });
      else
        await db.insert("waContacts", {
          accountId,
          contactId: write.id,
          data: text(data, "contact"),
        });
      return;
    }
    case "group": {
      const row = await groupRow(db, accountId, write.id);
      if (row) await db.patch(row._id, { data: text(data, "group") });
      else await db.insert("waGroups", { accountId, groupId: write.id, data: text(data, "group") });
    }
  }
}

// ── Credentials ──

export const credentialRead = query({
  args: { account: v.string(), key: v.string() },
  handler: async (ctx, { account, key }) => {
    const row = await ctx.db
      .query("waAuth")
      .withIndex("by_key", (q) => q.eq("account", account).eq("key", key))
      .unique();
    return row ? row.value : null;
  },
});

export const credentialWrite = mutation({
  args: {
    account: v.string(),
    entries: v.array(v.object({ key: v.string(), value: v.union(v.string(), v.null()) })),
  },
  handler: async (ctx, { account, entries }) => {
    for (const entry of entries) {
      const row = await ctx.db
        .query("waAuth")
        .withIndex("by_key", (q) => q.eq("account", account).eq("key", entry.key))
        .unique();
      if (entry.value === null) {
        if (row) await ctx.db.delete(row._id);
      } else if (row) await ctx.db.patch(row._id, { value: entry.value });
      else await ctx.db.insert("waAuth", { account, key: entry.key, value: entry.value });
    }
    return null;
  },
});

export const credentialClear = mutation({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    const rows = await ctx.db
      .query("waAuth")
      .withIndex("by_key", (q) => q.eq("account", account))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

// ── Current Mirror reads ──

const recordKey = v.object({
  kind: recordKind,
  id: v.string(),
  messageId: v.optional(v.string()),
});

async function readRecord(
  db: Reader,
  accountId: string,
  { kind, id, messageId }: Infer<typeof recordKey>,
): Promise<string | null> {
  switch (kind) {
    case "alias":
      return (await aliasRow(db, accountId, id))?.contactId ?? null;
    case "message":
      return (await messageRow(db, accountId, id, keyedMessage({ messageId })))?.data ?? null;
    case "pendingUpdates":
      return (await pendingRow(db, accountId, id, keyedMessage({ messageId })))?.data ?? null;
    case "chat":
      return (await chatRow(db, accountId, id))?.data ?? null;
    case "contact":
      return (await contactRow(db, accountId, id))?.data ?? null;
    case "group":
      return (await groupRow(db, accountId, id))?.data ?? null;
  }
}

/** One keyed read behind the projection. `null` means no such record. */
export const record = query({
  args: {
    accountId: v.string(),
    kind: recordKind,
    id: v.string(),
    messageId: v.optional(v.string()),
  },
  handler: (ctx, { accountId, kind, id, messageId }) =>
    readRecord(ctx.db, accountId, { kind, id, ...(messageId !== undefined && { messageId }) }),
});

/**
 * Everything one acceptance is about to need, in one read.
 *
 * @remarks
 * The account's cursor and the records the projection will ask for, answered
 * together. Separately they are a round trip each, and acceptance is on the
 * live session's path: an event batch that took one round trip per record
 * touched would put a history sync's latency in the hundreds of milliseconds
 * and hold the runtime's acceptance boundary open for all of it.
 *
 * Answering them in one query also makes them one moment, so the cursor
 * `commit` checks describes the same state the records came from.
 */
export const begin = query({
  args: { accountId: v.string(), keys: v.array(recordKey) },
  handler: async (ctx, { accountId, keys }) => {
    const row = await accountRow(ctx.db, accountId);
    return {
      revision: row?.revision ?? 0,
      sourceSeq: row?.sourceSeq ?? 0,
      newestFencingToken: row?.newestFencingToken ?? 0,
      account: row?.account ?? null,
      records: await Promise.all(keys.map((key) => readRecord(ctx.db, accountId, key))),
    };
  },
});

export const snapshot = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const row = await accountRow(ctx.db, accountId);
    const [chats, contacts, aliases, groups] = await Promise.all([
      ctx.db
        .query("waChats")
        .withIndex("by_chat", (q) => q.eq("accountId", accountId))
        .collect(),
      ctx.db
        .query("waContacts")
        .withIndex("by_contact", (q) => q.eq("accountId", accountId))
        .collect(),
      ctx.db
        .query("waContactAliases")
        .withIndex("by_native", (q) => q.eq("accountId", accountId))
        .collect(),
      ctx.db
        .query("waGroups")
        .withIndex("by_group", (q) => q.eq("accountId", accountId))
        .collect(),
    ]);
    return {
      revision: row?.revision ?? 0,
      account: row?.account ?? null,
      chats: chats.map((entry) => entry.data),
      contacts: contacts.map((entry) => entry.data),
      aliases: aliases.map((entry) => ({ nativeId: entry.nativeId, contactId: entry.contactId })),
      groups: groups.map((entry) => entry.data),
    };
  },
});

export const messages = query({
  args: {
    accountId: v.string(),
    chatId: v.string(),
    before: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, { accountId, chatId, before, limit }) => {
    const row = await accountRow(ctx.db, accountId);
    const page = await ctx.db
      .query("waMessages")
      .withIndex("by_page", (q) => {
        const chat = q.eq("accountId", accountId).eq("chatId", chatId);
        return before === undefined ? chat : chat.lt("order", before);
      })
      .order("desc")
      .take(limit);
    return { revision: row?.revision ?? 0, messages: page.map((entry) => entry.data) };
  },
});

export const accepted = query({
  args: { accountId: v.string(), afterSeq: v.number(), limit: v.number() },
  handler: async (ctx, { accountId, afterSeq, limit }) => {
    const rows = await ctx.db
      .query("waBatches")
      .withIndex("by_seq", (q) => q.eq("accountId", accountId).gt("seq", afterSeq))
      .take(limit);
    return rows.map((row) => ({
      seq: row.seq,
      fromRevision: row.fromRevision,
      revision: row.revision,
      events: row.events,
      patch: row.patch,
    }));
  },
});

// ── Acceptance ──

export const claimAccount = mutation({
  args: { accountId: v.string(), fencingToken: v.number() },
  handler: async (ctx, { accountId, fencingToken }) => {
    const row = await accountFor(ctx.db, accountId);
    if (fencingToken < row.newestFencingToken)
      return { status: "stale" as const, currentToken: row.newestFencingToken };
    await ctx.db.patch(row._id, { newestFencingToken: fencingToken });
    return { status: "ok" as const, currentToken: fencingToken };
  },
});

/**
 * Append one Accepted Source Batch and the mirror rows it projected to.
 *
 * @remarks
 * `expectedSourceSeq` is the whole read-set check. Acceptance is the only
 * writer of mirror rows and it advances the source cursor on every batch, so a
 * cursor that still matches means every record the projection read is
 * unchanged. A mismatch answers `conflict`, and the worker projects again
 * against the newer state instead of overwriting it.
 */
export const commit = mutation({
  args: {
    accountId: v.string(),
    expectedSourceSeq: v.number(),
    fencingToken: v.number(),
    seq: v.number(),
    fromRevision: v.number(),
    revision: v.number(),
    events: v.string(),
    patch: v.string(),
    writes: v.array(rowWrite),
  },
  handler: async (ctx, args) => {
    const { accountId, fencingToken } = args;
    const row = await accountFor(ctx.db, accountId);
    if (fencingToken < row.newestFencingToken)
      return { status: "stale" as const, currentToken: row.newestFencingToken };
    if (row.sourceSeq !== args.expectedSourceSeq)
      return { status: "conflict" as const, currentToken: row.newestFencingToken };
    for (const write of args.writes) await applyWrite(ctx.db, accountId, write);
    await ctx.db.insert("waBatches", {
      accountId,
      seq: args.seq,
      fromRevision: args.fromRevision,
      revision: args.revision,
      events: args.events,
      patch: args.patch,
    });
    await ctx.db.patch(row._id, {
      revision: args.revision,
      sourceSeq: args.seq,
      newestFencingToken: Math.max(fencingToken, row.newestFencingToken),
    });
    return { status: "ok" as const, currentToken: fencingToken };
  },
});

// ── Account Lease ──

export const leaseAcquire = mutation({
  args: { accountId: v.string(), holderId: v.string(), ttlMs: v.number() },
  handler: async (ctx, { accountId, holderId, ttlMs }) => {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const row = await leaseRow(ctx.db, accountId);
    if (!row) {
      await ctx.db.insert("waAccountLeases", {
        accountId,
        holderId,
        expiresAt,
        fencingCounter: 1,
      });
      return {
        acquired: true as const,
        lease: { accountId, holderId, fencingToken: 1, expiresAt },
      };
    }
    if (row.holderId !== null && row.expiresAt !== null && row.expiresAt > now)
      return { acquired: false as const, heldUntil: row.expiresAt };
    const fencingCounter = row.fencingCounter + 1;
    await ctx.db.patch(row._id, { holderId, expiresAt, fencingCounter });
    return {
      acquired: true as const,
      lease: { accountId, holderId, fencingToken: fencingCounter, expiresAt },
    };
  },
});

export const leaseRenew = mutation({
  args: {
    accountId: v.string(),
    holderId: v.string(),
    fencingToken: v.number(),
    ttlMs: v.number(),
  },
  handler: async (ctx, { accountId, holderId, fencingToken, ttlMs }) => {
    const now = Date.now();
    const row = await leaseRow(ctx.db, accountId);
    const held = row !== null && row.holderId === holderId && row.fencingCounter === fencingToken;
    if (row && held && row.expiresAt !== null && row.expiresAt > now) {
      const expiresAt = now + ttlMs;
      await ctx.db.patch(row._id, { expiresAt });
      return { renewed: true as const, lease: { accountId, holderId, fencingToken, expiresAt } };
    }
    return { renewed: false as const, reason: held ? ("expired" as const) : ("lost" as const) };
  },
});

export const leaseRelease = mutation({
  args: { accountId: v.string(), holderId: v.string(), fencingToken: v.number() },
  handler: async (ctx, { accountId, holderId, fencingToken }) => {
    const row = await leaseRow(ctx.db, accountId);
    if (!row || row.holderId !== holderId || row.fencingCounter !== fencingToken) return false;
    await ctx.db.patch(row._id, { holderId: null, expiresAt: null });
    return true;
  },
});

// ── WhatsApp Operations ──

export const operationGet = query({
  args: { accountId: v.string(), operationId: v.string() },
  handler: async (ctx, { accountId, operationId }) => {
    const row = await operationRow(ctx.db, accountId, operationId);
    return { now: Date.now(), operation: row?.operation ?? null };
  },
});

export const operationList = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const rows = await ctx.db
      .query("waOperations")
      .withIndex("by_sequence", (q) => q.eq("accountId", accountId))
      .collect();
    return { now: Date.now(), operations: rows.map((row) => row.operation) };
  },
});

export const operationSubmit = mutation({
  args: {
    accountId: v.string(),
    operationId: v.string(),
    idempotencyKey: v.string(),
    input: v.string(),
    canonicalInput: v.string(),
  },
  handler: async (ctx, args) => {
    const { accountId, operationId, idempotencyKey } = args;
    const existing = await ctx.db
      .query("waOperations")
      .withIndex("by_idempotency", (q) =>
        q.eq("accountId", accountId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existing)
      return existing.canonicalInput === args.canonicalInput
        ? { status: "existing" as const, operation: existing.operation }
        : { status: "conflict" as const, operation: null };
    const at = Date.now();
    const last = await ctx.db
      .query("waOperations")
      .withIndex("by_sequence", (q) => q.eq("accountId", accountId))
      .order("desc")
      .first();
    const sequence = (last?.sequence ?? 0) + 1;
    const operation = JSON.stringify({
      accountId,
      id: operationId,
      idempotencyKey,
      revision: 0,
      sequence,
      input: JSON.parse(args.input) as unknown,
      state: { status: "queued" },
      submittedAt: at,
      updatedAt: at,
    });
    await ctx.db.insert("waOperations", {
      accountId,
      operationId,
      idempotencyKey,
      canonicalInput: args.canonicalInput,
      sequence,
      revision: 0,
      submittedAt: at,
      operation,
    });
    return { status: "created" as const, operation };
  },
});

/**
 * Write operation receipts the worker computed, all or none.
 *
 * @remarks
 * Every write names the revision it was computed from. A receipt that moved
 * meanwhile fails the whole batch, because recovering expired claims writes
 * several rows and half of that is not a state any reader should see.
 */
export const operationWrite = mutation({
  args: {
    accountId: v.string(),
    writes: v.array(
      v.object({
        operationId: v.string(),
        expectedRevision: v.number(),
        revision: v.number(),
        operation: v.string(),
      }),
    ),
  },
  handler: async (ctx, { accountId, writes }) => {
    const checked = [];
    for (const write of writes) {
      const row = await operationRow(ctx.db, accountId, write.operationId);
      if (!row || row.revision !== write.expectedRevision) return { status: "conflict" as const };
      checked.push({ id: row._id, write });
    }
    for (const { id, write } of checked)
      await ctx.db.patch(id, { revision: write.revision, operation: write.operation });
    return { status: "ok" as const };
  },
});
