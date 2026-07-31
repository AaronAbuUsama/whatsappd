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
import type { GroupParticipant, PresenceUpdate, Status, WhatsAppAddress } from "../model/index.ts";
import type { MessageRef } from "../model/outbound.ts";
import type { CredentialStore } from "../ports.ts";
import type { WhatsAppEvent } from "../subscription.ts";

/**
 * One durable timestamp derived from an ephemeral signal (ADR-0020).
 *
 * @remarks
 * *When* an address was last observed present, and *when* this account's
 * session last connected or disconnected, are facts that stay true. The
 * statuses they were derived from — `available`, `typing`, `online` — are not,
 * which is why neither reaches storage: these carry an instant and nothing
 * else, so no replay can restore a status as current.
 */
export type ObservedInstant =
  | {
      readonly type: "last_seen";
      /** The address observed present — a group's participant, not its chat. */
      readonly contactId: string;
      readonly at: number;
    }
  | {
      readonly type: "account_connection";
      readonly kind: "connected" | "disconnected";
      readonly at: number;
    };

/**
 * The source events that may be durably accepted.
 *
 * @remarks
 * Connection and presence are excluded by type, not by a runtime filter:
 * replaying a stored `online` or `typing` would manufacture current state
 * (ADR-0014), so it must be impossible to hand one to a data store. The
 * {@link ObservedInstant} a runtime derives from them carries no status at all
 * and is durable (ADR-0020).
 */
export type WhatsAppDurableEvent =
  | Exclude<WhatsAppEvent, { type: "connection" | "presence" }>
  | ObservedInstant;

/**
 * One observation offered to {@link WhatsAppDataStore.accept}.
 *
 * @remarks
 * It carries no account of its own. The account named in the `accept()` call is
 * the only scope, so an event can never disagree with the batch it arrives in
 * and no implementation has a second identifier to prefer by mistake.
 */
export interface WhatsAppDataEvent {
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

/** One contact in the current mirror. Identity is `(accountId, contactId)`. */
export interface ContactRecord {
  readonly accountId: string;
  readonly contactId: string;
  /** Every known equivalent native id WhatsApp delivered, primary id first. */
  readonly nativeIds: readonly string[];
  readonly displayName?: string;
  readonly profileName?: string;
  readonly verifiedName?: string;
  readonly username?: string;
  /** A URL, `null` when the contact has none, absent when never reported. */
  readonly imgUrl?: string | null;
  /**
   * The contact's own about/status text, when they published one.
   *
   * @remarks
   * Named `about` rather than `status` deliberately: `Status` is the connection
   * phase throughout this file, and a durable field called `status` on a mirror
   * record reads as exactly the thing ADR-0020 forbids storing.
   */
  readonly about?: string;
  /**
   * When this address was last observed present, as a millisecond epoch
   * timestamp; absent until one presence observation names it.
   *
   * @remarks
   * A historical instant, never a live state (ADR-0020). It says an address was
   * there at a time, and says nothing about now — the live
   * {@link WhatsAppClientFrame} presence frame is the only thing that does, and
   * it expires.
   */
  readonly lastSeenAt?: number;
}

/** One group in the current mirror. Identity is `(accountId, groupId)`. */
export interface GroupRecord {
  readonly accountId: string;
  readonly groupId: string;
  readonly subject?: string;
  readonly participants: readonly GroupParticipant[];
}

/**
 * One account's own durable state in the current mirror.
 *
 * @remarks
 * Connection *timestamps* only. There is deliberately no stored status: a
 * restored `online` is exactly the manufactured current state Connection
 * Freshness exists to prevent, while "this account was last connected at T"
 * stays true however old it gets (ADR-0020).
 */
export interface AccountRecord {
  readonly accountId: string;
  /** When this account's session was last observed online, as an epoch ms. */
  readonly lastConnectedAt?: number;
  /** When it was last observed disconnected or terminal, as an epoch ms. */
  readonly lastDisconnectedAt?: number;
}

/** A current-mirror record carried by a snapshot or a patch. */
export type MirrorRecord =
  | { readonly type: "account"; readonly account: AccountRecord }
  | { readonly type: "chat"; readonly chat: ChatRecord }
  | { readonly type: "contact"; readonly contact: ContactRecord }
  | { readonly type: "group"; readonly group: GroupRecord }
  | { readonly type: "message"; readonly message: MessageRecord };

/**
 * The Snapshot Window: one account's bounded current mirror at one revision.
 *
 * @remarks
 * Account state, chat summaries, contacts, and groups — and deliberately not a
 * message window per chat, whose size would grow with chats multiplied by
 * windows while a UI shows one conversation (ADR-0010). An opened chat reads
 * {@link WhatsAppDataStore.messages} instead.
 */
export interface WhatsAppSnapshot {
  readonly accountId: string;
  readonly revision: number;
  readonly account: AccountRecord;
  readonly chats: readonly ChatRecord[];
  readonly contacts: readonly ContactRecord[];
  readonly groups: readonly GroupRecord[];
}

/**
 * A stable position in one chat's stored messages (ADR-0010).
 *
 * @remarks
 * Ordering is `(timestamp, messageId)` descending, both parts required:
 * timestamps collide — a history sync commonly lands several messages on the
 * same second — and a page boundary that fell inside a collision would drop or
 * repeat whichever of them the storage engine happened to order second.
 */
export interface StoredMessageCursor {
  readonly timestamp: number;
  readonly messageId: string;
}

/** How much of one chat to read, and from where. */
export interface StoredMessagePageOptions {
  /** Read strictly older than this position. Omit for the newest page. */
  readonly before?: StoredMessageCursor;
  /**
   * How many messages to read, newest first.
   *
   * @remarks
   * A database page size, unrelated to the 50 that bounds a WhatsApp history
   * request (ADR-0010) — the two are separate reads and neither bounds the
   * other.
   *
   * @defaultValue `25`
   */
  readonly limit?: number;
}

/**
 * One Stored Message Page: messages already in the mirror, newest first.
 *
 * @remarks
 * Read from the backend alone. Nothing here contacts WhatsApp, so an exhausted
 * page is a statement about storage and never about WhatsApp (ADR-0010).
 */
export interface StoredMessagePage {
  readonly accountId: string;
  readonly chatId: string;
  /**
   * The mirror revision this page was read at.
   *
   * @remarks
   * The handle that orders this page against the patch stream: every change up
   * to and including this revision is already reflected here, so a consumer
   * knows which patches its open conversation has and has not absorbed. Same
   * number, same meaning, as {@link WhatsAppSnapshot.revision}.
   */
  readonly revision: number;
  readonly messages: readonly MessageRecord[];
  /**
   * Pass as `before` to read the next older page. Absent when nothing older is
   * *stored*.
   *
   * @remarks
   * Its absence never means WhatsApp has no more: an application may say that
   * no older messages are saved and that it can ask the linked phone, and may
   * not say that all history is loaded (ADR-0010). Present only when an older
   * stored message actually exists, so following it never yields an empty page.
   */
  readonly nextBefore?: StoredMessageCursor;
}

/**
 * A contiguous current-mirror change (ADR-0011).
 *
 * @remarks
 * A consumer applies a patch only when `fromRevision` equals its own revision.
 * There are no deletes: nothing removes a mirror record until revocation and
 * scope-bounded replacement exist, and the field arrives with the first thing
 * that produces one (ADR-0019, amending ADR-0011).
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
   * @returns The committed batch. Offering an observation the mirror already
   * holds appends it — it happened — but changes no record and takes no
   * revision, so a replayed message produces no client update.
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

  /**
   * Record the writer that now holds this account, before it writes anything.
   *
   * @remarks
   * Acceptance can only refuse a superseded writer if it knows a newer claim
   * exists. Learning that from writes alone leaves a window: between a
   * replacement worker acquiring the account and its first write, the previous
   * worker's buffered events would still be accepted. A worker therefore
   * announces its claim here as soon as it acquires the lease and before it
   * opens WhatsApp (ADR-0009, ADR-0018).
   *
   * @throws {@link StaleAccountClaimError} when this account has already moved
   * on to a newer claim.
   */
  claim(accountId: string, fencingToken: number): Promise<void>;

