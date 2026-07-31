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
    const accepted = await backend.data.accept(accountId, [
      { accountId, observedAt: Date.now(), event },
    ]);
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

  async function stop(): Promise<void> {
    running = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    const closing = session;
    session = undefined;
    await closing?.stop?.();
    const claim = lease;
    lease = undefined;
    if (claim) await backend.leases.release(claim);
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
    try {
      // The claim comes first: a duplicate worker must fail before it can open
      // a second socket on the account and diverge its Signal state.
      const claim = await backend.leases.acquire(accountId, holderId, leaseTtlMs);
      if (!claim.acquired) throw new AccountAlreadyClaimedError(accountId, claim.heldUntil);
      lease = claim.lease;
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
      session = await config.openSession(backend.credentials);
      unsubscribe = session.subscribe(handlers);
      await session.start?.();
    } catch (error) {
      // Leaves nothing claimed or subscribed behind; `stop()` clears the memo,
      // so a later `start()` is a real retry rather than the same rejection.
      await stop();
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

      try {
        const snapshot = await runtime.snapshot();
        yield { type: "snapshot", snapshot };
        while (!signal?.aborted) {
          for (const frame of queued.splice(0)) {
            // Changes the snapshot already contains would repeat a revision.
            if (frame.type === "patch" && frame.patch.revision <= snapshot.revision) continue;
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
