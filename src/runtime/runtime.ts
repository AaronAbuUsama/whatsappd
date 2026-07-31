/**
 * The runtime: one account's live session, durably accepted, and published to
 * clients.
 *
 * @remarks
 * It claims the account lease before WhatsApp is opened at all, forwards every
 * durable event to the data store, and only then publishes the resulting patch.
 * A storage failure is not caught here: the awaited subscription carries it
 * back and stops processing, because a skipped write would leave a client
 * reading a mirror that silently lost a change.
 *
 * @packageDocumentation
 */
import type { CredentialStore } from "../ports.ts";
import type { Awaitable, Unsubscribe, WhatsAppSessionHandlers } from "../subscription.ts";
import {
  AccountAlreadyClaimedError,
  AccountNotHeldError,
  type AccountLease,
  type WhatsAppBackend,
  type WhatsAppClient,
  type WhatsAppClientFrame,
  type WhatsAppDurableEvent,
  type WhatsAppSnapshot,
} from "./contracts.ts";

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
  /** The account's current mirror and revision. */
  snapshot(): Promise<WhatsAppSnapshot>;
  /** Observe published frames. The client seam; applications use a client. */
  onFrame(listener: (frame: WhatsAppClientFrame) => void): Unsubscribe;
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

  const listeners = new Set<(frame: WhatsAppClientFrame) => void>();

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
  let supervisor: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  /** A terminal session failure, held until a `stop()` reports it. */
  let failure: { readonly error: unknown } | undefined;

  const publish = (frame: WhatsAppClientFrame): void => {
    for (const listener of listeners) listener(frame);
  };

  /**
   * Persist one observation, then publish what it changed.
   *
   * @remarks
   * A replay changes nothing, takes no revision, and therefore produces no
   * client update.
   */
  const accept = async (event: WhatsAppDurableEvent): Promise<void> => {
    const claim = lease;
    // Writing without a claim is exactly what the lease exists to prevent, so
    // an event that outlives its claim fails rather than reaching the mirror.
    if (!claim) throw new AccountNotHeldError(accountId, "unclaimed");
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
    publish({ type: "patch", patch: accepted.patch });
  };

  /**
   * What this slice consumes from the session.
   *
   * @remarks
   * Only what the mirror can project is subscribed at all. Update, contact and
   * group events have no projection yet and are not observed in this slice —
   * which is a scope statement, not a bypass: nothing reaches the mirror by
   * another route, and the store still refuses any unsupported event type a
   * caller hands it. What is observed is accepted whole, never trimmed to what
   * currently projects.
   */
  const handlers: WhatsAppSessionHandlers = {
    message: (message) => accept({ type: "message", message }),
    conversationSync: (batch) => accept({ type: "conversation_sync", batch }),
    // Connection and presence are live signals with an expiry, never records:
    // a stored `online` or `typing` would be reported as current after it
    // stopped being true.
    connection: (status) => {
      const claim = lease;
      // Connection truth is only ever this claim's; without one there is
      // nothing a client could treat as current.
      if (!claim) return;
      const observedAt = Date.now();
      publish({
        type: "connection",
        state: {
          status,
          observedAt,
          expiresAt: observedAt + freshnessMs,
          fencingToken: claim.fencingToken,
        },
      });
    },
    presence: (presence) => {
      publish({ type: "presence", presence, expiresAt: Date.now() + freshnessMs });
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
    try {
      await open?.stop?.();
      // Nothing awaited the supervisor while the session ran, so its terminal
      // failure — a rejected handler, a dead socket — arrives here.
      await running;
    } catch (error) {
      failure ??= { error };
    } finally {
      // A claim outliving a failed close would lock the account out until its
      // TTL expired, so the release does not depend on the close working.
      if (claim) await backend.leases.release(claim);
    }
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
        publish({ type: "closed", ...(failure && { error: failure.error }) });
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
   * Only ever one renewal is in flight — `release()` clears the heartbeat before
   * anything else — and a lease store cannot renew a claim that was already
   * released, so there is no post-await liveness check here. A store that
   * renewed one anyway would be defeated at the acceptance boundary, which
   * compares fencing tokens rather than trusting this cached claim.
   */
  async function renew(): Promise<void> {
    const held = lease;
    if (!held || stopped) return;
    const result = await backend.leases
      .renew(held, leaseTtlMs)
      .catch(() => ({ renewed: false }) as const);
    if (result.renewed) lease = result.lease;
    else {
      lease = undefined; // gone; releasing it would evict its new holder
      await halt();
    }
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
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
    async *watch(options) {
      const signal = options?.signal;
      const queued: WhatsAppClientFrame[] = [];
      let wake: (() => void) | undefined;
      const push = (frame: WhatsAppClientFrame): void => {
        queued.push(frame);
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
      const resnapshot = async (): Promise<WhatsAppSnapshot | typeof CANCELLED> => {
        const snapshot = await Promise.race([runtime.snapshot(), cancelled]);
        if (snapshot === CANCELLED) return CANCELLED;
        applied = snapshot.revision;
        return snapshot;
      };

      try {
        const snapshot = await resnapshot();
        if (snapshot === CANCELLED || signal?.aborted) return;
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
