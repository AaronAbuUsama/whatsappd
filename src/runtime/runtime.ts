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
   * Everything one start-to-stop cycle owns.
   *
   * @remarks
   * The lifecycle is asynchronous in four places at once — acquiring, opening,
   * renewing, supervising — so the state they touch belongs to the cycle rather
   * than to the runtime. A continuation that resumes after its cycle ended
   * writes to a `Run` nobody reads any more, instead of reaching into shared
   * variables a replacement cycle is using.
   */
  interface Run {
    lease: AccountLease | undefined;
    session: RuntimeSession | undefined;
    unsubscribe: Unsubscribe | undefined;
    heartbeat: ReturnType<typeof setInterval> | undefined;
    supervisor: Promise<void> | undefined;
    starting: Promise<void> | undefined;
    /** Set the moment teardown begins, so concurrent stops join it. */
    stopping: Promise<void> | undefined;
  }

  let current: Run | undefined;
  /** A terminal session failure, held until a `stop()` reports it. */
  let failure: { readonly error: unknown } | undefined;

  /** Whether this cycle still owns the runtime, checked after every await. */
  const live = (run: Run): boolean => current === run && run.stopping === undefined;

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
    const claim = current?.lease;
    // Writing without a claim is exactly what the lease exists to prevent, so
    // an event that outlives its claim fails rather than reaching the mirror.
    if (!claim) throw new Error(`no account claim held for "${accountId}"`);
    const accepted = await backend.data.accept(
      accountId,
      [{ eventId: crypto.randomUUID(), observedAt: Date.now(), event }],
      claim.fencingToken,
    );
    if (accepted.revision === accepted.fromRevision) return;
    publish({ type: "patch", patch: accepted.patch });
  };

  const handlers: WhatsAppSessionHandlers = {
    message: (message) => accept({ type: "message", message }),
    conversationSync: (batch) => accept({ type: "conversation_sync", batch }),
    update: (update) => accept({ type: "update", update }),
    contact: (contact) => accept({ type: "contact", contact }),
    group: (group) => accept({ type: "group", group }),
    // Connection and presence are live signals with an expiry, never records:
    // a stored `online` or `typing` would be reported as current after it
    // stopped being true.
    connection: (status) => {
      const claim = current?.lease;
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

  /**
   * Release everything one cycle holds, retaining any failure to report.
   *
   * @remarks
   * Memoized on the run, so a public `stop()` racing the automatic teardown of
   * a dead session joins that one instead of starting a second: two teardowns
   * would let the caller return while the account was still claimed.
   */
  function teardown(run: Run): Promise<void> {
    return (run.stopping ??= (async () => {
      if (run.heartbeat) clearInterval(run.heartbeat);
      run.unsubscribe?.();
      const claim = run.lease;
      run.lease = undefined;
      try {
        await run.session?.stop?.();
        // Nothing awaited the supervisor while the session ran, so its terminal
        // failure — a rejected handler, a dead socket — arrives here.
        await run.supervisor;
      } catch (error) {
        failure ??= { error };
      } finally {
        // A claim outliving a failed teardown would lock the account out until
        // its TTL expired, so the release does not depend on the close working.
        if (claim) await backend.leases.release(claim);
        if (current === run) current = undefined;
      }
    })());
  }

  async function stop(): Promise<void> {
    const run = current;
    if (run) await teardown(run);
    // Reported once, to whoever stops the runtime — a session that died on its
    // own is not allowed to disappear quietly.
    const held = failure;
    failure = undefined;
    if (held) throw held.error;
  }

  /** Hold the claim for the session's life; losing it stops the cycle. */
  async function renew(run: Run): Promise<void> {
    const held = run.lease;
    if (!held || !live(run)) return;
    const result = await backend.leases
      .renew(held, leaseTtlMs)
      .catch(() => ({ renewed: false }) as const);
    // The renewal may have committed after this cycle ended, in which case its
    // claim belongs to nobody: hand it back rather than assigning a stale lease
    // over whatever replaced this cycle.
    if (!live(run)) {
      if (result.renewed) await backend.leases.release(result.lease).catch(() => {});
      return;
    }
    if (result.renewed) run.lease = result.lease;
    else {
      run.lease = undefined; // gone; releasing it would evict its new holder
      await teardown(run);
    }
  }

  async function open(run: Run): Promise<void> {
    // The claim comes first: a duplicate worker must fail before it can open a
    // second socket on the account and diverge its Signal state.
    const claim = await backend.leases.acquire(accountId, holderId, leaseTtlMs);
    if (!claim.acquired) throw new AccountAlreadyClaimedError(accountId, claim.heldUntil);
    if (!live(run)) {
      await backend.leases.release(claim.lease).catch(() => {});
      throw new Error(`runtime for "${accountId}" was stopped while starting`);
    }
    run.lease = claim.lease;
    // Announce the claim at the acceptance boundary before WhatsApp is opened,
    // so a superseded worker's writes are refused from this moment rather than
    // from whenever this one first writes (ADR-0009).
    await backend.data.claim(accountId, claim.lease.fencingToken);
    run.heartbeat = setInterval(
      () => {
        // ponytail: a timer has nowhere to report a failed teardown, and the
        // claim is gone either way. Surfacing it needs the runtime fault
        // channel that degraded state introduces.
        void renew(run).catch(() => {});
      },
      Math.max(1, Math.floor(leaseTtlMs / 2)),
    );
    run.heartbeat.unref?.();

    const opened = await config.openSession(backend.credentials);
    // A stop() that ran while the session was opening has already released the
    // claim, so subscribing now would consume WhatsApp with no claim at all —
    // possibly alongside the worker that took the account over.
    if (!live(run)) {
      await opened.stop?.();
      throw new Error(`runtime for "${accountId}" was stopped while starting`);
    }
    run.session = opened;
    run.unsubscribe = opened.subscribe(handlers);
    // A live session's start() resolves only once the session has ended, so it
    // is supervised rather than awaited: startup returns when the account is
    // being consumed, and the session's terminal failure surfaces from stop().
    // Awaiting it here would hang every caller for the whole session.
    run.supervisor = opened.start?.();
    // A session that ends on its own takes the runtime with it, so a dead
    // session never keeps holding the account.
    const ended = (): void => {
      if (live(run)) void teardown(run).catch(() => {});
    };
    void run.supervisor?.then(ended, ended);
  }

  function start(): Promise<void> {
    const active = current;
    if (active && !active.stopping) return active.starting ?? Promise.resolve();
    return (async () => {
      // A start during a teardown waits for it rather than racing its release.
      await active?.stopping?.catch(() => {});
      const run: Run = {
        lease: undefined,
        session: undefined,
        unsubscribe: undefined,
        heartbeat: undefined,
        supervisor: undefined,
        starting: undefined,
        stopping: undefined,
      };
      current = run;
      const starting = open(run).catch(async (error: unknown) => {
        // Leaves nothing claimed or subscribed behind, so a later start() is a
        // real retry rather than the same rejection.
        await teardown(run).catch(() => {});
        throw error;
      });
      run.starting = starting;
      return starting;
    })();
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
