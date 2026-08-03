/**
 * The runtime: one account's live session, durably accepted, and published to
 * clients.
 *
 * @remarks
 * It claims the account lease before WhatsApp is opened at all, forwards every
 * durable event to the data store, and only then publishes the resulting patch.
 * A structured data-store failure is not caught here: the awaited subscription
 * carries it back and stops processing, because a skipped acceptance would
 * leave a client reading a mirror that silently lost a change. Media capture
 * failures are different durable outcomes and are accepted as typed state.
 *
 * @packageDocumentation
 */
import { isOnline, isTerminal, type Status } from "../model/status.ts";
import { refOf } from "../model/outbound.ts";
import type { Update } from "../model/update.ts";
import type { CredentialStore } from "../ports.ts";
import type { Awaitable, Unsubscribe, WhatsAppSessionHandlers } from "../subscription.ts";
import { firstRejection, settle } from "../outcome.ts";
import {
  AccountAlreadyClaimedError,
  AccountNotHeldError,
  type AccountLease,
  type AccountLeaseStore,
  type DurableInboundMessage,
  type DurableUpdate,
  type StoredMessagePage,
  type StoredMessagePageOptions,
  type WhatsAppBackend,
  type WhatsAppClient,
  type WhatsAppDurableEvent,
  type WhatsAppDurableFrame,
  type WhatsAppLiveFrame,
  type WhatsAppSnapshot,
} from "./contracts.ts";

const captureMessage = async (
  accountId: string,
  mediaStore: WhatsAppBackend["media"],
  message: Parameters<NonNullable<WhatsAppSessionHandlers["message"]>>[0],
): Promise<DurableInboundMessage> => {
  switch (message.kind) {
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const source = message.media;
      const metadata = {
        ...(source.mimetype !== undefined && { mimetype: source.mimetype }),
        ...(source.fileLength !== undefined && { fileLength: source.fileLength }),
        ...(source.fileName !== undefined && { fileName: source.fileName }),
        ...(source.seconds !== undefined && { seconds: source.seconds }),
        ...(source.ptt !== undefined && { ptt: source.ptt }),
        ...(source.width !== undefined && { width: source.width }),
        ...(source.height !== undefined && { height: source.height }),
        ...(source.caption !== undefined && { caption: source.caption }),
      };
      let bytes: Uint8Array;
      try {
        bytes = await source.download();
      } catch {
        return { ...message, media: { ...metadata, state: "failed", reason: "download_failed" } };
      }
      try {
        const stored = await mediaStore.put({
          accountId,
          message: refOf(message),
          kind: message.kind,
          bytes,
          ...(metadata.mimetype !== undefined && { mimetype: metadata.mimetype }),
        });
        return { ...message, media: { ...metadata, state: "stored", ...stored } };
      } catch {
        return { ...message, media: { ...metadata, state: "failed", reason: "store_failed" } };
      }
    }
    default:
      return message;
  }
};

const durableUpdate = async (
  accountId: string,
  mediaStore: WhatsAppBackend["media"],
  update: Update,
): Promise<DurableUpdate> => {
  if (update.kind !== "edit") return update;
  return { ...update, message: await captureMessage(accountId, mediaStore, update.message) };
};

/**
 * What a connection status durably says about *when*, if anything.
 *
 * @remarks
 * Only the two ends of the lifecycle are facts worth keeping: the account was
 * online at this instant, or it had gone. `connecting`, `pairing` and
 * `authenticated` are transitions — the account is neither reachable nor known
 * to be gone — and stamping either timestamp from one would misreport a
 * reconnect attempt as a disconnection (ADR-0020).
 *
 * `backing_off` counts as gone, and has to: a dropped socket goes straight
 * there rather than through `disconnected` (`src/machine.ts`, `onClose`), so
 * reading only the literal phase would leave the commonest disconnection of all
 * unrecorded and last-disconnected reflecting nothing but deliberate stops.
 */
const connectionInstant = (status: Status): "connected" | "disconnected" | undefined =>
  isOnline(status)
    ? "connected"
    : status.phase === "disconnected" || status.phase === "backing_off" || isTerminal(status)
      ? "disconnected"
      : undefined;

/**
 * The part of a live session the runtime uses.
 *
 * @remarks
 * `start` and `stop` are optional so the deterministic test session — which has
 * no socket to open — is usable through the same runtime as the real one.
 */
