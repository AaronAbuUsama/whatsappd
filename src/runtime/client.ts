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
  WhatsAppDurableFrame,
  WhatsAppLiveFrame,
  WhatsAppPatch,
  WhatsAppSnapshot,
} from "./contracts.ts";
import {
  clientSourceFor,
  fanout,
  surface,
  type ClientClaim,
  type WhatsAppRuntime,
} from "./runtime.ts";

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

/** The Client's domain namespaces — and the unit a transition marks affected. */
type Namespace = "account" | "chats" | "contacts" | "groups";

const NAMESPACES: readonly Namespace[] = ["account", "chats", "contacts", "groups"];

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

/** How a transition mutates Client state. The only way anything here changes. */
interface Tx {
  /** Replace all durable state with a Snapshot Window's. */
  replace(snapshot: WhatsAppSnapshot): void;
  /** Apply one contiguous change: upserts, deletes, and the aliases between. */
  apply(patch: WhatsAppPatch): void;
  /** Retain one live observation under the claim it was made under. */
  observe(frame: WhatsAppLiveFrame, claim: ClientClaim): void;
  /** Record that the Runtime has stopped consuming this account. */
  close(frame: Extract<WhatsAppDurableFrame, { type: "closed" }>): void;
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
   * Calling {@link WhatsAppClientCore.close} does *not* set this: the
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
export interface WhatsAppClientCore {
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
export async function createWhatsAppClient(runtime: WhatsAppRuntime): Promise<WhatsAppClientCore> {
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
  let connection: Observation<Status> | undefined;
  // ponytail: an expired presence is filtered at read but never evicted, and
  // only an explicit `unavailable` removes one — expiry is not a transition
  // (ADR-0028), so there is no moment that would do it. Growth is one small
  // entry per address ever seen active, which is bounded by the contacts and
  // group participants this Client already holds in full. Evict on a
  // `touch("contacts")` sweep if a long-lived account ever makes it matter.
  const presence = new Map<string, Observation<PresenceKind>>();
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
  let orderedChats: readonly ChatRecord[] | undefined;
  let orderedContacts: readonly ContactRecord[] | undefined;
  let orderedGroups: readonly GroupRecord[] | undefined;

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
      identityCopy = own(identity);
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
      if (namespace === "chats") orderedChats = undefined;
      else if (namespace === "contacts") orderedContacts = undefined;
      else if (namespace === "groups") orderedGroups = undefined;
    };

    mutate({
      replace(snapshot) {
        record = own(snapshot.account);
        chats.clear();
        for (const chat of snapshot.chats) chats.set(chat.chatId, own(chat));
        contacts.clear();
        for (const contact of snapshot.contacts) contacts.set(contact.contactId, own(contact));
        aliases.clear();
        for (const [nativeId, contactId] of Object.entries(snapshot.contactAliases))
          aliases.set(nativeId, contactId);
        groups.clear();
        for (const group of snapshot.groups) groups.set(group.groupId, own(group));
        for (const namespace of NAMESPACES) touch(namespace);
      },

      apply(patch) {
        for (const upsert of patch.upserts) {
          switch (upsert.type) {
            case "account":
              record = own(upsert.account);
              touch("account");
              break;
            case "chat":
              chats.set(upsert.chat.chatId, own(upsert.chat));
              touch("chats");
              break;
            case "contact":
              contacts.set(upsert.contact.contactId, own(upsert.contact));
              touch("contacts");
              break;
            case "group":
              groups.set(upsert.group.groupId, own(upsert.group));
              touch("groups");
              break;
            case "message":
              // A message belongs to an opened conversation, which this layer
              // does not own. Everything it changed about the state that *is*
              // here — the chat's newest activity — arrives as its own upsert.
              break;
          }
        }
        for (const removed of patch.deletes ?? []) {
          // What the delete freed is named by the patch, or read from the very
          // record being removed. Neither is a scan of every contact, which is
          // what maintaining Address Resolution from patches exists to avoid
          // (ADR-0030). Dropping them keeps this map from retaining an entry
          // per consolidation for ever; the aliases below then re-point every
          // one of them, which is why deletes are applied first.
          const freed = removed.freedNativeIds ?? contacts.get(removed.contactId)?.nativeIds ?? [];
          for (const nativeId of freed) aliases.delete(nativeId);
          if (contacts.delete(removed.contactId)) touch("contacts");
        }
        for (const alias of patch.aliases ?? []) {
          aliases.set(alias.nativeId, alias.contactId);
          touch("contacts");
        }
      },

      observe(frame, claim) {
        if (frame.type === "connection") {
          connection = {
            value: own(frame.state.status),
            expiresAt: frame.state.expiresAt,
            claim,
          };
          touch("account");
          return;
        }
        // In a group WhatsApp names the participant and in a 1:1 the chat is
        // the peer, so the subject is the address that was present — the same
        // address the runtime records the durable last-seen instant against.
        const subject = frame.presence.participant ?? frame.presence.chatId;
        if (frame.presence.kind === "unavailable") {
          // Not an observation that decays: it says the address is gone now, so
          // its subject goes now rather than at some later deadline — and every
          // form of that subject goes with it. WhatsApp addresses one peer by
          // its PN on one occasion and its LID on another, so a `gone` naming
          // one form has to end an observation made under the other; otherwise
          // a read, which spans the forms, keeps answering with the sibling.
          let removed = false;
          for (const form of formsOf(subject)) removed = presence.delete(form) || removed;
          if (removed) touch("contacts");
          return;
        }
        // Stored under the address WhatsApp actually used. Not resolved to a
        // contact: an address with no record yet must still have a key, and a
        // presence supplies no Address Resolution evidence of its own (ADR-0020).
        presence.set(subject, {
          value: frame.presence.kind,
          expiresAt: frame.expiresAt,
          claim,
        });
        touch("contacts");
      },

      close(frame) {
        if (closure) return;
        closure = "error" in frame ? { error: frame.error } : {};
        touch("account");
      },
    });

