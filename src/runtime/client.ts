/**
 * The friendly Client's core: one account's synchronized application state.
 *
 * @remarks
 * An application awaits one factory and reads named domain state. It never sees
 * a frame, a snapshot, a patch, a revision, a cursor, a lease or an expiring
 * observation — reconciling those is this module's whole job (ADR-0023).
 *
 * Two decisions shape everything here, and both are structural rather than
 * remembered. All state a transition affects is mutated through one
 * {@link commit} that is not `async`, so nothing — no application callback, no
 * timer, no concurrent read — can interleave inside a transition and
 * "committed before notified" is a property of the type signature rather than
 * a rule re-established at each publication site (ADR-0029). And live state is
 * derived rather than committed: the Client retains the observation and the
 * claim it was made under, and every read computes the current value from that
 * pair and one instant, so expiry is never a transition and no timer is ever a
 * source of correctness (ADR-0028).
 *
 * @packageDocumentation
 */
import type { PresenceKind } from "../model/presence.ts";
import type { Status, WaIdentity } from "../model/status.ts";
import type { Unsubscribe } from "../subscription.ts";
import type {
  AccountRecord,
  ChatRecord,
  ContactRecord,
  GroupRecord,
  MessageRecord,
  StoredMessageCursor,
  StoredMessagePage,
  RuntimeDurableFrame,
  RuntimeLiveFrame,
  CurrentMirrorPatch,
  CurrentMirrorSnapshot,
} from "./contracts.ts";
import {
  clientSourceFor,
  fanout,
  surface,
  type ClientClaim,
  type WhatsAppRuntime,
} from "./runtime.ts";
import { type MediaOutbound, type WhatsAppOperation } from "./operations.ts";
import { createClientSend, type ClientSendOptions } from "./client-operations.ts";
export type { ClientOperationOptions, ClientSendOptions } from "./client-operations.ts";

/**
 * Order two WhatsApp identifiers by code unit.
 *
 * @remarks
 * One comparison, routed through by every ordered read, because the one defect
 * class in the retired Client that never recurred was closed exactly this way:
 * a value-level primitive every future call site is forced through, rather than
 * an instruction to remember. `localeCompare` is what it exists to exclude — it
 * disagrees with the stores' binary ordering, so two backends would list one
 * account's chats in two different orders.
 */
const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Freeze a value and everything reachable from it.
 *
 * @remarks
 * Frozen before its members are visited, so a cycle terminates rather than
 * recurring; already-frozen values are left alone, which also makes re-owning a
 * value free.
 */
function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const member of Object.values(value)) freeze(member);
  return value;
}

/**
 * Take a private, immutable copy of a value crossing into Client state.
 *
 * @remarks
 * Ownership is decided by memory provenance rather than by API visibility: a
 * record reached this Client through a frame or a store read, and neither
 * promises the Client is the only holder. Copying answers "can a caller still
 * change what we committed"; freezing answers "can a reader change what we
 * hand back". Doing both once, here, is what lets every read return the stored
 * value directly instead of cloning on the hot path a listener runs on.
 */
const own = <T>(value: T): T => freeze(structuredClone(value));

/** One retained live observation and the claim that made it trustworthy. */
interface Observation<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly claim: ClientClaim;
}

/**
 * Everything outside committed state that a read derives an answer from.
 *
 * @remarks
 * Every member changes without a transition — the clock by moving, the claim
 * when the lease is renewed or given back, the identity when a session attaches
 * or detaches, `following` when this Client stops — so all of them are sampled
 * together, once, and handed to every listener in the delivery.
 *
 * ADR-0028 names the instant because the clock is the axis issue #71 argued
 * about, but its requirement is the general one: *"a deadline crossing during
 * fanout cannot split one transition into two observed values"*. Threading only
 * the instant satisfies the letter and not the property — a listener may stop
 * the Runtime or close the Client, both permitted by ADR-0029 rule 1, and both
 * change what a later listener in the same fanout would otherwise read.
 */
interface Derivation {
  readonly at: number;
  readonly claim: ClientClaim | undefined;
  readonly identity: WaIdentity | undefined;
  /** Whether the Client is still following, and so still has live truth. */
  readonly following: boolean;
}

/**
 * Whether a retained observation is still something to report.
 *
 * @remarks
 * Deliberately at module scope, closed over nothing. This is the difference
 * between the one defect class in issue #71 that never recurred and the one
 * that recurred nineteen times: a rule saying "derive only from the sampled
 * basis" has to be re-obeyed at every future edit, while a function that has no
 * other variable in scope cannot disobey it. Reaching a new input therefore
 * *requires* adding it to {@link Derivation}, which is the one place it can be
 * sampled once per delivery — the compiler enforces what a comment could only
 * ask for.
 *
 * An observation is trustworthy only under the claim that produced it, and no
 * longer than the earlier of its own deadline and that claim's: it cannot
 * outlive the single-writer claim that made it true, and a claim that has moved
 * to another holder never made it (ADR-0009, ADR-0028). A Client that has
 * stopped following has none at all — it keeps its durable records, because a
 * chat that existed still existed, but it can no longer receive the
 * `unavailable` or the disconnection that would end an observation, so anything
 * still held would read as current with nothing able to falsify it.
 */
function current<T>(observation: Observation<T> | undefined, from: Derivation): T | undefined {
  if (!observation || !from.following) return undefined;
  const { at, claim } = from;
  if (!claim || claim.fencingToken !== observation.claim.fencingToken) return undefined;
  return at < observation.expiresAt && at < claim.expiresAt ? observation.value : undefined;
}

/**
 * The Client's domain namespaces — and the unit a transition marks affected.
 *
 * @remarks
 * The list defines the type, not the other way round. Annotating the array as
 * `readonly Namespace[]` would let a wider union type-check against a shorter
 * array, and the shorter array is what `replace()` iterates to mark everything
 * a fresh snapshot affected — so a namespace added to the union alone would
 * silently stop recovering after a dropped revision. Derived, it cannot happen.
 */
const NAMESPACES = ["account", "chats", "contacts", "groups", "messages"] as const;

type Namespace = (typeof NAMESPACES)[number];