export interface RuntimeSession {
  subscribe(
    handlers: WhatsAppSessionHandlers,
    options?: { readonly signal?: AbortSignal },
  ): Unsubscribe;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** Configuration for {@link createWhatsAppRuntime}. */
export interface WhatsAppRuntimeConfig {
  /** The account this runtime owns. Every durable record is scoped to it. */
  readonly accountId: string;
  /** Where this account's credentials, data, lease, and media live. */
  readonly backend: WhatsAppBackend;
  /**
   * Open the live session for this account.
   *
   * @remarks
   * Called only once the account lease is held, so a duplicate worker never
   * reaches WhatsApp. The account's credential store is passed in rather than
   * read by the caller, so the session and the mirror cannot drift onto
   * different accounts.
   */
  openSession(credentials: CredentialStore): Awaitable<RuntimeSession>;
  /** Identifies this holder in the account lease. @defaultValue a random UUID */
  readonly holderId?: string;
  /** Account-lease TTL, renewed at half this interval. @defaultValue `30_000` */
  readonly leaseTtlMs?: number;
  /**
   * How long a live connection or presence observation stays current.
   *
   * @defaultValue `15_000`
   */
  readonly freshnessMs?: number;
}

/** One account's runtime. Create it with {@link createWhatsAppRuntime}. */
export interface WhatsAppRuntime {
  readonly accountId: string;
  /**
   * Claim the account lease, then open and subscribe to the live session.
   *
   * @throws {@link AccountAlreadyClaimedError} when another runtime holds the
   * account — before WhatsApp is opened.
   */
  start(): Promise<void>;
  /** Stop consuming, close the session, and release the account lease. */
  stop(): Promise<void>;
  /** The account's current Snapshot Window and revision. */
  snapshot(): Promise<WhatsAppSnapshot>;
  /** One chat's stored messages, newest first. Reads storage, never WhatsApp. */
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
  /**
   * Observe the revision-ordered channel: snapshot, patch, and closed.
   *
   * @remarks
   * The client seam; applications use a client. A listener registered after
   * this runtime has closed is handed the terminal frame and nothing else.
   */
  onFrame(listener: (frame: WhatsAppDurableFrame) => void): Unsubscribe;
  /**
   * Observe the expiring channel: presence and connection. A separate
   * registration because these carry no revision and stop being true by wall
   * clock, so nothing can order them against a patch (ADR-0030).
   */
  onLive(listener: (frame: WhatsAppLiveFrame) => void): Unsubscribe;
}

/**
 * One registration on one channel — a record, never the callback itself.
 *
 * @remarks
 * Unsubscribing and resubscribing the same function during a fanout owes both
 * effects: the old registration ends now, the new one starts next frame. A
 * `Set` keyed by the callback cannot tell them apart, and could not give one
 * subscription per registration to a function registered twice (ADR-0013).
 */
interface Registration<Frame> {
  readonly notify: (frame: Frame) => void;
}

/**
 * Report an observer's failure where nothing downstream can swallow it.
 *
 * @remarks
 * An observer is application code, and a failing one must be able neither to
 * roll back a committed write, nor to disappear without evidence, nor to stop
 * the other observers. Rethrowing asynchronously satisfies the first two and
 * breaks the third: with no `uncaughtException` handler installed — the normal
 * worker — the throw ends the process, so nobody receives the next frame or
 * `closed`, which is the very isolation this is meant to provide. A warning is
 * asynchronous, always printed, observable on `process.on("warning")`, and
 * never fatal. `--no-warnings` silences it, as it silences every warning; that
 * is the operator asking not to be told.
 */
const surface = (error: unknown): void => {
  try {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error), { cause: error }),
    );
  } catch {
    // Describing a failure must not become a second one escaping the fanout:
    // `String()` throws for a null-prototype object or a hostile
    // `Symbol.toPrimitive`, and observers that have not run yet would lose a
    // committed frame to it.
    process.emitWarning(new Error("an observer failed with a value that cannot be described"));
  }
};

/**
 * Deliver one frame to a copy of one channel's listeners.
 *
 * @remarks
 * Three properties, each a primitive rather than an ordering to re-establish at
 * every publication site (ADR-0029 rules 2–4):
 *
 * - membership is copied before the first delivery, so a registration made
 *   during fanout is not visited. Iterating the live `Set` re-enters it — one
 *   publication was measured driving 200,000 deliveries;
 * - membership is rechecked before each call, so unsubscribing *another*
 *   listener during fanout takes effect on the frame already in flight;
 * - the copy each observer owns is taken outside the region guarding the call,
 *   so a frame that cannot be cloned costs one delivery rather than every
 *   listener, which ends the stream silently with no terminal frame.
 */
