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
import type {
  ConversationSyncBatch,
  GroupParticipant,
  InboundMessage,
  MediaHandle,
  MediaMeta,
  MessageContext,
  MessageFlags,
  PresenceUpdate,
  ReceiptStatus,
  Status,
  Update,
  WhatsAppAddress,
} from "../model/index.ts";
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

/** Durable outcome of consuming a live media handle while it was usable. */
export type DurableMedia =
  | (MediaMeta & {
      readonly state: "stored";
      readonly ref: string;
      readonly byteLength: number;
    })
  | (MediaMeta & {
      readonly state: "failed";
      readonly reason: "download_failed" | "store_failed";
    });

type WithDurableMedia<Message> = Message extends { readonly media: MediaHandle }
  ? Omit<Message, "media"> & { readonly media: DurableMedia }
  : Message;

/** A normalized message safe to retain after its live media handle expires. */
export type DurableInboundMessage = WithDurableMedia<InboundMessage>;

/** A conversation-sync batch whose media handles have all been consumed. */
export type DurableConversationSyncBatch = Omit<ConversationSyncBatch, "messages"> & {
  readonly messages: readonly DurableInboundMessage[];
};

type EditUpdate = Extract<Update, { kind: "edit" }>;

/** A source update whose edited media carries durable state, never a live closure. */
export type DurableUpdate =
  | Exclude<Update, EditUpdate>
  | (Omit<EditUpdate, "message"> & { readonly message: DurableInboundMessage });

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
  | Extract<WhatsAppEvent, { type: "contact" | "group" }>
  | { readonly type: "message"; readonly message: DurableInboundMessage }
  | { readonly type: "conversation_sync"; readonly batch: DurableConversationSyncBatch }
  | { readonly type: "update"; readonly update: DurableUpdate }
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

interface MessageRecordBase {
  readonly accountId: string;
  readonly chatId: string;
  readonly messageId: string;
  /** The actual author's WhatsApp address (ADR-0001) — never the chat. */
  readonly sender: WhatsAppAddress;
  readonly ref: MessageRef;
  readonly fromMe: boolean;
  readonly timestamp: number;
  readonly pushName?: string;
  readonly context?: MessageContext;
  readonly flags?: MessageFlags;
  readonly receipts: readonly MessageReceipt[];
  readonly reactions: readonly MessageReaction[];
  readonly editedAt?: number;
}

export interface MessageReceipt {
  readonly subject: string;
  readonly status: ReceiptStatus;
  readonly by?: string;
  readonly at?: number;
}

export interface MessageReaction {
  readonly subject: string;
  readonly emoji: string;
  readonly by?: string;
  readonly at?: number;
}

/** One message in the current mirror. Identity is `(accountId, chatId, messageId)`. */
export type MessageRecord = MessageRecordBase &
  (
    | { readonly kind: "text"; readonly text: string }
    | {
        readonly kind: "image" | "video" | "audio" | "document" | "sticker";
        readonly media: DurableMedia;
        readonly text?: string;
      }
    | {
        readonly kind: "location";
        readonly lat: number;
        readonly lng: number;
        readonly name?: string;
        readonly address?: string;
      }
    | {
        readonly kind: "contacts";
        readonly contacts: readonly { readonly name?: string; readonly vcard: string }[];
      }
    | {
        readonly kind: "poll";
        readonly name: string;
        readonly options: readonly string[];
        readonly selectableCount: number;
      }
    | { readonly kind: "unsupported"; readonly rawType: string }
    | { readonly kind: "revoked"; readonly revokedAt?: number; readonly revokedBy?: string }
  );

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

/** A current-mirror identity removed because WhatsApp linked it to another record. */
export type MirrorDelete = { readonly type: "contact"; readonly contactId: string };

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
  /** Native PN/LID address to the contact record that owns it. */
  readonly contactAliases: Readonly<Record<string, string>>;
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
 * Deletes are identity-specific: currently only a contact record that WhatsApp
 * explicitly linked to another PN/LID form can be removed. Source observations
 * remain append-only; authoritative replacement still requires bounded scope.
 */
