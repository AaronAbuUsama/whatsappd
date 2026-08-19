/**
 * The tables one Convex deployment needs to hold WhatsApp Accounts.
 *
 * @remarks
 * Spread into the application's own `defineSchema` — the application owns its
 * schema file, so the adapter contributes tables rather than replacing it:
 *
 * ```ts
 * // convex/schema.ts
 * import { defineSchema } from "convex/server";
 * import { whatsappdTables } from "whatsappd/convex";
 *
 * export default defineSchema({ ...whatsappdTables, ...myOwnTables });
 * ```
 *
 * Every table names its account in a column and every index leads with it, so
 * no read can reach another account's rows by accident (ADR-0004). Records are
 * stored as the JSON the runtime already produces rather than as Convex
 * objects: an absent optional field has to stay absent through a round trip,
 * and a document shape that turned `undefined` into `null` would hand a
 * consumer a record the projection never wrote.
 *
 * @packageDocumentation
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions for every capability this backend provides. */
export const whatsappdTables = {
  /** Opaque credential entries — one row per `(account, key)`. */
  waAuth: defineTable({
    account: v.string(),
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["account", "key"]),

  /** One row per account: its mirror revision, source cursor, and claim. */
  waAccounts: defineTable({
    accountId: v.string(),
    revision: v.number(),
    sourceSeq: v.number(),
    newestFencingToken: v.number(),
    account: v.string(),
  }).index("by_account", ["accountId"]),

  /** The append-only Accepted Source Batch log (ADR-0014). */
  waBatches: defineTable({
    accountId: v.string(),
    seq: v.number(),
    fromRevision: v.number(),
    revision: v.number(),
    events: v.string(),
    patch: v.string(),
  }).index("by_seq", ["accountId", "seq"]),

  waChats: defineTable({
    accountId: v.string(),
    chatId: v.string(),
    data: v.string(),
  }).index("by_chat", ["accountId", "chatId"]),

  waContacts: defineTable({
    accountId: v.string(),
    contactId: v.string(),
    data: v.string(),
  }).index("by_contact", ["accountId", "contactId"]),

  /** Address Resolution: a delivered native id and the contact that owns it. */
  waContactAliases: defineTable({
    accountId: v.string(),
    nativeId: v.string(),
    contactId: v.string(),
  })
    .index("by_native", ["accountId", "nativeId"])
    .index("by_owner", ["accountId", "contactId"]),

  waGroups: defineTable({
    accountId: v.string(),
    groupId: v.string(),
    data: v.string(),
  }).index("by_group", ["accountId", "groupId"]),

  /**
   * Stored messages, plus the composite `order` key a page reads by.
   *
   * @remarks
   * A Stored Message Page is ordered by `(timestamp, messageId)` descending,
   * both parts required (ADR-0010). A Convex index range may only compare one
   * field, so a cursor spanning two columns cannot be expressed against
   * `["timestamp", "messageId"]` — the boundary would have to fall inside a
   * timestamp collision, which a history sync produces constantly. `order`
   * carries both parts in one lexicographically ordered string, so a single
   * `lt` reproduces the pair comparison exactly.
   */
  waMessages: defineTable({
    accountId: v.string(),
    chatId: v.string(),
    messageId: v.string(),
    timestamp: v.number(),
    order: v.string(),
    data: v.string(),
  })
    .index("by_message", ["accountId", "chatId", "messageId"])
    .index("by_page", ["accountId", "chatId", "order"]),

  /** Updates that arrived before the message they describe. */
  waPendingMessageUpdates: defineTable({
    accountId: v.string(),
    chatId: v.string(),
    messageId: v.string(),
    data: v.string(),
  }).index("by_message", ["accountId", "chatId", "messageId"]),

  /** The single-writer claim on one account (ADR-0009). */
  waAccountLeases: defineTable({
    accountId: v.string(),
    holderId: v.union(v.string(), v.null()),
    expiresAt: v.union(v.number(), v.null()),
    fencingCounter: v.number(),
  }).index("by_account", ["accountId"]),

  /** Durable receipts for requested side effects. */
  waOperations: defineTable({
    accountId: v.string(),
    operationId: v.string(),
    idempotencyKey: v.string(),
    /**
     * The canonical form of the submitted input, compared on a repeat
     * submission. It is stored beside the receipt rather than re-derived from
     * it because the comparison decides whether a retry is the same request or
     * a conflicting one, and that answer has to be reached inside the same
     * transaction the insert commits in.
     */
    canonicalInput: v.string(),
    sequence: v.number(),
    /** Monotonic within one receipt; the compare-and-set key for a write. */
    revision: v.number(),
    submittedAt: v.number(),
    operation: v.string(),
  })
    .index("by_operation", ["accountId", "operationId"])
    .index("by_idempotency", ["accountId", "idempotencyKey"])
    .index("by_sequence", ["accountId", "sequence"]),
};