function deliver<Frame extends { readonly type: string }>(
  listeners: ReadonlySet<Registration<Frame>>,
  frame: Frame,
): void {
  const receiving = [...listeners];
  for (const listener of receiving) {
    if (!listeners.has(listener)) continue;
    let owned: Frame;
    try {
      // Each observer owns its view of mutable JavaScript data. Terminal
      // errors deliberately retain identity so callers can compare causes.
      owned = frame.type === "closed" ? { ...frame } : structuredClone(frame);
    } catch (error) {
      surface(error);
      continue;
    }
    try {
      listener.notify(owned);
    } catch (error) {
      // Observers are downstream of a committed write, so one broken observer
      // cannot roll it back or keep the rest from seeing it — and it stays
      // subscribed, because an observer dropped for one bad frame never
      // receives `closed` and simply goes quiet for ever.
      surface(error);
    }
  }
}

/**
 * Create one account's runtime.
 *
 * @param config - Account, backend, and how to open the session — see
 * {@link WhatsAppRuntimeConfig}.
 * @returns A runtime that has claimed nothing until
 * {@link WhatsAppRuntime.start | start} is called.
 *
 * @example
 * ```ts
 * const runtime = createWhatsAppRuntime({
 *   accountId: "personal",
 *   backend: memoryBackend(),
 *   openSession: (credentials) => createSession({ store: credentials, auth: qrAuth() }),
 * });
 *
 * await runtime.start();
 * for await (const frame of createInProcessWhatsAppClient(runtime).watch()) {
 *   console.log(frame.type);
 * }
 * ```
 */