/**
 * One chat's retained messages, as the Client holds them.
 *
 * @remarks
 * Declared here beside {@link ClientAccountState} because these are the
 * friendly Client's own public vocabulary, not Backend adapter contracts.
 */
export interface ClientChatMessages {
  readonly chatId: string;
  /**
   * Newest first, ties broken by *descending* identifier.
   *
   * @remarks
   * The tie-break matches both stores' page order — `ORDER BY timestamp DESC,
   * message_id DESC` at `libsql.ts:1308`, `newestFirst` at `memory.ts:57`. The
   * ascending tie-break `chats.list()` uses is wrong here: it would disagree
   * with the page boundary at every timestamp collision, so `nextBefore` — the
   * last row in store order — would not be the last row in this order.
   */
  readonly messages: readonly MessageRecord[];
  /**
   * Whether the local mirror can still go further back.
   *
   * @remarks
   * `"exhausted"` means only that no older row is *stored*. It never means the
   * phone has no older history, which is a separate request (ADR-0010).
   */
  readonly older: "stored" | "loading" | "exhausted";
  /** The last read that failed. Cleared by the next success. */
  readonly error?: unknown;
}

/**
 * One chat's retained messages as this Client actually stores them.
 *
 * @remarks
 * At module scope so {@link Tx} can name it, and because the entry object's
 * *identity* is what orders a page read against a revision gap: `replace()`
 * clears the map, so a page taken at the pre-gap revision finds a different
 * object — or none — and commits nothing. A number would have to say which
 * revision the page belonged to, and `StoredMessagePage.revision` is the
 * mirror's revision rather than a statement about the rows it returned
 * (`contracts.ts:337-343`).
 */
interface Retained {
  readonly chatId: string;
  /** Keyed by messageId. Every value has been through {@link own}. */
  readonly byId: Map<string, MessageRecord>;
  /** Where the next older page starts. Absent before the first read AND at the end. */
  before?: StoredMessageCursor;
  /** Which of those two `before === undefined` means, plus whether a read is running. */
  older: "stored" | "loading" | "exhausted";
  /**
   * The last read that failed, boxed and stored BY IDENTITY.
   *
   * @remarks
   * Never `own()`ed. Ledger class C4 proves `structuredClone` throws
   * `DOMException` on an error carrying a function, and that throw would happen
   * inside `commit` — costing the whole transition for a failure already
   * observed. Boxed rather than held bare, and spread into the view exactly as
   * `closure` is, so a failure whose cause *is* `undefined` still reports the
   * key.
   */
  failure?: { readonly error: unknown };
  /**
   * This chat's frozen view, dropped by the writer that changed THIS chat.
   *
   * @remarks
   * Per chat rather than through `touch("messages")`, which is namespace-wide:
   * clearing there would drop every chat's view on any messages transition and
   * defeat the referential stability a `useSyncExternalStore` binding needs.
   */
  view?: ClientChatMessages;
}

/**
 * One subscription — a record, never the callback itself.
 *
 * @remarks
 * Registering one function twice owes two deliveries, and unsubscribing then
 * resubscribing it during a fanout owes both effects. A `Set` keyed by the
 * callback can express neither (ADR-0013).
 *
 * Every namespace's subscriptions share one set, tagged rather than separated,
 * and that is what makes rules 2 and 3 hold *between* namespaces as well as
 * within one. A transition commonly affects several — one conversation-sync
 * batch reaches chats, contacts and groups — and with a set each, membership
 * would be copied once per namespace: a listener reached early could then add a
 * listener to a namespace the same delivery had not got to yet, and that
 * listener would run inside the transition it was supposed to start after. One
 * set makes the copy delivery-wide by construction instead of by remembering to
 * take it in the right place.
 */
interface Registration {
  readonly namespace: Namespace;
  readonly notify: () => void;
}

/**
 * What became of one chat's page read.
 *
 * @remarks
 * Every way a read can end is a member here, so ending one is a *total*
 * function rather than four call sites each remembering to leave the entry
 * somewhere sensible. Two defects came from it not being one: a `close()`
 * mid-read and a throw while applying a page each left a chat saying
 * `"loading"` for ever, describing a read nothing could finish and `older()`
 * would not restart.
 */
type PageLanding =
  | { readonly started: true; readonly ended?: undefined }
  | { readonly ended: true; readonly started?: undefined }
  | { readonly page: StoredMessagePage; readonly started?: undefined; readonly ended?: undefined }
  | { readonly error: unknown; readonly started?: undefined; readonly ended?: undefined };

/** A read has begun. */
const STARTED: PageLanding = Object.freeze({ started: true });
/** A read is over with no result, because this Client stopped following. */
const ENDED: PageLanding = Object.freeze({ ended: true });

/** How a transition mutates Client state. The only way anything here changes. */
interface Tx {
  /** Replace all durable state with a Snapshot Window's. */
  replace(snapshot: CurrentMirrorSnapshot): void;
  /** Apply one contiguous change: upserts, deletes, and the aliases between. */
  apply(patch: CurrentMirrorPatch): void;
  /** Retain one live observation under the claim it was made under. */
  observe(frame: RuntimeLiveFrame, claim: ClientClaim): void;
  /**
   * Move one chat's page read to whatever became of it.
   *
   * @remarks
   * One member taking a total {@link PageLanding} rather than several, so a
   * chat's paging state moves only here, and every path re-checks that the
   * entry it was started against is still the entry the map holds.
   */
  page(entry: Retained, landing: PageLanding): void;
  /**
   * Stop following, and end every page read in flight with it.
   *
   * @remarks
   * One writer rather than two lines to line up at each site, because they are
   * one fact: once nothing follows, no page read can land, so a chat left
   * saying `"loading"` describes a read that will never finish and that
   * `older()` will not restart. `following = false` on its own is now greppable
   * and wrong — class C10 applied rather than restated.
   *
   * Inside `commit` rather than beside it. Ending a read changes what
   * `messages.get()` reports, so a reader that only re-reads when notified —
   * `useSyncExternalStore`, the binding this namespace is shaped for — has to
   * be told. Writing it beside `commit` corrected the value and delivered
   * nothing, which left the spinner it exists to clear on exactly the consumers
   * that cannot poll.
   */
  stopped(): void;
  /** Record that the Runtime has stopped consuming this account. */
  close(frame: Extract<RuntimeDurableFrame, { type: "closed" }>): void;
}

