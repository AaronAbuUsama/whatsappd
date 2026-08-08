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
import { isOnline } from "../model/status.ts";
import type { Unsubscribe, WhatsAppSessionHandlers } from "../subscription.ts";
import { firstRejection, settle } from "../outcome.ts";
import {
  AccountAlreadyClaimedError,
  AccountNotHeldError,
  type AccountLease,
  type AccountLeaseStore,
  type DurableInboundMessage,
  type WhatsAppDurableEvent,
  type RuntimeDurableFrame,
  type RuntimeLiveFrame,
} from "./contracts.ts";
import { createOperationExecutor, type WhatsAppOperationInput } from "./operations.ts";
import { createRuntimeOperationSession, type OperationExecutor } from "./operation-session.ts";
import {
  authForPair,
  linkStateOf,
  publicConnectionStatus,
  productionSessionFactory,
  resumeAuth,
  submitPairOperation,
  submitUnlinkOperation,
  type RuntimeRegistration,
  type RuntimeSessionFactory,
  type WhatsAppLinkState,
} from "./lifecycle.ts";
import { captureMessage, connectionInstant, durableUpdate } from "./runtime-ingest.ts";
import { deliver, surface } from "./runtime-delivery.ts";
import {
  clientSourceFor,
  createClientRuntimeSource,
  type ClientClaim,
  type InProcessWhatsAppRuntime,
  type RuntimeSession,
  type WhatsAppRuntime,
  type WhatsAppRuntimeConfig,
} from "./runtime-source.ts";
export { createRuntimeFrameClient } from "./runtime-frames.ts";
export type {
  ClientRuntimeSource,
  InProcessWhatsAppRuntime,
  RuntimeSession,
  WhatsAppRuntime,
  WhatsAppRuntimeConfig,
} from "./runtime-source.ts";

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
 * Create one account's runtime.
 *
 * @param config - Account, backend, lease, and operation timing — see
 * {@link WhatsAppRuntimeConfig}.
 * @returns A runtime that has claimed nothing until
 * {@link WhatsAppRuntime.start | start} is called.
 *
 * @example
 * ```ts
 * const runtime = createWhatsAppRuntime({
 *   accountId: "personal",
 *   backend: memoryBackend(),
 * });
 *
 * await runtime.start();
 * const client = await createWhatsAppClient(runtime);
 * console.log(client.account.get().connection?.phase);
 * await client.close();
 * ```
 */
export function createWhatsAppRuntime(config: WhatsAppRuntimeConfig): WhatsAppRuntime {
  return createWhatsAppRuntimeWithSessionFactory(config, productionSessionFactory);
}

/**
 * Internal construction seam used by the production factory above and the
 * deterministic adapter exported from `whatsappd/testing`.
 */