  /** Read the account's current mirror and its revision. */
  snapshot(accountId: string): Promise<WhatsAppSnapshot>;

  /**
   * Read one chat's stored messages, newest first.
   *
   * @remarks
   * The backend read behind an opened conversation, and behind scrolling it.
   * It never contacts WhatsApp; asking for older messages than WhatsApp has
   * delivered is a History Backfill Request, a different operation with a
   * phone dependency and an asynchronous result (ADR-0010).
   *
   * @throws {@link RangeError} when `limit` is not a positive integer.
   */
  messages(
    accountId: string,
    chatId: string,
    options?: StoredMessagePageOptions,
  ): Promise<StoredMessagePage>;

  /** Read accepted source batches strictly after a consumer's own `seq`. */
  accepted(accountId: string, afterSeq: number): Promise<readonly AcceptedWhatsAppBatch[]>;

  /**
   * Read this account's per-chat History Backfill Request progress.
   *
   * @remarks
   * Durable because the queue has to survive a restart without either losing
   * its place or re-hammering a phone it already backed off from (#25). It is
   * deliberately *not* a mirror record: nothing here is WhatsApp state a client
   * renders, and it takes no revision.
   *
   * @param dueBy - When given, only chats eligible at or before this instant,
   * soonest first — the queue's own read. Omit for every chat's progress.
   */
  historyProgress(accountId: string, dueBy?: number): Promise<readonly ChatHistoryProgress[]>;

  /**
   * Record what one History Backfill Request attempt learned.
   *
   * @remarks
   * Takes the writer's fencing token for the same reason `accept()` does: a
   * paused worker resuming after its claim moved on must not walk another
   * worker's queue backwards (ADR-0009, ADR-0018).
   *
   * @throws {@link StaleAccountClaimError} for a superseded token.
   */
  recordHistoryAttempt(
    accountId: string,
    progress: ChatHistoryProgress,
    fencingToken: number,
  ): Promise<void>;
}