/** One account's own state: what is durable, what is live, and what it links. */
export interface ClientAccountState {
  readonly accountId: string;
  /** When this account was last observed online, as an epoch ms. */
  readonly lastConnectedAt?: number;
  /** When it was last observed disconnected or terminal, as an epoch ms. */
  readonly lastDisconnectedAt?: number;
  /**
   * The live connection status, while it is still current.
   *
   * @remarks
   * Absent once the observation or the Account Lease it was made under has
   * expired, or once the account has moved to another claim. Never restored
   * from storage: `lastConnectedAt` says when this account was last online,
   * which is a different claim from being online now (ADR-0020, ADR-0028).
   */
  readonly connection?: Status;
  /** The linked account's own identity, while a session is attached. */
  readonly identity?: WaIdentity;
  /**
   * This Client will never report a change again. Nothing follows it.
   *
   * @remarks
   * Set when the Runtime stopped consuming the account — deliberately or on the
   * failure that ended it — and also when following itself failed in a way the
   * Runtime's terminal frame could not describe, such as a mirror read that
   * failed during gap recovery. Reporting only the first would leave the second
   * indistinguishable from a quiet account, which is the condition Runtime
   * Closure exists to make impossible.
   *
   * The two are **deliberately not distinguished**, and the response to both is
   * the same: this Client is finished, so make another one. `await
   * createWhatsAppClient(runtime)` recovers a follow failure outright, and on a
   * closed Runtime it resolves against the mirror with `closed` set again — so
   * an application that simply recreates is correct either way without having
   * to branch. `error` says why, and is absent when the stop was deliberate.
   *
   * Calling {@link WhatsAppClient.close} does *not* set this: the
   * application asked for that and does not need to be told.
   */
  readonly closed: boolean;
  /**
   * The failure behind it, absent when the Runtime stopped deliberately.
   *
   * @remarks
   * Handed out by identity rather than copied, so a caller can compare it
   * against the cause it already holds.
   */
  readonly error?: unknown;
}

/** Options every Client subscription accepts. */
export interface ClientSubscribeOptions {
  readonly signal?: AbortSignal;
}

/**
 * Observe one namespace.
 *
 * @remarks
 * The listener is called after every transition that changed this namespace,
 * with the transition fully committed. It takes no argument deliberately: it
 * reads whatever it needs from the Client, so it can never be handed a value
 * staler than the state a sibling listener would read.
 *
 * The contract is closed, and each clause is a primitive rather than an
 * ordering (ADR-0029):
 *
 * 1. listeners run after the transition is fully committed and may read any
 *    Client state, including re-entrantly;
 * 2. membership is snapshotted before delivery, so subscribing during one takes
 *    effect on the next transition;
 * 3. unsubscribing during a delivery takes effect immediately, including
 *    unsubscribing a *different* listener that has not been reached yet;
 * 4. a throwing listener is surfaced asynchronously, remains subscribed, and
 *    affects neither Client state nor its siblings;
 * 5. every listener in one delivery derives live state from one instant, so a
 *    deadline crossing mid-fanout cannot split one transition into two observed
 *    values.
 */
export interface ClientNamespace {
  subscribe(listener: () => void, options?: ClientSubscribeOptions): Unsubscribe;
}

/** One account's synchronized application state. */
export interface WhatsAppClient {
  readonly account: ClientNamespace & {
    get(): ClientAccountState;
  };
  readonly chats: ClientNamespace & {
    /** Newest activity first, then by identifier. */
    list(): readonly ChatRecord[];
  };
  readonly contacts: ClientNamespace & {
    /** By identifier. */
    list(): readonly ContactRecord[];
    /** The contact a native PN or LID address belongs to (ADR-0022). */
    resolve(nativeId: string): ContactRecord | undefined;
    /**
     * What an address is doing right now, while the observation is current.
     *
     * @remarks
     * Never `"unavailable"`: that is not an observation that decays but a
     * statement that the address is gone, so its subject is removed at once.
     */
    presence(nativeId: string): PresenceKind | undefined;
  };
  readonly groups: ClientNamespace & {
    /** By identifier. */
    list(): readonly GroupRecord[];
  };
  readonly operations: {
    get(operationId: string): Promise<WhatsAppOperation | undefined>;
    subscribe(
      operationId: string,
      listener: (operation: WhatsAppOperation) => void,
      options?: ClientSubscribeOptions,
    ): Unsubscribe;
  };
  /**
   * One chat's saved messages, its live upserts, and how far back it can go.
   *
   * @remarks
   * Nothing here is opened, owned or closed: a chat is read by id and extended
   * backwards by id. The subscription is namespace-wide, like every other, so a
   * listener watching one chat wakes when any chat changes — and re-reads an
   * identical frozen view, which a React consumer bails out of without
   * rendering.
   */
  readonly messages: ClientNamespace & {
    readonly send: {
      text(chatId: string, text: string, options?: ClientSendOptions): Promise<WhatsAppOperation>;
      media(
        chatId: string,
        content: MediaOutbound,
        options?: ClientSendOptions,
      ): Promise<WhatsAppOperation>;
    };
    /**
     * What is held for one chat. Never touches storage.
     *
     * @remarks
     * Creates an empty entry when none exists. That is a mutation on a read
     * path, which is unusual here and permitted because it marks no namespace,
     * notifies nobody and cannot split a delivery — and required, because a
     * `useSyncExternalStore` binding on a chat nobody has paged must be handed
     * a stable object or it re-renders for ever.
     *
     * From that moment the chat accumulates its live traffic, so what is
     * retained grows with the chats an application has read rather than with
     * the account's traffic. An eviction policy is #121.
     */
    get(chatId: string): ClientChatMessages;
    /**
     * Read one page further back than what is held.
     *
     * @remarks
     * With nothing held that is the newest page, so this is also how a chat is
     * first filled. Returns nothing: the result lands as an ordinary transition
     * and the caller re-reads, exactly as {@link ClientNamespace.subscribe}
     * already works. Single-flight per chat, and after a failure calling it
     * again *is* the retry. The page size is the store default and is not a
     * parameter — an application wanting a hundred calls this four times.
     *
     * Re-paging from inside a `messages` subscriber is a real hazard rather
     * than a style preference: a failed read returns `older` to `"stored"` and
     * wakes every listener, so "empty and `stored` implies page again" wired to
     * the notification that a read just failed retries without bound. Page from
     * a render or an effect, or track `error` and back off.
     *
     * A no-op once this Client has stopped following, which covers both
     * {@link WhatsAppClient.close} and a durable-follow failure. That is
     * **not** the same condition as `account.get().closed`: a deliberate
     * Runtime `closed` frame leaves this Client following, so paging still
     * works against storage after Runtime closure — correct under ADR-0010,
     * because a stored page never contacts WhatsApp.
     */
    older(chatId: string): void;
  };
  /**
   * Release this Client's subscriptions and stop following the Runtime.
   *
   * @remarks
   * Idempotent, and joins. It does not stop an application-owned Runtime or
   * close an application-owned Backend: each resource is closed by the layer
   * that created it (ADR-0023).
   */
  close(): Promise<void>;
}