export function createWhatsAppRuntimeWithSessionFactory(
  config: WhatsAppRuntimeConfig,
  sessionFactory: RuntimeSessionFactory,
): WhatsAppRuntime {
  const { accountId, backend } = config;
  const holderId = config.holderId ?? crypto.randomUUID();
  const leaseTtlMs = config.leaseTtlMs ?? 30_000;
  const freshnessMs = config.freshnessMs ?? 15_000;
  const operationAttemptTtlMs = config.operationAttemptTtlMs ?? 30_000;

  const durableListeners = new Set<Registration<RuntimeDurableFrame>>();
  const liveListeners = new Set<Registration<RuntimeLiveFrame>>();

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
  /**
   * The claim a deliberate stop is draining Session work under.
   *
   * @remarks
   * Cleared only after the Session and its supervised event pipeline settle.
   * Automatic teardown never sets it: after lease loss, a late write must
   * still fail rather than reaching the mirror under a claim this runtime no
   * longer owns.
   */
  let drainingClaim: AccountLease | undefined;
  let session: RuntimeSession | undefined;
  let unsubscribe: Unsubscribe | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | undefined;
  let supervisor: Promise<void> | undefined;
  let operationExecutor: OperationExecutor | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let registration: RuntimeRegistration | undefined;
  let checkingRegistration: Promise<RuntimeRegistration> | undefined;
  let pairingLink: Extract<WhatsAppLinkState, { readonly status: "pairing" }> | undefined;
  let unlinkingSession: RuntimeSession | undefined;
  let pairingAttempt:
    | {
        readonly operationId: string;
        readonly resolve: (result: unknown) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  const challengeByOperation = new Map<
    string,
    {
      readonly id: string;
      readonly method: "qr" | "pairing_code";
      readonly expiresAt: number;
    }
  >();
  const clearPairingChallenges = async (): Promise<void> => {
    const challenges = Array.from(challengeByOperation.values());
    challengeByOperation.clear();
    await Promise.all(
      challenges.map((challenge) => backend.pairingChallenges.clear(accountId, challenge.id)),
    );
  };
  /** A terminal session failure, held until a `stop()` reports it. */
  let failure: { readonly error: unknown } | undefined;
  let terminal: Extract<RuntimeDurableFrame, { type: "closed" }> | undefined;
  /** Late subscribers owed the terminal frame, and those handed it in this drain. */
  const owedTerminal: Array<(frame: RuntimeDurableFrame) => void> = [];
  const handedTerminal = new Set<(frame: RuntimeDurableFrame) => void>();
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
  const replayTerminal = (listener: (frame: RuntimeDurableFrame) => void): void => {
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

  const publishDurable = (frame: RuntimeDurableFrame): void => deliver(durableListeners, frame);
  const publishLive = (frame: RuntimeLiveFrame): void => deliver(liveListeners, frame);

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
    const claim = lease ?? drainingClaim;
    // Writing without a claim is exactly what the lease exists to prevent, so
    // an event that outlives its claim fails rather than reaching the mirror.
    // `drainingClaim` exists only while an explicit stop joins work that was
    // already inside the Session pipeline before its subscription was removed.
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
      if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
        registration = "unregistered";
        const attempt = pairingAttempt;
        const value = status.pairing.qr ?? status.pairing.code;
        if (attempt && value) {
          const challengeId = crypto.randomUUID();
          await backend.pairingChallenges.publish({
            id: challengeId,
            accountId,
            method: status.pairing.method,
            value,
            expiresAt: status.pairing.expiresAt,
          });
          challengeByOperation.set(attempt.operationId, {
            id: challengeId,
            method: status.pairing.method,
            expiresAt: status.pairing.expiresAt,
          });
          pairingLink = {
            status: "pairing",
            operationId: attempt.operationId,
            method: status.pairing.method,
            challengeId,
            expiresAt: status.pairing.expiresAt,
          };
        }
      } else if (isOnline(status)) {
        registration = "registered";
        pairingLink = undefined;
        await clearPairingChallenges();
        const attempt = pairingAttempt;
        pairingAttempt = undefined;
        attempt?.resolve({});
      }
      if (isOnline(status)) operationExecutor?.resume();
      else operationExecutor?.pause();
      const observedAt = Date.now();
      publishLive({
        type: "connection",
        state: {
          status: publicConnectionStatus(status),
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
   * waiting for a startup suspended inside the Session factory: whatever
   * it acquires after this runs, it releases itself on the way out.
   */
  async function release(): Promise<void> {
    const timer = heartbeat;
    const off = unsubscribe;
    const claim = lease;
    const open = session;
    const running = supervisor;
    const executor = operationExecutor;
    const pairing = pairingAttempt;
    const deliberateDrain = claim !== undefined && drainingClaim === claim;
    heartbeat = undefined;
    unsubscribe = undefined;
    lease = undefined;
    session = undefined;
    supervisor = undefined;
    operationExecutor = undefined;
    pairingAttempt = undefined;
    pairing?.reject(new AccountNotHeldError(accountId, "stopped", "pairing was stopped"));

    if (timer && !deliberateDrain) clearInterval(timer);
    off?.();
    const stopOperations = () => settle(executor?.stop() ?? Promise.resolve());
    const stopSession = () => settle(Promise.resolve().then(() => open?.stop?.()));
    const [operationOutcome, closeOutcome] =
      executor?.activeOperationType() === "unlink"
        ? [await stopOperations(), await stopSession()]
        : await Promise.all([stopOperations(), stopSession()]);
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
    // Nothing awaited the supervisor while the session ran, so its terminal
    // failure — a rejected handler, a dead socket — arrives here. It is joined
    // even when stop() failed.
    const runOutcome = await settle(running ?? Promise.resolve());
    if (timer) clearInterval(timer);
    const renewalOutcome = deliberateDrain
      ? await settle(renewing ?? Promise.resolve())
      : undefined;
    const finalClaim = deliberateDrain ? drainingClaim : (lease ?? claim);
    const stampOutcome =
      off && finalClaim
        ? await settle(
            acceptUnder(finalClaim, {
              type: "account_connection",
              kind: "disconnected",
              at: Date.now(),
            }),
          )
        : undefined;
    const challengeOutcome = await settle(clearPairingChallenges());
    lease = undefined;
    drainingClaim = undefined;
    // A claim outliving a failed close would lock the account out until its TTL
    // expired, so releasing it does not depend on either close outcome.
    const releaseOutcome = finalClaim
      ? await settle(backend.leases.release(finalClaim))
      : undefined;
    const rejected = firstRejection(
      [
        runOutcome,
        operationOutcome,
        closeOutcome,
        renewalOutcome,
        stampOutcome,
        challengeOutcome,
        releaseOutcome,
      ].filter((result) => result !== undefined),
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
    // Only the public, deliberate stop path may finish work that entered the
    // Session pipeline under the current claim. If automatic teardown already
    // began because the lease or Session was lost, leaving this unset preserves
    // the fail-closed guard for every late write.
    if (!stopping) drainingClaim = lease;
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
    const held = lease ?? drainingClaim;
    if (!held || (stopped && !drainingClaim)) return;
    let result: Awaited<ReturnType<AccountLeaseStore["renew"]>>;
    try {
      result = await backend.leases.renew(held, leaseTtlMs);
    } catch (error) {
      failure ??= { error };
      if (!stopped) await halt();
      return;
    }
    // A stop or a later claim may have cleared/replaced this lease while the
    // backend call was in flight. Its stale result must not resurrect either.
    const draining = drainingClaim === held;
    if ((stopped && !drainingClaim) || (!draining && lease !== held)) return;
    if (result.renewed) {
      if (draining) drainingClaim = result.lease;
      else lease = result.lease;
    } else {
      if (draining) drainingClaim = undefined;
      else lease = undefined; // gone; releasing it would evict its new holder
      if (!stopped) await halt();
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

  async function inspectRegistration(): Promise<RuntimeRegistration> {
    if (registration) return registration;
    const check =
      checkingRegistration ??
      (checkingRegistration = sessionFactory.registration(backend.credentials));
    try {
      return (registration ??= await check);
    } finally {
      if (checkingRegistration === check) checkingRegistration = undefined;
    }
  }

  const requireSession = (): RuntimeSession => {
    const attached = session;
    if (!attached) throw new TypeError("runtime has no linked Session");
    return attached;
  };

  async function pair(
    input: Extract<WhatsAppOperationInput, { readonly type: "pair" }>,
    operationId: string,
  ): Promise<unknown> {
    if ((await inspectRegistration()) === "registered" || session)
      throw new TypeError("runtime session is already linked");
    if (pairingAttempt) throw new TypeError("runtime is already pairing");

    pairingLink = { status: "pairing", operationId, method: input.method };
    let resolve!: (result: unknown) => void;
    let reject!: (error: unknown) => void;
    const linked = new Promise<unknown>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pairingAttempt = { operationId, resolve, reject };
    let opened: RuntimeSession | undefined;
    try {
      opened = await sessionFactory.open(backend.credentials, authForPair(input));
      attach(opened);
      return linked;
    } catch (error) {
      if (pairingAttempt?.operationId === operationId) pairingAttempt = undefined;
      pairingLink = undefined;
      if (session === opened) {
        unsubscribe?.();
        unsubscribe = undefined;
        session = undefined;
        supervisor = undefined;
      }
      await opened?.stop?.().catch(() => {});
      await clearPairingChallenges();
      throw error;
    }
  }

  async function unlink(): Promise<unknown> {
    const open = requireSession();
    if ((await inspectRegistration()) !== "registered" || !open.unlink)
      throw new TypeError("runtime session does not support unlink");
    unlinkingSession = open;
    try {
      await open.unlink();
    } catch (error) {
      unlinkingSession = undefined;
      if (session === open) void halt().catch(() => {});
      throw error;
    }
    const off = unsubscribe;
    const running = supervisor;
    unsubscribe = undefined;
    session = undefined;
    supervisor = undefined;
    off?.();
    const [stopOutcome, runOutcome] = await Promise.all([
      settle(Promise.resolve().then(() => open.stop?.())),
      settle(running ?? Promise.resolve()),
    ]);
    unlinkingSession = undefined;
    registration = "unregistered";
    pairingLink = undefined;
    await clearPairingChallenges();
    const observedAt = Date.now();
    publishLive({
      type: "connection",
      state: {
        status: { phase: "logged_out", reason: "intentional" },
        observedAt,
        expiresAt: observedAt + freshnessMs,
        fencingToken: lease?.fencingToken ?? 0,
      },
    });
    const rejected = firstRejection([stopOutcome, runOutcome]);
    if (rejected) throw rejected.reason;
    return {};
  }

  const operationSession = createRuntimeOperationSession({
    current: requireSession,
    async validatePair() {
      if ((await inspectRegistration()) === "registered" || session)
        throw new TypeError("runtime session is already linked");
      if (pairingAttempt) throw new TypeError("runtime is already pairing");
    },
    pair,
    async validateUnlink() {
      const open = requireSession();
      if ((await inspectRegistration()) !== "registered" || !open.unlink)
        throw new TypeError("runtime session does not support unlink");
    },
    unlink,
  });

  function attach(opened: RuntimeSession): void {
    session = opened;
    unsubscribe = opened.subscribe(handlers);
    supervisor = opened.start?.();
    const ended = (error?: unknown): void => {
      if (unlinkingSession === opened) return;
      if (pairingAttempt && session === opened) {
        const attempt = pairingAttempt;
        pairingAttempt = undefined;
        attempt.reject(error ?? new Error("pairing Session ended before linking"));
      }
      if (!stopped && session === opened) void halt().catch(() => {});
    };
    void supervisor?.then(
      () => ended(),
      (error) => ended(error),
    );
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

    registration = await inspectRegistration();
    if (stopped) throw stoppedWhileStarting();
    operationExecutor = createOperationExecutor({
      accountId,
      store: backend.operations,
      media: backend.media,
      session: operationSession,
      attemptTtlMs: operationAttemptTtlMs,
      onError(error) {
        failure ??= { error };
        if (!stopped) void halt().catch(() => {});
      },
    });
    if (registration === "unregistered") {
      operationExecutor.resume();
      return;
    }

    const opened = await sessionFactory.open(backend.credentials, resumeAuth());
    // A stop() that ran while the session was opening has already released the
    // claim, so subscribing now would consume WhatsApp with no claim at all —
    // possibly alongside the worker that took the account over.
    if (stopped) throw stoppedWhileStarting();
    attach(opened);
    if (opened.status === undefined || isOnline(opened.status)) operationExecutor.resume();
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

  /** Whether a session's failure to report its identity has been surfaced. */
  let identityFaultReported = false;

  /** The claim as anything outside this closure may hold it (ADR-0030). */
  const currentClaim = (): ClientClaim | undefined =>
    lease && { fencingToken: lease.fencingToken, expiresAt: lease.expiresAt };

  const runtime: InProcessWhatsAppRuntime = {
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

  clientSourceFor.set(
    runtime,
    createClientRuntimeSource({
      runtime,
      backend,
      currentClaim,
      identity: () => {
        try {
          return session?.identity?.();
        } catch (error) {
          if (!identityFaultReported) {
            identityFaultReported = true;
            surface(error);
          }
          return undefined;
        }
      },
      linkState: () => linkStateOf(registration, pairingLink),
      wake: () => setImmediate(() => operationExecutor?.wake()),
      async submitPair(input) {
        const operation = await submitPairOperation({
          accountId,
          registration: await inspectRegistration(),
          store: backend.operations,
          submission: input,
        });
        setImmediate(() => operationExecutor?.wake());
        return operation;
      },
      async submitUnlink(input) {
        const operation = await submitUnlinkOperation({
          accountId,
          linked: (await inspectRegistration()) === "registered" && session !== undefined,
          store: backend.operations,
          submission: input,
        });
        setImmediate(() => operationExecutor?.wake());
        return operation;
      },
      async consumePairingChallenge(operationId) {
        const metadata = challengeByOperation.get(operationId);
        if (!metadata) return null;
        const challenge = await backend.pairingChallenges.consume(accountId, metadata.id);
        if (challengeByOperation.get(operationId)?.id === metadata.id)
          challengeByOperation.delete(operationId);
        return challenge
          ? {
              method: challenge.method,
              value: challenge.value,
              expiresAt: challenge.expiresAt,
            }
          : null;
      },
    }),
  );

  return runtime;
}
