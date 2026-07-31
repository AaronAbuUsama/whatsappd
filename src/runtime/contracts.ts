/**
 * The backend capabilities the runtime persists through, the current-mirror
 * records it projects, and the frames a client consumes.
 *
 * @remarks
 * Credentials, WhatsApp data, the account lease, and media bytes are separate
 * contracts (ADR-0004). {@link WhatsAppBackend} groups them for convenience; it
 * does not merge them. Every durable method names its account explicitly — no
 * implementation may infer the account from insertion order, a message id, or
 * the current process.
 *
 * @packageDocumentation
 */
import type { PresenceUpdate, Status, WhatsAppAddress } from "../model/index.ts";
import type { MessageRef } from "../model/outbound.ts";
import type { CredentialStore } from "../ports.ts";
import type { WhatsAppEvent } from "../subscription.ts";

/**
 * The source events that may be durably accepted.
 *
 * @remarks
 * Connection and presence are excluded by type, not by a runtime filter:
 * replaying a stored `online` or `typing` would manufacture current state
 * (ADR-0014), so it must be impossible to hand one to a data store.
 */
export type WhatsAppDurableEvent = Exclude<WhatsAppEvent, { type: "connection" | "presence" }>;

/**
 * One observation offered to {@link WhatsAppDataStore.accept}.
 *
 * @remarks
 * It carries no account of its own. The account named in the `accept()` call is
 * the only scope, so an event can never disagree with the batch it arrives in
 * and no implementation has a second identifier to prefer by mistake.
 */
export interface WhatsAppDataEvent {
  /**
   * A stable identity for this observation, assigned by the caller.
   *
   * @remarks
   * It is what makes a retry after an ambiguous backend result distinguishable
   * from WhatsApp genuinely delivering the same thing twice. Without it a store
   * must either append a duplicate or discard a real repeated observation,
   * because an identical payload at an identical millisecond is not evidence of
   * either.
   */
  readonly eventId: string;
  /** When the runtime observed the event, as a millisecond epoch timestamp. */
  readonly observedAt: number;
  readonly event: WhatsAppDurableEvent;
}

/** One message in the current mirror. Identity is `(accountId, chatId, messageId)`. */
export interface MessageRecord {
  readonly accountId: string;
  readonly chatId: string;
  readonly messageId: string;
  /** The actual author's WhatsApp address (ADR-0001) — never the chat. */
  readonly sender: WhatsAppAddress;
  readonly fromMe: boolean;
  readonly timestamp: number;
  readonly kind: "text";
  readonly text: string;
}

/** One chat summary in the current mirror. Identity is `(accountId, chatId)`. */
export interface ChatRecord {
  readonly accountId: string;
  readonly chatId: string;
  readonly isGroup: boolean;
  readonly subject?: string;
  /** The newest message timestamp projected into this chat, or `0` when none. */
  readonly lastMessageAt: number;
}

/** A current-mirror record carried by a snapshot or a patch. */
export type MirrorRecord =
  | { readonly type: "chat"; readonly chat: ChatRecord }
  | { readonly type: "message"; readonly message: MessageRecord };

/**
 * The current mirror for one account at one revision.
 *
 * @remarks
 * ponytail: this slice puts every stored message in the snapshot. The target
 * shape is chat summaries plus stored `messages()` pages — that split arrives
 * with saved-message paging (#24), which is the first consumer that needs it.
 */
export interface WhatsAppSnapshot {
  readonly accountId: string;
  readonly revision: number;
  readonly chats: readonly ChatRecord[];
  readonly messages: readonly MessageRecord[];
}

/**
 * A contiguous current-mirror change (ADR-0011).
 *
 * @remarks
 * A consumer applies a patch only when `fromRevision` equals its own revision.
 * There are no deletes in this slice: nothing removes a mirror record until
 * revocation and scope-bounded replacement exist.
 */
export interface WhatsAppPatch {
  readonly accountId: string;
  readonly fromRevision: number;
  readonly revision: number;
  readonly upserts: readonly MirrorRecord[];
}

/**
 * One committed acceptance: the recorded source events, the projected patch,
 * and the revision the mirror ended at — all from one operation (ADR-0014).
 *
 * @remarks
 * Every accepted batch is appended, because a source observation is a fact
 * whether or not it moved current state. Two numbers therefore exist and are
 * not interchangeable:
 *
 * - `seq` is the append position and a source consumer's cursor. It advances
 *   for every batch.
 * - `revision` is the mirror version (ADR-0011) and advances only when the
 *   projection actually changed a record, so `revision === fromRevision` means
 *   the observation told the mirror nothing it did not already hold.
 *
 * Collapsing the two would force a choice between erasing distinct
 * observations from the source log and publishing client updates that change
 * nothing.
 */
export interface AcceptedWhatsAppBatch {
  readonly accountId: string;
  /** Append position in this account's source log; a source consumer's cursor. */
  readonly seq: number;
  readonly fromRevision: number;
  readonly revision: number;
  readonly events: readonly WhatsAppDataEvent[];
  readonly patch: WhatsAppPatch;
}

/** Durable WhatsApp state: the accepted source log and the current mirror. */
export interface WhatsAppDataStore {
  /**
   * Append the source events, project them into the current mirror, and stamp
   * the resulting revision as one operation.
   *
   * @param fencingToken - The writer's current {@link AccountLease} token. A
   * token below one this account has already accepted is a paused worker
   * resuming after its claim moved on, and is rejected (ADR-0009).
   * @returns The committed batch. Re-offering events that were already accepted
   * returns their original batch instead of appending a second copy, so a
   * retry after an ambiguous failure is safe.
   *
   * @throws {@link UnsupportedDurableEventError} when an event has no
   * projection yet, and {@link StaleAccountClaimError} for a superseded token —
   * in both cases nothing is appended and the revision does not move.
   */
  accept(
    accountId: string,
    events: readonly WhatsAppDataEvent[],
    fencingToken: number,
  ): Promise<AcceptedWhatsAppBatch>;