/**
 * How far back one chat's stored history reaches, and when to ask again.
 *
 * @remarks
 * The queue's durable memory for one chat. `oldest` is the anchor a request is
 * made from; everything else exists so a restart resumes rather than restarts,
 * and so a phone that answers nothing is asked less often rather than in a loop
 * (ADR-0010).
 */
export interface ChatHistoryProgress {
  readonly accountId: string;
  readonly chatId: string;
  /**
   * The oldest WhatsApp message this chat has stored, and when it was sent.
   *
   * @remarks
   * The anchor a request asks from. Absent until the chat has stored a message
   * — a chat with nothing to anchor on cannot be requested from at all.
   */
  readonly oldest?: StoredMessageCursor;
  /** When this chat was last asked, as a millisecond epoch timestamp. */
  readonly lastAttemptAt?: number;
  /** When an attempt last actually stored something older. */
  readonly lastProgressAt?: number;
  /**
   * Consecutive attempts that stored nothing older.
   *
   * @remarks
   * The backoff input, and the honest name for what is being counted. It is
   * *not* evidence that WhatsApp has no more history: #18 proved a request can
   * be delivered to the phone and simply never answered, so a high count means
   * "asking is not working", never "the chat is exhausted" (ADR-0010).
   */
  readonly noProgressCount: number;
  /** The earliest instant this chat may be asked again. */
  readonly nextAttemptAt: number;
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
 * Thrown when a runtime acted on an account it does not hold a live claim on.
 *
 * @remarks
 * Distinct from {@link StaleAccountClaimError}, which the store raises when it
 * can see a newer claim. This one is what the holder itself can tell: the claim
 * was never taken, has passed its TTL, or was given back by a stop. Whether
 * someone else has taken the account over is unknown here — that answer lives at
 * the acceptance boundary.
 */
export class AccountNotHeldError extends Error {
  readonly accountId: string;
  /** Why the claim is not held, in the runtime's own terms. */
  readonly reason: "unclaimed" | "expired" | "stopped";

  constructor(accountId: string, reason: "unclaimed" | "expired" | "stopped", detail?: string) {
    super(
      `WhatsApp account "${accountId}" is not held by this runtime (${reason})${
        detail ? `: ${detail}` : ""
      }`,
    );
    this.name = "AccountNotHeldError";
    this.accountId = accountId;
    this.reason = reason;
  }
}

/**
 * Thrown when a durable event has no projection in this slice.
 *
 * @remarks
 * This slice projects text messages, the chats they belong to, contacts,
 * groups, and derived observation instants. Every other durable event — an
 * `update`, an authoritative sync replacement — fails loudly here rather than
 * being dropped on the way to storage: a silent skip would report a mirror as
 * current when it is missing changes.
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
 * and never hydrated as startup truth — {@link AccountRecord} keeps when the
 * account last connected, which is a different claim from being connected now.
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
  | { readonly type: "connection"; readonly state: WhatsAppClientConnectionState }
  | {
      /**
       * The runtime has stopped consuming this account. No frame follows it.
       *
       * @remarks
       * Without it a runtime that died — a dead socket, a storage failure that
       * stopped processing — is indistinguishable from a quiet account, and a
       * watch would suspend for ever waiting on an update that cannot come.
       */
      readonly type: "closed";
      /** The failure that ended it, absent when it was stopped deliberately. */
      readonly error?: unknown;
    };

/** The backend-independent contract applications and React bindings consume. */
export interface WhatsAppClient {
  /**
   * Watch one account: a current Snapshot Window first, then the changes that
   * follow it, each stamped with the revision it moves the mirror to.
   */
  watch(options?: { readonly signal?: AbortSignal }): AsyncIterable<WhatsAppClientFrame>;

  /**
   * Read one opened chat's stored messages, newest first, then older pages
   * from the returned cursor.
   *
   * @remarks
   * A snapshot carries no message window, so this is how a conversation is
   * filled (ADR-0010). It reads storage only — see
   * {@link WhatsAppDataStore.messages}.
   *
   * **Both surfaces are applied by record identity.** A conversation is fed by
   * this method *and* by the message upserts on {@link WhatsAppClient.watch},
   * and the two are reconciled on `(chatId, messageId)` — the identity of
   * {@link MessageRecord} — never by appending. That is what makes "no
   * duplicate, no skip" hold rather than depending on arrival order:
   *
   * - A message newer than an open cursor can only arrive as a patch. Paging
   *   older can never reach it, so it cannot be delivered twice.
   * - A message that sorts *below* an open cursor — a backdated send, a clock
   *   skew, the backfill of #25 — arrives as a patch and is also returned by
   *   the older page that now contains it. Both describe one record at one
   *   identity, so an upsert leaves one message; an append would leave two.
   * - Nothing is ever skipped, because the cursor is a position in the ordering
   *   rather than an offset: a record inserted below it still falls inside the
   *   next page.
   *
   * {@link StoredMessagePage.revision} says which patches a page already
   * reflects, so the two surfaces can be ordered as well as merged.
   */
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
}