export function createWhatsAppRuntime(config: WhatsAppRuntimeConfig): WhatsAppRuntime {
  const { accountId, backend } = config;
  const holderId = config.holderId ?? crypto.randomUUID();
  const leaseTtlMs = config.leaseTtlMs ?? 30_000;
  const freshnessMs = config.freshnessMs ?? 15_000;

  const durableListeners = new Set<Registration<WhatsAppDurableFrame>>();
  const liveListeners = new Set<Registration<WhatsAppLiveFrame>>();

  /**
   * One runtime consumes one account once, and `stopped` latches on the way
   * down.
   *
   * @remarks
   * Startup, renewal and teardown all have to answer the same question after
   * every await — does this runtime still own the account? A one-way latch gives
   * that question one answer in one variable. Making the runtime restartable
   * instead would reintroduce a per-cycle identity for every one of these to
   * compare against, and nothing needs it: a worker starts at boot and stops at
   * shutdown, and a replacement worker is a new runtime holding a new lease.
   */
  let stopped = false;
  let lease: AccountLease | undefined;
  let session: RuntimeSession | undefined;
  let unsubscribe: Unsubscribe | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | undefined;
  let supervisor: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  /** A terminal session failure, held until a `stop()` reports it. */
  let failure: { readonly error: unknown } | undefined;
  let terminal: Extract<WhatsAppDurableFrame, { type: "closed" }> | undefined;
  /** Late subscribers owed the terminal frame, and those handed it in this drain. */
  const owedTerminal: Array<(frame: WhatsAppDurableFrame) => void> = [];
  const handedTerminal = new Set<(frame: WhatsAppDurableFrame) => void>();
  let replaying = false;

  /**
   * Hand the terminal frame to one subscriber that arrived after closure.
   *
   * @remarks
   * Drained rather than delivered inline, and through {@link deliver} rather
   * than beside it, so registration during a replay behaves exactly as
   * registration during a fanout does — that seam is where every listener
   * defect in this rewrite lived. Draining is what lets a subscriber
   * registered by another subscriber's terminal callback still receive it;
   * handing each callback the frame once *per drain* is what stops a
   * subscriber that re-registers itself from being handed it for ever, while
   * leaving two deliberate registrations of one function two deliveries and
   * retaining no callback past the drain that served it.
   */
  const replayTerminal = (listener: (frame: WhatsAppDurableFrame) => void): void => {
    if (!terminal || handedTerminal.has(listener)) return;
    handedTerminal.add(listener);
    owedTerminal.push(listener);
    if (replaying) return;
    replaying = true;
    try {
      for (let next = owedTerminal.shift(); next; next = owedTerminal.shift())
        deliver(new Set([{ notify: next }]), terminal);
    } finally {
      replaying = false;
      handedTerminal.clear();
    }
  };

  const publishDurable = (frame: WhatsAppDurableFrame): void => deliver(durableListeners, frame);
  const publishLive = (frame: WhatsAppLiveFrame): void => deliver(liveListeners, frame);

  /**
   * Persist one observation under a named claim, then publish what it changed.
   *
   * @remarks
   * The claim is a parameter rather than a read of `lease`, because teardown
   * has to write its final observation *after* clearing that field — see
   * {@link release}. Every other caller passes the live one through
   * {@link accept}.
   */
  const acceptUnder = async (claim: AccountLease, event: WhatsAppDurableEvent): Promise<void> => {
    // The cached claim is only evidence until it expires: a loop that stalls
    // past the TTL can reach here before the heartbeat notices, and by then
    // another worker may hold the account.
    if (claim.expiresAt <= Date.now())
      throw new AccountNotHeldError(accountId, "expired", `the claim lapsed at ${claim.expiresAt}`);
    const accepted = await backend.data.accept(
      accountId,
      [{ observedAt: Date.now(), event }],
      claim.fencingToken,
    );
    if (accepted.revision === accepted.fromRevision) return;
    publishDurable({ type: "patch", patch: accepted.patch });
  };

  /**
   * Persist one observation, then publish what it changed.
   *
   * @remarks
   * A replay changes nothing, takes no revision, and therefore produces no
   * client update.
   */
  const accept = (event: WhatsAppDurableEvent): Promise<void> => {
    const claim = lease;
    // Writing without a claim is exactly what the lease exists to prevent, so
    // an event that outlives its claim fails rather than reaching the mirror.
    if (!claim) throw new AccountNotHeldError(accountId, "unclaimed");
    return acceptUnder(claim, event);
  };

  /**
   * What this slice consumes from the session.
   *
   * @remarks
   * Every durable normalized observation is subscribed. Some, such as message
   * updates, are retained in accepted source before they gain a current-mirror
   * projection; source truth must not disappear merely because projection work
   * belongs to a later slice.
   */
  const handlers: WhatsAppSessionHandlers = {
    message: async (message) =>
      accept({ type: "message", message: await captureMessage(accountId, backend.media, message) }),
    update: async (update) =>
      accept({
        type: "update",
        update: await durableUpdate(accountId, backend.media, update),
      }),
    conversationSync: async (batch) => {
      const messages: DurableInboundMessage[] = [];
      for (const message of batch.messages)
        messages.push(await captureMessage(accountId, backend.media, message));
      return accept({ type: "conversation_sync", batch: { ...batch, messages } });
    },
    contact: (contact) => accept({ type: "contact", contact }),
    group: (group) => accept({ type: "group", group }),
    // Connection and presence are live signals with an expiry, never records:
    // a stored `online` or `typing` would be reported as current after it
    // stopped being true. Only the instant each was observed at is durable, and
    // an instant restores as history rather than as current state (ADR-0020).
    connection: async (status) => {
      const claim = lease;
      // Connection truth is only ever this claim's; without one there is
      // nothing a client could treat as current.
      if (!claim) return;
      const observedAt = Date.now();
      publishLive({
        type: "connection",
        state: {
          status,
          observedAt,
          expiresAt: observedAt + freshnessMs,
          fencingToken: claim.fencingToken,
        },
      });
      const kind = connectionInstant(status);
      if (kind) await accept({ type: "account_connection", kind, at: observedAt });
    },
    presence: async (presence) => {
      const observedAt = Date.now();
      publishLive({ type: "presence", presence, expiresAt: observedAt + freshnessMs });
      // An ephemeral signal must not be able to take the account down. Unlike a
      // message, a dropped last-seen loses nothing that cannot be observed
      // again, so a frame arriving without a claim is let go exactly as the
      // connection handler lets one go.
      if (!lease) return;
      // `unavailable` is the one kind that is not evidence of presence: it says
      // the address is gone, and `src/baileys/presence.ts` stamps `at` with
      // *receipt* time rather than WhatsApp's own last-seen. Recording it would
      // therefore date a peer offline for a week to right now — and `advance()`
      // would make that permanent, destroying the very history this exists to
      // keep (ADR-0020).
      if (presence.kind === "unavailable") return;
      // What remains — typing, recording, available, idle — all mean the
      // address was there at that instant, and none of them stores what it was
      // doing. In a group WhatsApp names the participant and in a 1:1 the chat
      // is the peer; the address that was present is recorded either way, never
      // the chat a group's typing arrived on.
      await accept({
        type: "last_seen",
        contactId: presence.participant ?? presence.chatId,
        at: presence.at ?? observedAt,
      });
    },
  };

  const stoppedWhileStarting = (): Error =>
    new AccountNotHeldError(accountId, "stopped", "the runtime was stopped while starting");

  /**
   * Give back everything this runtime holds, retaining any failure to report.
   *
   * @remarks
   * Everything is taken and cleared before the first await, so two releases
   * racing — a `stop()` and a startup that resumes to find itself stopped — each
   * give back only what they took. That is what lets teardown finish without
   * waiting for a startup suspended inside the caller's `openSession`: whatever
   * it acquires after this runs, it releases itself on the way out.
   */
  async function release(): Promise<void> {
    const timer = heartbeat;
    const off = unsubscribe;
    const claim = lease;
    const open = session;
    const running = supervisor;
    heartbeat = undefined;
    unsubscribe = undefined;
    lease = undefined;
    session = undefined;
    supervisor = undefined;

    if (timer) clearInterval(timer);
    off?.();
    // The final disconnection is stamped here rather than from the connection
    // handler, and it has to be: teardown unsubscribes and gives the claim back
    // before the session reaches `disconnected` (`src/machine.ts`), so that
    // handler can never see the instant this runtime stopped consuming the
    // account and `lastDisconnectedAt` would stay stale through every shutdown.
    // A crash is a disconnection too, so this is not conditional on stopping
    // cleanly — a field that only recorded deliberate stops would miss the
    // commonest way an account goes offline. `off` is the evidence there was a
    // session at all: a startup that failed before subscribing never connected,
    // so it has no disconnection to record.
    const stampOutcome =
      off && claim
        ? await settle(
            acceptUnder(claim, {
              type: "account_connection",
              kind: "disconnected",
              at: Date.now(),
            }),
          )
        : undefined;
    const closeOutcome = await settle(Promise.resolve().then(() => open?.stop?.()));
    // Nothing awaited the supervisor while the session ran, so its terminal
    // failure — a rejected handler, a dead socket — arrives here. It is joined
    // even when stop() failed.
    const runOutcome = await settle(running ?? Promise.resolve());
    // A claim outliving a failed close would lock the account out until its TTL
    // expired, so releasing it does not depend on either close outcome.
    const releaseOutcome = claim ? await settle(backend.leases.release(claim)) : undefined;
    const rejected = firstRejection(
      [runOutcome, closeOutcome, stampOutcome, releaseOutcome].filter(
        (result) => result !== undefined,
      ),
    );
    if (rejected) failure ??= { error: rejected.reason };
  }

  /**
   * Stop consuming this account, once and for good.
   *
   * @remarks
   * Memoized, so a public `stop()` racing the automatic teardown of a dead
   * session joins that one instead of starting a second: two teardowns would
   * let the caller return while the account was still claimed.
   */
  function halt(): Promise<void> {
    // Latched before anything is awaited, so a startup that resumes after this
    // point sees it — including one that has not reached its first await yet.
    stopped = true;
    return (stopping ??= (async () => {
      try {
        await release();
      } finally {
        // A watcher's stream is the only place a runtime that died on its own
        // can be seen; without this frame it simply goes quiet, for ever. Even a
        // release that failed halfway is published — leaving watchers suspended
        // is worse than reporting a messy stop.
        terminal = { type: "closed", ...(failure && { error: failure.error }) };
        publishDurable(terminal);
        // Nothing can be published again on either channel, and a closed
        // runtime an application still holds would otherwise keep every
        // observer and its captured state alive for the process's life.
        durableListeners.clear();
        liveListeners.clear();
      }
    })());
  }

  async function stop(): Promise<void> {
    await halt();
    // Reported once, to whoever stops the runtime — a session that died on its
    // own is not allowed to disappear quietly.
    const held = failure;
    failure = undefined;
    if (held) throw held.error;
  }

  /**
   * Hold the claim for the session's life; losing it stops the runtime.
   *
   * @remarks
   * Only ever one renewal is in flight. A post-await ownership check prevents a
   * slow backend response from resurrecting a claim that teardown cleared.
   */
  async function renewOnce(): Promise<void> {
    const held = lease;
    if (!held || stopped) return;
    let result: Awaited<ReturnType<AccountLeaseStore["renew"]>>;
    try {
      result = await backend.leases.renew(held, leaseTtlMs);
    } catch (error) {
      failure ??= { error };
      await halt();
      return;
    }
    // A stop or a later claim may have cleared/replaced this lease while the
    // backend call was in flight. Its stale result must not resurrect either.
    if (stopped || lease !== held) return;
    if (result.renewed) lease = result.lease;
    else {
      lease = undefined; // gone; releasing it would evict its new holder
      await halt();
    }
  }

  function renew(): Promise<void> {
    if (renewing) return renewing;
    const attempt = renewOnce();
    renewing = attempt;
    void attempt.then(
      () => {
        if (renewing === attempt) renewing = undefined;
      },
      () => {
        if (renewing === attempt) renewing = undefined;
      },
    );
    return attempt;
  }

  async function open(): Promise<void> {
    // The claim comes first: a duplicate worker must fail before it can open a
    // second socket on the account and diverge its Signal state.
    const claimed = await backend.leases.acquire(accountId, holderId, leaseTtlMs);
    if (!claimed.acquired) throw new AccountAlreadyClaimedError(accountId, claimed.heldUntil);
    // Recorded before the liveness check, never after: `release()` gives back
    // whatever startup got this far, and something held only in a local when a
    // stop() lands is something nothing can give back.
    lease = claimed.lease;
    if (stopped) throw stoppedWhileStarting();

    // Announce the claim at the acceptance boundary before WhatsApp is opened,
    // so a superseded worker's writes are refused from this moment rather than
    // from whenever this one first writes (ADR-0009).
    await backend.data.claim(accountId, claimed.lease.fencingToken);
    if (stopped) throw stoppedWhileStarting();

    heartbeat = setInterval(
      () => {
        // A lost renewal halts the runtime, and that closes every watch. Only a
        // teardown that then failed on its way out is swallowed here, and a
        // timer has nowhere to report one.
        void renew().catch(() => {});
      },
      Math.max(1, Math.floor(leaseTtlMs / 2)),
    );
    heartbeat.unref?.();

    const opened = await config.openSession(backend.credentials);
    session = opened;
    // A stop() that ran while the session was opening has already released the
    // claim, so subscribing now would consume WhatsApp with no claim at all —
    // possibly alongside the worker that took the account over.
    if (stopped) throw stoppedWhileStarting();

    unsubscribe = opened.subscribe(handlers);
    // A live session's start() resolves only once the session has ended, so it
    // is supervised rather than awaited: startup returns when the account is
    // being consumed, and the session's terminal failure surfaces from stop().
    // Awaiting it here would hang every caller for the whole session.
    supervisor = opened.start?.();
    // A session that ends on its own takes the runtime with it, so a dead
    // session never keeps holding the account.
    const ended = (): void => {
      if (!stopped) void halt().catch(() => {});
    };
    void supervisor?.then(ended, ended);
  }

  function start(): Promise<void> {
    // Callers arriving while a startup is in flight share it rather than racing
    // it for the account.
    if (starting) return starting;
    if (stopped) return Promise.reject(new Error(`runtime for "${accountId}" was stopped`));
    const attempt = (async () => {
      try {
        await open();
      } catch (error) {
        // Gives back whatever got acquired before this failed — including what
        // was acquired after a concurrent stop() had already released its own
        // share. So a caller that retries after AccountAlreadyClaimedError gets
        // a real attempt rather than the same rejection, and a cancelled
        // startup never leaves a claim behind.
        await release().catch(() => {});
        throw error;
      }
    })();
    starting = attempt;
    // A failed attempt is forgotten so it can be retried; a successful one is
    // this runtime's only one, because a runtime consumes its account once.
    void attempt.catch(() => {
      if (starting === attempt) starting = undefined;
    });
    return attempt;
  }

  return {
    accountId,
    start,
    stop,
    snapshot: () => backend.data.snapshot(accountId),
    messages: (chatId, options) => backend.data.messages(accountId, chatId, options),
    onFrame(listener) {
      if (terminal) {
        replayTerminal(listener);
        return () => {};
      }
      const registration = { notify: listener };
      durableListeners.add(registration);
      return () => durableListeners.delete(registration);
    },
    onLive(listener) {
      // Nothing follows the terminal frame on this channel, so a registration
      // made after it would be retained for ever and never called.
      if (terminal) return () => {};
      const registration = { notify: listener };
      liveListeners.add(registration);
      return () => liveListeners.delete(registration);
    },
  };
}