  /** Read the account's current mirror and its revision. */
  snapshot(accountId: string): Promise<WhatsAppSnapshot>;

  /** Read accepted source batches strictly after a consumer's own `seq`. */
  accepted(accountId: string, afterSeq: number): Promise<readonly AcceptedWhatsAppBatch[]>;
}

/** A single-writer claim on one account (ADR-0009). */
export interface AccountLease {
  readonly accountId: string;
  readonly holderId: string;
  /**
   * Monotonically increasing across every claim on this account; a stale
   * holder's durable writes are rejected by comparing it.
   *
   * @remarks
   * A number rather than an opaque id because ADR-0009 requires it to be
   * *ordered*: a store deciding whether a writer has been superseded has to
   * compare tokens, and string order would rank claim 10 below claim 9.
   */
  readonly fencingToken: number;
  readonly expiresAt: number;
}

/** The required single-writer capability. Two workers per account fail closed. */
export interface AccountLeaseStore {
  acquire(
    accountId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<{ acquired: true; lease: AccountLease } | { acquired: false; heldUntil: number }>;

  renew(
    lease: AccountLease,
    ttlMs: number,
  ): Promise<
    { renewed: true; lease: AccountLease } | { renewed: false; reason: "lost" | "expired" }
  >;

  release(lease: AccountLease): Promise<boolean>;
}

/** Durable media bytes, keyed idempotently by account and message (ADR-0015). */
export interface MediaStore {
  put(input: {
    accountId: string;
    message: MessageRef;
    kind: "image" | "video" | "audio" | "document" | "sticker";
    bytes: Uint8Array;
    mimetype?: string;
  }): Promise<{ ref: string; byteLength: number }>;
}

/**
 * A convenience grouping of one deployment's capabilities.
 *
 * @remarks
 * The capabilities stay independently replaceable: credentials may live in
 * libSQL while data lives in PocketBase. `credentials` is this account's
 * credential store — it is the one capability whose contract is account-scoped
 * at construction, because it never learns WhatsApp's shapes.
 */
export interface WhatsAppBackend {
  readonly credentials: CredentialStore;
  readonly data: WhatsAppDataStore;
  readonly leases: AccountLeaseStore;
  readonly media: MediaStore;
}

/** Thrown when a second runtime tries to open an account another one holds. */
export class AccountAlreadyClaimedError extends Error {
  readonly accountId: string;
  /** When the current claim expires, as a millisecond epoch timestamp. */
  readonly heldUntil: number;

  constructor(accountId: string, heldUntil: number) {
    super(`WhatsApp account "${accountId}" is already claimed until ${heldUntil}`);
    this.name = "AccountAlreadyClaimedError";
    this.accountId = accountId;
    this.heldUntil = heldUntil;
  }
}

/**
 * Thrown when a writer's claim on the account has already been superseded.
 *
 * @remarks
 * The case it exists for: a worker pauses past its lease TTL, another worker
 * claims the account, and the first resumes holding a buffered event. The lease
 * alone cannot stop that write — only the store comparing fencing tokens at the
 * acceptance boundary can (ADR-0009).
 */
export class StaleAccountClaimError extends Error {
  readonly accountId: string;
  readonly fencingToken: number;
  /** The newest token this account has accepted a write from. */
  readonly currentToken: number;

  constructor(accountId: string, fencingToken: number, currentToken: number) {
    super(
      `claim ${fencingToken} on WhatsApp account "${accountId}" was superseded by claim ${currentToken}`,
    );
    this.name = "StaleAccountClaimError";
    this.accountId = accountId;
    this.fencingToken = fencingToken;
    this.currentToken = currentToken;
  }
}

/**
 * Thrown when a durable event has no projection in this slice.
 *
 * @remarks
 * The initial slice accepts text messages only. Every other durable event
 * fails loudly here rather than being dropped on the way to storage: a silent
 * skip would report a mirror as current when it is missing changes.
 */
export class UnsupportedDurableEventError extends Error {
  constructor(what: string) {
    super(`${what} cannot be stored yet`);
    this.name = "UnsupportedDurableEventError";
  }
}

/**
 * A live connection observation and how long it stays current.
 *
 * @remarks
 * Connection Freshness: a client treats an expired observation, or one made
 * under a different {@link AccountLease}, as unavailable. It is never stored
 * and never hydrated as startup truth.
 */
export interface WhatsAppClientConnectionState {
  readonly status: Status;
  readonly observedAt: number;
  readonly expiresAt: number;
  /** The fencing token of the lease this observation was made under. */
  readonly fencingToken: number;
}

/** One frame of a {@link WhatsAppClient.watch} stream. */
export type WhatsAppClientFrame =
  | { readonly type: "snapshot"; readonly snapshot: WhatsAppSnapshot }
  | { readonly type: "patch"; readonly patch: WhatsAppPatch }
  | {
      readonly type: "presence";
      readonly presence: PresenceUpdate;
      /** Presence is ephemeral; after this instant it means nothing. */
      readonly expiresAt: number;
    }
  | { readonly type: "connection"; readonly state: WhatsAppClientConnectionState };

/** The backend-independent contract applications and React bindings consume. */
export interface WhatsAppClient {
  /**
   * Watch one account: a current snapshot first, then the changes that follow
   * it, each stamped with the revision it moves the mirror to.
   */
  watch(options?: { readonly signal?: AbortSignal }): AsyncIterable<WhatsAppClientFrame>;
}