    if (touched.size === 0) return;
    // One derivation basis for the whole delivery, sampled after the transition
    // is closed and restored afterwards, so a read outside any delivery samples
    // afresh as it always would.
    const outer = delivery;
    delivery = sample();
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

  const client: WhatsAppClientCore = {
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
        (orderedChats ??= Object.freeze(
          [...chats.values()].sort(
            (a, b) => b.lastMessageAt - a.lastMessageAt || compareId(a.chatId, b.chatId),
          ),
        )),
    },

    contacts: {
      subscribe: subscribeTo("contacts"),
      list: () =>
        (orderedContacts ??= Object.freeze(
          [...contacts.values()].sort((a, b) => compareId(a.contactId, b.contactId)),
        )),
      resolve(nativeId) {
        const contactId = aliases.get(nativeId);
        return contactId === undefined ? undefined : contacts.get(contactId);
      },
      presence(nativeId) {
        const from = basis();
        // An observation is keyed by the address WhatsApp used, and the same
        // peer is addressed by its PN form on one occasion and its LID form on
        // another — so a presence observed under one form answers for the
        // contact's others, exactly as the durable half of the same fact does:
        // `projection.ts` resolves a last-seen through the alias map before
        // recording it, and a live read that did not would report a
        // consolidated contact as never present (ADR-0022, ADR-0030).
        //
        // First hit wins, in the contact's own `nativeIds` order. Two forms of
        // one peer each holding a current observation is WhatsApp contradicting
        // itself; an `Observation` keeps no `observedAt`, so there is nothing to
        // prefer by, and inventing one would be a tie-break dressed as a fact.
        for (const form of formsOf(nativeId)) {
          const found = current(presence.get(form), from);
          if (found !== undefined) return found;
        }
        return undefined;
      },
    },

    groups: {
      subscribe: subscribeTo("groups"),
      list: () =>
        (orderedGroups ??= Object.freeze(
          [...groups.values()].sort((a, b) => compareId(a.groupId, b.groupId)),
        )),
    },

    close: () => stop(),
  };

  // Registered before the first read, so an observation made while the initial
  // snapshot is in flight is retained rather than missed.
  const offLive = source.onLive((frame, claim) => commit((tx) => tx.observe(frame, claim)));

  const follow = new AbortController();
  const frames = source.frames(follow.signal)[Symbol.asyncIterator]();

  const consume = (frame: WhatsAppDurableFrame): void =>
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
      following = false;
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
      following = false;
      commit((tx) => tx.close({ type: "closed", error }));
      surface(error);
    }
    // Nothing awaits this loop, so a failure inside the reporting above — the
    // sampled identity comes from an application-supplied session and may throw
    // — would otherwise be an unhandled rejection that takes the process down
    // and loses the mirror failure that started it.
  })().catch(surface);

  return client;
}
