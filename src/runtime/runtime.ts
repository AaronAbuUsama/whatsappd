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
  let lease: AccountLease | undefined;
  let session: RuntimeSession | undefined;
  let unsubscribe: Unsubscribe | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let supervisor: Promise<void> | undefined;
  /** A terminal session failure, held until a `stop()` reports it. */
  let failure: { readonly error: unknown } | undefined;
  // Bumped by every start and every stop, so an `open()` suspended on an await
  // can tell that the runtime it was starting has since been torn down.
  let generation = 0;

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

  /** Release everything this runtime holds, retaining any failure to report. */
  async function teardown(): Promise<void> {
    generation += 1;
    running = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    const closing = session;
    const supervised = supervisor;
    session = undefined;
    supervisor = undefined;
    const claim = lease;
    lease = undefined;
    try {
      await closing?.stop?.();
      // Nothing awaited the supervisor while the session ran, so its terminal
      // failure — a rejected handler, a dead socket — arrives here.
      await supervised;
    } catch (error) {
      failure ??= { error };
    } finally {
      // A claim outliving a failed teardown would lock the account out until
      // its TTL expired, so the release does not depend on the close working.
      if (claim) await backend.leases.release(claim);
    }
  }

  async function stop(): Promise<void> {
    await teardown();
    // Reported once, to whoever stops the runtime — a session that died on its
    // own is not allowed to disappear quietly.
    const held = failure;
    failure = undefined;
    if (held) throw held.error;
  }

  /** Hold the claim for the session's life; losing it stops the runtime. */
  async function renew(): Promise<void> {
    const held = lease;
    if (!held) return;
    const result = await backend.leases
      .renew(held, leaseTtlMs)
      .catch(() => ({ renewed: false }) as const);
    if (result.renewed) lease = result.lease;
    else {
      lease = undefined; // the claim is gone; releasing it would evict its new holder
      await stop();
    }
  }

  async function open(): Promise<void> {
    const mine = (generation += 1);
    const stopped = (): boolean => generation !== mine;
    /** The session ended on its own; the runtime must not keep the account. */
    const ended = (): void => {
      if (!stopped()) void teardown().catch(() => {});
    };
    let claimed: AccountLease | undefined;
    try {
      // The claim comes first: a duplicate worker must fail before it can open
      // a second socket on the account and diverge its Signal state.
      const claim = await backend.leases.acquire(accountId, holderId, leaseTtlMs);
      if (!claim.acquired) throw new AccountAlreadyClaimedError(accountId, claim.heldUntil);
      claimed = claim.lease;
      if (stopped()) throw new Error(`runtime for "${accountId}" was stopped while starting`);
      lease = claimed;
      heartbeat = setInterval(
        () => {
          // ponytail: a timer has nowhere to report a failed teardown, and the
          // claim is gone either way. Surfacing it needs the runtime fault
          // channel that degraded state introduces.
          void renew().catch(() => {});
        },
        Math.max(1, Math.floor(leaseTtlMs / 2)),
      );
      heartbeat.unref?.();

      const opened = await config.openSession(backend.credentials);
      // A stop() that ran while the session was opening already released the
      // claim, so subscribing now would consume WhatsApp with no claim at all —
      // possibly alongside the worker that took the account over.
      if (stopped()) {
        await opened.stop?.();
        throw new Error(`runtime for "${accountId}" was stopped while starting`);
      }
      session = opened;
      unsubscribe = opened.subscribe(handlers);
      // A live session's start() resolves only once the session has ended, so
      // it is supervised rather than awaited: startup returns when the account
      // is being consumed, and the session's terminal failure surfaces from
      // stop(). Awaiting it here would hang every caller for the whole session.
      supervisor = opened.start?.();
      // When the session ends on its own the runtime stops with it, so a dead
      // session never keeps holding the account.
      void supervisor?.then(ended, ended);
    } catch (error) {
      // Leaves nothing claimed or subscribed behind. `teardown()` clears the
      // memo, so a later `start()` is a real retry rather than the same
      // rejection, and the explicit release covers a claim taken after a
      // concurrent stop() had already let go.
      if (!stopped()) await teardown().catch(() => {});
      if (claimed) await backend.leases.release(claimed).catch(() => {});
      throw error;
    }
  }

  return {
    accountId,
    // Idempotent while running; a failed start has already released its claim,
    // so calling it again genuinely retries.
    start: () => (running ??= open()),
    stop,
    snapshot: () => backend.data.snapshot(accountId),
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

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
      const onAbort = (): void => wake?.();
      signal?.addEventListener("abort", onAbort, { once: true });

      // The revision the consumer has been brought up to. Patches are applied
      // only from exactly here (ADR-0011), so it moves with what is yielded
      // rather than staying at the first snapshot's revision.
      let applied = -1;
      const resnapshot = async (): Promise<WhatsAppSnapshot> => {
        const snapshot = await runtime.snapshot();
        applied = snapshot.revision;
        return snapshot;
      };

      try {
        if (signal?.aborted) return;
        const snapshot = await resnapshot();
        if (signal?.aborted) return;
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
                if (signal?.aborted) return;
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