export interface WhatsAppPatch {
  readonly accountId: string;
  readonly fromRevision: number;
  readonly revision: number;
  readonly upserts: readonly MirrorRecord[];
  readonly deletes?: readonly MirrorDelete[];
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

/**
 * One account's current mirror, held at one revision (ADR-0030).
 *
 * @remarks
 * The same two reads {@link WhatsAppDataStore} offers directly, minus the
 * account — {@link WhatsAppDataStore.read} named it once, so nothing inside can
 * disagree with it. Every answer describes the mirror at one revision, however
 * many questions are asked and however many writes commit meanwhile.
 */
export interface MirrorView {
  snapshot(): Promise<WhatsAppSnapshot>;
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
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
   * @throws {@link UnsupportedDurableEventError} when an event kind is not
   * supported for durable acceptance, and {@link StaleAccountClaimError} for a
   * superseded token — in both cases nothing is appended and the revision does
   * not move. A supported source-only update is appended without a revision.
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

  /**
   * Answer any number of reads about one account at a single revision.
   *
   * @remarks
   * Opening a conversation needs both global state and that chat's newest page.
   * Taken as separate reads those arrive at two revisions, and the only
   * reconciliation available above the store is read-both-compare-retry, which
   * against a live write stream is unbounded and livelock-prone (ADR-0030).
   *
   * This exposes the transaction boundary both implementations already have
   * internally rather than adding a capability. `view` is the read seam for
   * the duration of `fn`, and the only one: the store's own methods open a
   * second, later read, which against a local libSQL file queues behind the
   * one waiting on this callback and does not return.
   */
  read<T>(accountId: string, fn: (view: MirrorView) => Promise<T>): Promise<T>;

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

  /**
   * Read a bounded page of accepted source batches strictly after a consumer's
   * own `seq`.
   *
   * @param limit - Maximum batches to return; defaults to 100.
   */
  accepted(
    accountId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<readonly AcceptedWhatsAppBatch[]>;
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

/** Durable media bytes, keyed idempotently by account, message, kind, and content (ADR-0015). */
export interface MediaStore {
  put(input: {
    accountId: string;
    message: MessageRef;
    kind: "image" | "video" | "audio" | "document" | "sticker";
    bytes: Uint8Array;
    mimetype?: string;
  }): Promise<{ ref: string; byteLength: number }>;

  read(input: { accountId: string; ref: string }): Promise<Uint8Array | null>;
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
 * Thrown when a durable event cannot yet be accepted safely in this slice.
 *
 * @remarks
 * Modeled source-only updates are accepted without moving the mirror revision.
 * Non-text messages, authoritative sync replacement, and unknown event kinds
 * still fail loudly rather than being dropped or falsely reported as current.
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
   * **Consumers apply both surfaces by record identity.** This method and the
   * message upserts on {@link WhatsAppClient.watch} are independent reads; the
   * client does not own or reconcile an application collection. Merge them on
   * `(chatId, messageId)` — the identity of {@link MessageRecord} — rather than
   * appending:
   *
   * - A message newer than an open cursor can only arrive as a patch. Paging
   *   older can never reach it, so it cannot be delivered twice.
   * - A message that sorts *below* an open cursor — a backdated send, a clock
   *   skew, the backfill of #25 — arrives as a patch and is also returned by
   *   the older page that now contains it. Both describe one record at one
   *   identity, so an upsert leaves one message; an append would leave two.
   * - Stored pages neither skip nor duplicate records because the cursor is a
   *   position in the ordering rather than an offset: a record inserted below
   *   it still falls inside the next page.
   *
   * {@link StoredMessagePage.revision} says which patches a page already
   * reflects, so the two surfaces can be ordered as well as merged.
   */
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
}