/** Distinguishes "the watch was cancelled" from any snapshot a read returns. */
const CANCELLED = Symbol("cancelled");

/**
 * Create the client for a runtime living in this process.
 *
 * @param runtime - The runtime to read and follow.
 * @returns A {@link WhatsAppClient} over that runtime's mirror.
 */
export function createInProcessWhatsAppClient(runtime: WhatsAppRuntime): WhatsAppClient {
  return {
    // Straight to the mirror, deliberately independent of any watch: paging is
    // a read, and nothing about it asks WhatsApp for anything (ADR-0010).
    messages: (chatId, options) => runtime.messages(chatId, options),

    async *watch(options) {
      const signal = options?.signal;
      const queued: WhatsAppDurableFrame[] = [];
      let wake: (() => void) | undefined;
      let close!: (frame: Extract<WhatsAppDurableFrame, { type: "closed" }>) => void;
      const closed = new Promise<Extract<WhatsAppDurableFrame, { type: "closed" }>>((resolve) => {
        close = resolve;
      });
      const push = (frame: WhatsAppDurableFrame): void => {
        queued.push(frame);
        if (frame.type === "closed") close(frame);
        wake?.();
      };
      // Subscribed before the snapshot is read, so a change committed while it
      // is being read is buffered rather than lost.
      const off = runtime.onFrame(push);
      let onAbort = (): void => {};
      // Cancellation has to be awaitable, not just observable: a snapshot read
      // that never settles would otherwise keep the generator suspended past
      // the abort, holding its subscription with no way to reach cleanup.
      const cancelled = new Promise<typeof CANCELLED>((resolve) => {
        if (signal?.aborted) resolve(CANCELLED);
        onAbort = (): void => {
          wake?.();
          resolve(CANCELLED);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });

      // The revision the consumer has been brought up to. Patches are applied
      // only from exactly here (ADR-0011), so it moves with what is yielded
      // rather than staying at the first snapshot's revision.
      let applied = -1;
      const resnapshot = async (): Promise<
        WhatsAppSnapshot | typeof CANCELLED | Extract<WhatsAppDurableFrame, { type: "closed" }>
      > => {
        const alreadyClosed = queued.find(
          (frame): frame is Extract<WhatsAppDurableFrame, { type: "closed" }> =>
            frame.type === "closed",
        );
        if (alreadyClosed) return alreadyClosed;
        const snapshot = await Promise.race([runtime.snapshot(), cancelled, closed]);
        if (snapshot === CANCELLED || "type" in snapshot) return snapshot;
        applied = snapshot.revision;
        return snapshot;
      };

      try {
        const snapshot = await resnapshot();
        if (snapshot === CANCELLED || signal?.aborted) return;
        if ("type" in snapshot) {
          yield snapshot;
          return;
        }
        yield { type: "snapshot", snapshot };
        while (!signal?.aborted) {
          for (const frame of queued.splice(0)) {
            if (frame.type === "patch") {
              // Already applied — a repeat, or a change the snapshot carried.
              if (frame.patch.revision <= applied) continue;
              // A missing intermediate change cannot be applied over, and
              // nothing may be silently skipped: replace state with a snapshot.
              if (frame.patch.fromRevision !== applied) {
                const fresh = await resnapshot();
                if (fresh === CANCELLED || signal?.aborted) return;
                if ("type" in fresh) {
                  yield fresh;
                  return;
                }
                yield { type: "snapshot", snapshot: fresh };
                continue;
              }
              applied = frame.patch.revision;
            }
            yield frame;
            // The runtime has stopped consuming the account, so nothing can
            // follow: end the stream rather than suspending on a wake that will
            // never come.
            if (frame.type === "closed") return;
            if (signal?.aborted) return;
          }
          if (queued.length === 0 && !signal?.aborted)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          wake = undefined;
        }
      } finally {
        off();
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