/**
 * Create one account's Client over the Runtime that owns it.
 *
 * @param runtime - A runtime from `createWhatsAppRuntime()`, started or not.
 * @returns A Client whose account, chats, contacts and groups are already
 * hydrated — resolving *is* the guarantee that the initial durable snapshot has
 * been applied, which is why there is no `ready()` and no observable
 * empty-before-hydration state.
 *
 * @throws {@link TypeError} when `runtime` did not come from this module, and
 * therefore has no private source to read.
 *
 * @example
 * ```ts
 * const client = await createWhatsAppClient(runtime);
 * client.chats.list();
 * const off = client.chats.subscribe(() => render(client.chats.list()));
 * ```
 */
export async function createWhatsAppClient(runtime: WhatsAppRuntime): Promise<WhatsAppClient> {
  const registered = clientSourceFor.get(runtime);
  if (!registered)
    throw new TypeError(
      "createWhatsAppClient() requires a runtime created by createWhatsAppRuntime()",
    );
  const source = registered;

  let record: AccountRecord = { accountId: runtime.accountId };
  const chats = new Map<string, ChatRecord>();
  const contacts = new Map<string, ContactRecord>();
  /** Native PN/LID address to the contact record that owns it. */
  const aliases = new Map<string, string>();
  const groups = new Map<string, GroupRecord>();
  /** Each chat an application has read, and what is held for it. */
  const retained = new Map<string, Retained>();
  let connection: Observation<Status> | undefined;
  let closure: { readonly error?: unknown } | undefined;

  const listeners = new Set<Registration>();
  /** Each live subscription's release, so closing detaches its signal too. */
  const releases = new Set<Unsubscribe>();

  /**
   * Each namespace's ordered read, rebuilt when a transition changed it.
   *
   * @remarks
   * Not an optimization of the sort but of its identity: a binding that re-reads
   * on every notification — React's external store is the one this exists for —
   * needs a list that is referentially equal until something actually changed.
   */
  const ordered: {
    chats?: readonly ChatRecord[];
    contacts?: readonly ContactRecord[];
    groups?: readonly GroupRecord[];
    /**
     * Never held: messages memoize per chat inside {@link Retained}, because a
     * namespace-wide cache would be dropped by any chat's traffic.
     *
     * @remarks
     * Declared rather than omitted so `touch`'s keyed `delete` still type-checks
     * across every non-`account` namespace. A second `if` there would be exactly
     * the per-namespace branch the comment above it exists to forbid.
     */
    messages?: never;
  } = {};

  /** This Client's copy of whatever identity the session currently reports. */
  let identityCopy: WaIdentity | undefined;
  /**
   * Copy an identity, reusing the last copy while it still says the same thing.
   *
   * @remarks
   * Compared by value rather than by reference, because the live session builds
   * a fresh object on every call (`src/baileys/socket.ts`) — a reference check
   * would miss every time, deep-copying on the read path `own()` exists to keep
   * clear of, and handing a binding a different object on every read.
   */
  const owned = (identity: WaIdentity | undefined): WaIdentity | undefined => {
    if (identity === undefined) return undefined;
    const held = identityCopy;
    if (
      held?.jid !== identity.jid ||
      held.pushName !== identity.pushName ||
      held.phoneE164 !== identity.phoneE164
    )
      // Rebuilt from the declared fields rather than `own()`ed. This is the one
      // value entering Client state that a `structuredClone` has not already
      // vetted — every other arrives through `deliver()`, which cloned it — and
      // it is sampled between committing a transition and announcing it, where
      // a throw would cost the delivery outright. An application session may
      // return anything; copying exactly the contract cannot fail.
      identityCopy = Object.freeze({
        jid: identity.jid,
        ...(identity.pushName !== undefined && { pushName: identity.pushName }),
        ...(identity.phoneE164 !== undefined && { phoneE164: identity.phoneE164 }),
      });
    return identityCopy;
  };

  /** Whether this Client is still following, and so still has live truth. */
  let following = true;

  const sample = (): Derivation => ({
    at: Date.now(),
    claim: source.currentClaim(),
    identity: owned(source.identity()),
    following,
  });

  /** The basis this delivery derives from, while one is running. */
  let delivery: Derivation | undefined;
  const basis = (): Derivation => delivery ?? sample();

  /**
   * Every address that speaks for one subject: the id itself, then the other
   * native forms of the contact it belongs to.
   *
   * @remarks
   * One function, and both the presence read and the `unavailable` removal are
   * routed through it. They were written separately once — the read spanning a
   * contact's forms while the removal keyed the delivered address alone — and a
   * `gone` naming a consolidated contact's LID then left its PN observation
   * answering `typing` with nothing able to end it. "Resolve the subject the
   * same way on both paths" is an instruction; one function they both call is
   * the primitive (ADR-0022, ADR-0030).
   */
  const formsOf = (nativeId: string): readonly string[] => {
    const contactId = aliases.get(nativeId);
    const contact = contactId === undefined ? undefined : contacts.get(contactId);
    if (!contact) return [nativeId];
    return contact.nativeIds.includes(nativeId)
      ? contact.nativeIds
      : [nativeId, ...contact.nativeIds];
  };

  /**
   * Live presence, keyed by the address WhatsApp used and answered by contact.
   *
   * @remarks
   * The map is unreachable from outside these three operations, which is the
   * point: reading and forgetting go through {@link formsOf} because there is
   * no way to reach the entries without it. Written as two call sites once,
   * they diverged — the read spanned a contact's native forms and the removal
   * keyed only the delivered address, so a `gone` naming one form left the
   * other reporting `typing` with nothing able to end it. Resolving inside the
   * primitive is what stops that being expressible (ADR-0022, ADR-0030).
   *
   * `retain` deliberately keys by the delivered address: a presence carries no
   * Address Resolution evidence of its own, and an address with no contact
   * record yet must still have somewhere to live (ADR-0020).
   *
   * ponytail: an expired entry is filtered at read but never evicted, because
   * expiry is not a transition (ADR-0028) and no moment exists to sweep at.
   * Growth is one small entry per address ever seen active — bounded by the
   * contacts and participants this Client already holds in full. Sweep on a
   * contacts transition if a long-lived account ever makes it matter.
   */
  const presence = (() => {
    /**
     * Each retained observation, and the arrival that produced it.
     *
     * @remarks
     * Ordered by arrival rather than by `expiresAt`. Two observations of one
     * peer commonly land in the same millisecond — going idle in a 1:1 and
     * typing in a group, in one batch — and `expiresAt` is the observation
     * instant plus a constant, so it cannot separate them. A counter can, and
     * it is what "newest" has to mean here regardless of clock resolution.
     */
    const held = new Map<string, { readonly at: number; readonly of: Observation<PresenceKind> }>();
    let arrivals = 0;
    return {
      /**
       * What this subject is doing now, across every form of its contact.
       *
       * @remarks
       * The newest current observation wins, not the first form in the
       * contact's list. WhatsApp names the chat in a 1:1 and the participant in
       * a group, so one peer is observed under its PN on one occasion and its
       * LID on another — and going idle in a 1:1 then typing in a group is a
       * *sequence*, not a contradiction. Answering in `nativeIds` order reported
       * the superseded value for a whole freshness window, and made the delivery
       * that announced the change report the state before it.
       *
       * `expiresAt` is the observation instant plus one runtime-constant
       * freshness, so it orders two observations of one peer exactly as their
       * arrival did.
       */
      read(subject: string, from: Derivation): PresenceKind | undefined {
        let newest: { readonly at: number; readonly of: Observation<PresenceKind> } | undefined;
        for (const form of formsOf(subject)) {
          const entry = held.get(form);
          if (!entry || current(entry.of, from) === undefined) continue;
          if (!newest || entry.at > newest.at) newest = entry;
        }
        return newest?.of.value;
      },
      retain(subject: string, observation: Observation<PresenceKind>): void {
        arrivals += 1;
        held.set(subject, { at: arrivals, of: observation });
      },
      /** Forget every form of this subject. True when anything was held. */
      release(subject: string): boolean {
        let removed = false;
        for (const form of formsOf(subject)) removed = held.delete(form) || removed;
        return removed;
      },
    };
  })();

  /**
   * This chat's entry, created empty if it has none.
   *
   * @remarks
   * One of the few mutations outside `commit` — with {@link viewOf}'s memo,
   * `owned()`'s identity copy and `subscribeTo`'s registration — and it is
   * deliberate: it marks no
   * namespace, notifies nobody and cannot split a delivery, because an entry
   * nothing has been put into yet reads exactly as no entry would. What it buys
   * is that `get()` on a never-paged chat is referentially stable, and that
   * `older()` has somewhere for the patches arriving *during* its read to land
   * — without which the drop rule would discard exactly the changes that repair
   * the page it is about to commit.
   */
  const entryFor = (chatId: string): Retained => {
    const held = retained.get(chatId);
    if (held) return held;
    const fresh: Retained = { chatId, byId: new Map(), older: "stored" };
    retained.set(chatId, fresh);
    return fresh;
  };

  /**
   * One chat's frozen view, rebuilt only when that chat changed.
   *
   * @remarks
   * Frozen shallowly: every member of `byId` was deep-frozen by `own()` on the
   * way in, and `failure` is spread by identity rather than copied.
   */
  const viewOf = (entry: Retained): ClientChatMessages =>
    (entry.view ??= Object.freeze({
      chatId: entry.chatId,
      messages: Object.freeze(
        [...entry.byId.values()].sort(
          // Note the argument order: `b, a` is descending, matching both
          // stores' page order rather than `chats.list()`'s ascending tie.
          (a, b) => b.timestamp - a.timestamp || compareId(b.messageId, a.messageId),
        ),
      ),
      older: entry.older,
      // Spread rather than tested, so a read that failed with `undefined` still
      // reports the key — the same shape `closure` uses below.
      ...entry.failure,
    }));

  /**
   * Mutate every value one transition affects, then notify once.
   *
   * @remarks
   * Not `async`, and that is the whole guarantee: a function that cannot await
   * cannot yield to the event loop, so no application callback and no
   * concurrent read can observe a half-applied transition, and there is exactly
   * one notification point per transition rather than one per mutation site.
   */
  function commit(mutate: (tx: Tx) => void): void {
    const touched = new Set<Namespace>();
    const touch = (namespace: Namespace): void => {
      touched.add(namespace);
      // Keyed rather than a branch per namespace, so adding one cannot leave
      // its ordered read stale behind an `if` nobody extended.
      if (namespace !== "account") delete ordered[namespace];
    };

    /**
     * The only writers in this Client, and they exist only in here.
     *
     * @remarks
     * Storing a value used to be four things a person had to line up by hand at
     * each of eleven sites: the right container, the copy that makes it ours,
     * the announcement, and the announcement naming the same namespace as the
     * container. Any one of those forgotten still compiles, still passes, and
     * fails silently in front of an application — a list that stops updating,
     * or a record a caller can reach into.
     *
     * Bound together here, none of them is a thing to remember. And because
     * these are built per transaction rather than held on the Client, there is
     * nothing to call from outside one: mutating outside a transaction stops
     * being a mistake that can be made rather than one that is discouraged.
     */
    const put = {
      account: (account: AccountRecord): void => {
        record = own(account);
        touch("account");
      },
      chat: (chat: ChatRecord): void => {
        chats.set(chat.chatId, own(chat));
        touch("chats");
      },
      contact: (contact: ContactRecord): void => {
        contacts.set(contact.contactId, own(contact));
        touch("contacts");
      },
      group: (group: GroupRecord): void => {
        groups.set(group.groupId, own(group));
        touch("groups");
      },
      alias: (nativeId: string, contactId: string): void => {
        aliases.set(nativeId, contactId);
        touch("contacts");
      },
      /**
       * Store one message, if the application ever asked for its chat.
       *
       * @remarks
       * A message for a chat with no entry is dropped. Without that, what is
       * held would grow with the account's *traffic* rather than with what the
       * application read, and a busy account would retain every chat it has
       * never shown. The rows are still in the mirror, so reading the chat
       * later pages them back.
       *
       * No fill rule here, deliberately: a patch is the newer statement about
       * an id by construction, and refusing one because a page had already put
       * that id in the buffer is exactly the stranding the retired per-entry
       * watermark produced.
       */
      message: (message: MessageRecord): void => {
        const entry = retained.get(message.chatId);
        if (!entry) return;
        entry.byId.set(message.messageId, own(message));
        entry.view = undefined;
        touch("messages");
      },
      /**
       * Start, land or fail one chat's page read.
       *
       * @remarks
       * Every path re-checks entry identity first. `replace()` clears
       * `retained`, so a page taken at the pre-gap revision finds a different
       * object here and commits nothing rather than layering stale rows onto
       * fresh state.
       *
       * What that check actually buys is narrower than it looks, and saying so
       * is the point: because `reset()` clears the whole map, the captured
       * entry is already unreachable from `retained`, so a stale page could not
       * be read back through `get()` even without this line. What it prevents
       * is the *delivery* — marking the namespace and waking every listener for
       * a transition that changed nothing anyone can observe. Tracer 11.5
       * asserts the absence of that delivery, because asserting the chat is
       * empty passes with this line deleted.
       */
      page: (entry: Retained, landing: PageLanding): void => {
        if (retained.get(entry.chatId) !== entry) return;
        if (landing.started) entry.older = "loading";
        else if (landing.ended) {
          // The read is over without a result — this Client stopped following,
          // so nothing can land and `older()` will not restart it. Only a chat
          // actually mid-read changes, so a Client with none of them announces
          // nothing.
          if (entry.older !== "loading") return;
          entry.older = "stored";
        } else if ("error" in landing) {
          // What was already held, and where the next page starts, both
          // survive: a failure is not evidence about the mirror's contents.
          // Back to `"stored"` because calling `older()` again is the retry.
          entry.failure = landing;
          entry.older = "stored";
        } else {
          // Everything that can throw runs *before* the first mutation, so a
          // row this Client cannot take ownership of fails the whole page and
          // leaves the entry exactly as it was — retryable, and still holding
          // what it held. Half-applying it and then reporting a read failure
          // over the top was how a single unclonable row bricked a chat.
          //
          // The fill rule: a page may only *insert*. A read in flight can then
          // never be wrong about an id the buffer already holds — only
          // insufficient — so a live upsert that landed while it was running is
          // never overwritten by the older copy it was reading. The chat check
          // beside it is the adapter boundary: `WhatsAppDataStore` is a
          // published contract an application may implement, and rows for
          // another chat would otherwise be read back under this chat's id.
          const fresh = landing.page.messages
            .filter(
              (message) => message.chatId === entry.chatId && !entry.byId.has(message.messageId),
            )
            .map(own);
          entry.failure = undefined;
          for (const message of fresh) entry.byId.set(message.messageId, message);
          entry.before = landing.page.nextBefore;
          // `nextBefore` is present only when an older stored row really
          // exists, so its absence is the end of the mirror — and never a
          // statement about WhatsApp (ADR-0010).
          entry.older = landing.page.nextBefore ? "stored" : "exhausted";
        }
        entry.view = undefined;
        touch("messages");
      },
      connection: (observation: Observation<Status>): void => {
        connection = observation;
        touch("account");
      },
      presence: (subject: string, observation: Observation<PresenceKind>): void => {
        presence.retain(subject, observation);
        touch("contacts");
      },
      /**
       * Record that nothing will follow. Once only; the first cause is the one.
       *
       * @remarks
       * The single writer that deliberately does *not* copy what it stores. The
       * Runtime hands a terminal error out by identity so a caller can compare
       * it against the cause it already holds, and copying would both break that
       * and throw outright on an error carrying a function — which would lose
       * the very failure being reported.
       */
      closed: (frame: Extract<RuntimeDurableFrame, { type: "closed" }>): void => {
        if (closure) return;
        closure = "error" in frame ? { error: frame.error } : {};
        touch("account");
      },
    };

    const drop = {
      /** Remove a contact and the native ids the patch says it freed. */
      contact: (contactId: string, freed: readonly string[]): void => {
        for (const nativeId of freed) aliases.delete(nativeId);
        contacts.delete(contactId);
        touch("contacts");
      },
      presence: (subject: string): void => {
        if (presence.release(subject)) touch("contacts");
      },
    };

    /** Forget everything durable, so a snapshot replaces rather than merges. */
    const reset = (): void => {
      chats.clear();
      contacts.clear();
      aliases.clear();
      groups.clear();
      // A remembered line, exactly like the four above it: the loop below
      // *notifies*, it does not clear. A snapshot carries no messages
      // (ADR-0010), so a chat that kept its buffer across a gap would hold rows
      // from a revision this Client no longer has, behind a cursor pointing
      // into the middle of a mirror it no longer holds the front of.
      retained.clear();
      for (const namespace of NAMESPACES) touch(namespace);
    };

    mutate({
      replace(snapshot) {
        reset();
        put.account(snapshot.account);
        for (const chat of snapshot.chats) put.chat(chat);
        for (const contact of snapshot.contacts) put.contact(contact);
        for (const [nativeId, contactId] of Object.entries(snapshot.contactAliases))
          put.alias(nativeId, contactId);
        for (const group of snapshot.groups) put.group(group);
      },

      apply(patch) {
        for (const upsert of patch.upserts) {
          switch (upsert.type) {
            case "account":
              put.account(upsert.account);
              break;
            case "chat":
              put.chat(upsert.chat);
              break;
            case "contact":
              put.contact(upsert.contact);
              break;
            case "group":
              put.group(upsert.group);
              break;
            case "message":
              put.message(upsert.message);
              break;
          }
        }
        for (const removed of patch.deletes ?? []) {
          // What the delete freed is named by the patch, or read from the very
          // record being removed. Neither is a scan of every contact, which is
          // what maintaining Address Resolution from patches exists to avoid
          // (ADR-0030). Dropping them keeps the alias map from retaining an
          // entry per consolidation for ever; the aliases below then re-point
          // every one of them, which is why deletes are applied first.
          drop.contact(
            removed.contactId,
            removed.freedNativeIds ?? contacts.get(removed.contactId)?.nativeIds ?? [],
          );
        }
        for (const alias of patch.aliases ?? []) put.alias(alias.nativeId, alias.contactId);
      },

      observe(frame, claim) {
        if (frame.type === "connection") {
          put.connection({
            value: own(frame.state.status),
            expiresAt: frame.state.expiresAt,
            claim,
          });
          return;
        }
        // In a group WhatsApp names the participant and in a 1:1 the chat is
        // the peer, so the subject is the address that was present — the same
        // address the runtime records the durable last-seen instant against.
        const subject = frame.presence.participant ?? frame.presence.chatId;
        if (frame.presence.kind === "unavailable") {
          // Not an observation that decays: it says the address is gone now, so
          // its subject goes now rather than at some later deadline.
          drop.presence(subject);
          return;
        }
        put.presence(subject, {
          value: frame.presence.kind,
          expiresAt: frame.expiresAt,
          claim,
        });
      },

      page(entry, landing) {
        put.page(entry, landing);
      },

      stopped() {
        following = false;
        for (const entry of retained.values()) put.page(entry, ENDED);
      },

      close(frame) {
        put.closed(frame);
      },
    });

    if (touched.size === 0) return;
    // One derivation basis for the whole delivery, sampled after the transition
    // is closed and restored afterwards, so a read outside any delivery samples
    // afresh as it always would.
    //
    // Reused rather than re-sampled when one is already running, because
    // `messages.older()` commits synchronously and a listener may legitimately
    // call it (ADR-0029 rule 1). Sampling afresh made the nested delivery
    // observe a *later* instant and then restored the earlier one for the rest
    // of the outer fanout — so a sibling listener saw a presence expire, come
    // back, and expire again with no live frame in between. A nested commit is
    // part of the same synchronous burst, and ADR-0028's requirement is that
    // one burst cannot split into two observed values.
    const outer = delivery;
    delivery = outer ?? sample();
    try {
      // One fanout for the whole transition rather than one per namespace: the
      // membership copy has to span every namespace this transition affected,
      // or a listener reached under the first could still add or remove one
      // under the second.
      fanout(listeners, (listener) => {
        if (touched.has(listener.namespace)) listener.notify();
      });
    } finally {
      delivery = outer;
    }
  }

  const subscribeTo =
    (namespace: Namespace) =>
    (listener: () => void, options?: ClientSubscribeOptions): Unsubscribe => {
      const signal = options?.signal;
      if (signal?.aborted) return () => {};
      const registration: Registration = { namespace, notify: listener };
      const off = (): void => {
        listeners.delete(registration);
        releases.delete(off);
        signal?.removeEventListener("abort", off);
      };
      listeners.add(registration);
      releases.add(off);
      signal?.addEventListener("abort", off, { once: true });
      return off;
    };

  const client: WhatsAppClient = {
    account: {
      subscribe: subscribeTo("account"),
      get() {
        const from = basis();
        const status = current(connection, from);
        // A fresh view each call, deliberately. Unlike the three ordered reads
        // this cannot be memoized against a transition, because it derives from
        // the clock and an expiry is not a transition (ADR-0028) — so a value
        // that stayed referentially equal would have to be compared field by
        // field on every read to know whether it still holds. Caching a
        // snapshot for a binding is `@whatsappd/react`'s job under ADR-0023,
        // which owns selectors and hooks, and React is a declared non-goal of
        // this layer. What is *not* deferred is the cost: `identity` is copied
        // once and reused, so this allocates one small object and clones
        // nothing.
        return Object.freeze({
          accountId: runtime.accountId,
          ...(record.lastConnectedAt !== undefined && { lastConnectedAt: record.lastConnectedAt }),
          ...(record.lastDisconnectedAt !== undefined && {
            lastDisconnectedAt: record.lastDisconnectedAt,
          }),
          ...(status !== undefined && { connection: status }),
          ...(from.identity !== undefined && { identity: from.identity }),
          closed: closure !== undefined,
          // Spread rather than tested, so a deliberate stop reports no `error`
          // key at all and a failure that *was* `undefined` still reports one.
          ...closure,
        });
      },
    },

    chats: {
      subscribe: subscribeTo("chats"),
      list: () =>
        (ordered.chats ??= Object.freeze(
          [...chats.values()].sort(
            (a, b) => b.lastMessageAt - a.lastMessageAt || compareId(a.chatId, b.chatId),
          ),
        )),
    },

    contacts: {
      subscribe: subscribeTo("contacts"),
      list: () =>
        (ordered.contacts ??= Object.freeze(
          [...contacts.values()].sort((a, b) => compareId(a.contactId, b.contactId)),
        )),
      resolve(nativeId) {
        const contactId = aliases.get(nativeId);
        return contactId === undefined ? undefined : contacts.get(contactId);
      },
      presence(nativeId) {
        return presence.read(nativeId, basis());
      },
    },

    groups: {
      subscribe: subscribeTo("groups"),
      list: () =>
        (ordered.groups ??= Object.freeze(
          [...groups.values()].sort((a, b) => compareId(a.groupId, b.groupId)),
        )),
    },

    operations: {
      get: (operationIdValue) => source.operation(operationIdValue),
      subscribe(operationIdValue, listener, options) {
        const signal = options?.signal;
        if (signal?.aborted) return () => {};
        let off: Unsubscribe = () => {};
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          off();
          releases.delete(release);
          signal?.removeEventListener("abort", release);
        };
        releases.add(release);
        signal?.addEventListener("abort", release, { once: true });
        off = source.onOperation(operationIdValue, listener);
        if (released) off();
        return release;
      },
    },

    messages: {
      subscribe: subscribeTo("messages"),
      send: createClientSend(source),
      get: (chatId) => viewOf(entryFor(chatId)),
      older(chatId) {
        // Nothing to page against, and nothing that could ever announce the
        // result: a Client that has stopped following makes no further
        // delivery. Checked before the entry is created, so a call after
        // `close()` does not even allocate.
        if (!following) return;
        const entry = entryFor(chatId);
        // The single-flight guard and the end of the mirror are the same test,
        // because both mean "this call has no page to fetch". There is no
        // in-flight promise to hold: `older()` returns `void` and `close()`
        // deliberately does not join a page read, so nothing could await one.
        if (entry.older !== "stored") return;
        commit((tx) => tx.page(entry, STARTED));
        // Re-checked after that commit, not only before it: the commit fanouts
        // synchronously, and a listener may call `close()` inside it (ADR-0029
        // rule 1) — which would otherwise let this issue a read against a
        // Backend the application already owns the closing of (ADR-0023).
        // `tx.stopped()` has already ended the read this just started.
        if (!following) return;
        void (async () => {
          let landing: PageLanding;
          try {
            landing = {
              page: await source.read((view) =>
                view.messages(chatId, entry.before && { before: entry.before }),
              ),
            };
          } catch (error) {
            landing = { error };
          }
          // One landing, one commit, and no way out of here without one: a
          // Client that stopped following has already had this read ended for
          // it, and every other exit — a page, a failed read, or a throw while
          // *applying* a page — leaves the entry retryable rather than claiming
          // to be loading with nothing able to finish it. Applying it is what
          // can still throw, and `put.page` does its owning before its first
          // mutation so a page this Client cannot take owns nothing.
          if (!following) return;
          try {
            commit((tx) => tx.page(entry, landing));
          } catch (error) {
            // Not a failed read, but the load has still ended. Reported as the
            // failure it is so the chat is retryable and the application can
            // see why, rather than left mid-transition and silent.
            commit((tx) => tx.page(entry, { error }));
            throw error;
          }
        })().catch(surface);
        // Nothing awaits this read, so a throw while applying the page would
        // otherwise be an unhandled rejection that takes the worker down.
      },
    },

    close: () => stop(),
  };

  // Registered before the first read, so an observation made while the initial
  // snapshot is in flight is retained rather than missed.
  const offLive = source.onLive((frame, claim) => commit((tx) => tx.observe(frame, claim)));

  const follow = new AbortController();
  const frames = source.frames(follow.signal)[Symbol.asyncIterator]();

  const consume = (frame: RuntimeDurableFrame): void =>
    commit((tx) => {
      if (frame.type === "snapshot") tx.replace(frame.snapshot);
      else if (frame.type === "patch") tx.apply(frame.patch);
      else tx.close(frame);
    });

  let pump: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      // Cancellation of the frame loop is awaitable rather than merely
      // observable, so closing joins a read still in flight instead of leaving
      // its subscription behind.
      follow.abort();
      offLive();
      commit((tx) => tx.stopped());
      await pump;
      // Each registration is released rather than the set emptied, so the abort
      // handler a caller's signal is holding goes with it — clearing the set
      // alone leaves that handler, and the whole closure behind it, attached to
      // a signal that may outlive this Client by a long way.
      for (const release of releases) release();
      listeners.clear();
    })());

  try {
    // The transition is the loop iteration, and the first one is the initial
    // snapshot: awaiting it is what makes a resolved factory a hydrated Client.
    const first = await frames.next();
    if (!first.done) consume(first.value);
    // A Runtime that had already stopped hands over its terminal frame and no
    // snapshot at all, so the mirror is read here instead. Resolving the factory
    // has to mean the durable state was applied *unconditionally* — an
    // empty-because-closed Client is precisely the observable un-hydrated state
    // this factory exists to remove, and the records are still true: a chat that
    // existed does not stop having existed because this account stopped being
    // consumed. Only live state decays (ADR-0020), and none is retained here.
    if (!first.done && first.value.type === "closed") {
      const snapshot = await source.read((view) => view.snapshot());
      commit((tx) => tx.replace(snapshot));
    }
  } catch (error) {
    offLive();
    follow.abort();
    throw error;
  }

  pump = (async () => {
    try {
      for (let next = await frames.next(); !next.done; next = await frames.next())
        consume(next.value);
    } catch (error) {
      // Following the account has ended in a way the Runtime's terminal frame
      // could not describe — a mirror read that failed during gap recovery, say.
      // Nobody is awaiting this, so the only place it can be reported is the
      // account state, and it must be reported: a Client that silently stops
      // following renders WhatsApp state that will never change again while
      // telling the application it is live. That is exactly the failure Runtime
      // Closure exists to prevent — "a watch waits for ever on an update that
      // cannot come" — reproduced one layer up.
      //
      // Detached *before* the closure is committed, not after: this is the last
      // delivery this Client will ever make, and it must not be the one that
      // reports a live connection the very next line invalidates with nobody
      // left to notify.
      offLive();
      // One transition, so the closure and the reads it ended are announced
      // together rather than as two deliveries — and `following` is false
      // before the basis is sampled, which is what makes this the last
      // delivery this Client ever makes rather than one reporting live state
      // the next line invalidates.
      commit((tx) => {
        tx.stopped();
        tx.close({ type: "closed", error });
      });
      surface(error);
    }
    // Nothing awaits this loop, so a failure inside the reporting above — the
    // sampled identity comes from an application-supplied session and may throw
    // — would otherwise be an unhandled rejection that takes the process down
    // and loses the mirror failure that started it.
  })().catch(surface);

  return client;
}
