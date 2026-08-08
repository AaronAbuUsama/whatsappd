/**
 * The session orchestrator. Feeds raw socket events through the pure connection
 * state machine, owns the timers the machine cannot (the pairing verdict window
 * and reconnect backoff), drives reconnection, and exposes the public surface:
 * one awaited typed subscription plus `start`/`send`/`stop`. It makes only
 * timing decisions — never protocol ones.
 */
import pino, { type Logger } from "pino";
import { assertE164 } from "./errors.ts";
import { createPacer } from "./pacer.ts";
import type { MetricEvent, MetricsHook } from "./model/metrics.ts";
import { initialState, transition, type Input, type MachineCtx } from "./machine.ts";
import type { GroupMetadata, Outbound, Status, WaIdentity } from "./model/index.ts";
import type { MessageRef, SendOptions } from "./model/outbound.ts";
import { isTerminal } from "./model/index.ts";
import type { AuthStrategy, CredentialStore } from "./ports.ts";
import { settle } from "./outcome.ts";
import { loadAuth } from "./baileys/auth-state.ts";
import { openSocket, type BaileysConn, type RawEvent } from "./baileys/socket.ts";
import {
  createSubscriptionDispatcher,
  SubscriptionHandlerError,
  type Unsubscribe,
  type WhatsAppSessionHandlers,
} from "./subscription.ts";

const QR_FIRST_MS = 60_000;
const QR_REFRESH_MS = 20_000;

/**
 * Fields the default logger censors.
 *
 * @remarks
 * Every deliberate log call in this codebase already passes a hand-built
 * object of counts and flags — `qrChars` rather than the QR, chat totals
 * rather than chats. Those were never the risk.
 *
 * The risk is the two sites that log `{ err }`, where the error comes from
 * Baileys or a socket and its shape is not ours to choose. A send failure can
 * carry the outbound payload, and an HTTP-ish failure can carry request
 * headers, so the message body, the recipient, and an auth token all reach the
 * log through an object nobody here constructed. That was verified rather than
 * assumed: an error carrying all three serialized every one of them in full.
 *
 * The wildcards are one level deep by design — `*.text` and `err.data.*`
 * rather than a recursive sweep — because redaction that walks the whole tree
 * costs on every log call, including the ones that carry nothing sensitive.
 * The `err.*` entries are listed explicitly because that is the path that
 * actually leaked.
 */
export const REDACTED_PATHS = [
  // Message content, wherever it surfaces.
  "*.text",
  "*.body",
  "*.caption",
  "err.data.text",
  "err.data.body",
  "err.data.caption",
  "err.data.message",
  // Addresses — a phone number is identifying on its own.
  "*.jid",
  "*.to",
  "*.from",
  "*.sender",
  "*.remoteJid",
  "*.participant",
  "*.participantAlt",
  "node.username",
  "pnUser",
  "lidUser",
  "fromJid",
  "myPN",
  "myLID",
  "xml",
  "helloMsg.clientHello.ephemeral",
  "handshake.serverHello.ephemeral",
  "handshake.serverHello.static",
  "handshake.serverHello.payload",
  "err.data.to",
  "err.data.from",
  "err.data.jid",
  "err.data.remoteJid",
  "err.data.participant",
  "err.data.participantAlt",
  "err.stack",
  // Anything that would let someone else become this session. Listed at the
  // top level as well as under a wildcard, because `*.token` matches a token
  // one level down and not a `token` on the logged object itself — a
  // distinction a test caught after the wildcard-only list looked complete.
  "*.authorization",
  "*.token",
  "*.authToken",
  "*.creds",
  "*.keys",
  "*.password",
  "authorization",
  "token",
  "authToken",
  "creds",
  "keys",
  "password",
  "err.config.headers.authorization",
  "err.config.headers.cookie",
];

/** Configuration for {@link createSession}. */
export interface SessionConfig {
  /** Where this session's credentials are persisted. */
  store: CredentialStore;
  /** How this session logs in — {@link qrAuth} or {@link pairingAuth}. */
  auth: AuthStrategy;
  /**
   * Logger to use.
   *
   * @defaultValue a `pino` logger at the level in `WA_LOG_LEVEL`, or `warn`.
   */
  logger?: Logger;
  /**
   * How long to wait after a pairing attempt for confirmation before treating
   * the silent rejection as final, in milliseconds.
   */
  verdictWindowMs?: number;
  /**
   * Grace period after the socket opens before forcing the `online` status if
   * no history-sync signal has arrived, in milliseconds.
   */
  syncGraceMs?: number;
  /** Base delay for reconnect backoff, in milliseconds. */
  reconnectBaseMs?: number;
  /** Maximum delay for reconnect backoff, in milliseconds. */
  reconnectMaxMs?: number;
  /**
   * Whether to surface WhatsApp Status/story posts (`status@broadcast`) on the
   * message handler.
   *
   * @defaultValue `false`
   */
  receiveStatusBroadcast?: boolean;
  /**
   * Minimum gap between outbound sends, in milliseconds, to reduce the risk of
   * rate-limiting. Set to `0` to disable pacing.
   *
   * @defaultValue `1000`
   */
  sendMinGapMs?: number;
  /**
   * Fire-and-forget observability hook. Errors it throws are swallowed so
   * instrumentation can never disrupt the session.
   */
  metrics?: MetricsHook;
}

/**
 * One WhatsApp account's live session: one awaited subscription plus the
 * commands that act on the connection. Create one with {@link createSession}
 * and call {@link WhatsAppSession.start | start} to connect.
 */
export interface WhatsAppSession {
  /** The current connection status. */
  readonly status: Status;
  /** Register any subset of handlers and receive one cleanup function. */
  subscribe(
    handlers: WhatsAppSessionHandlers,
    options?: { readonly signal?: AbortSignal },
  ): Unsubscribe;

  /** Connect to WhatsApp and begin delivering subscribed events. */
  start(): Promise<void>;
  /**
   * Send a message to a chat.
   *
   * @param to - The destination chat JID.
   * @param msg - The message content to send.
   * @param opts - Optional quoting and mentions.
   * @returns A reference to the sent message, for later quote/react/edit/delete.
   */
  send(to: string, msg: Outbound, opts?: SendOptions): Promise<MessageRef>;
  /**
   * Mark messages as read (blue ticks).
   *
   * @param refs - References to the messages to acknowledge.
   */
  markRead(refs: MessageRef[]): Promise<void>;
  /**
   * Show or clear the typing indicator in a chat.
   *
   * @param chatId - The chat JID to signal in.
   * @param on - `true` to show typing, `false` to clear it.
   */
  setTyping(chatId: string, on: boolean): Promise<void>;
  /**
   * Fetch normalized metadata for a group.
   *
   * @param chatId - The group JID.
   */
  groupMetadata(chatId: string): Promise<GroupMetadata>;
  /**
   * Fetch a profile picture URL.
   *
   * @param jid - A contact, account, or group JID.
   * @param type - `"image"` for full size or `"preview"` for a thumbnail.
   * @returns The URL, or `undefined` when none is available.
   */
  profilePictureUrl(jid: string, type?: "image" | "preview"): Promise<string | undefined>;
  /** Remove this linked companion from WhatsApp and clear this Session's credentials. */
  unlink(): Promise<void>;
  /**
   * Ask the linked phone for older messages in one chat, going back from the
   * given anchor message. **Fire-and-hope: the phone may never answer.**
   *
   * @remarks
   * This is an explicit, asynchronous protocol request (ADR-0010). Resolution
   * means exactly one thing: the request stanza was handed to the transport.
   * It does not await or prove server acceptance, it does not mean the phone
   * received it (that happens later, if at all, and is not surfaced here),
   * and it does not mean any history exists or will arrive. Treat a request
   * that produces nothing as an expected outcome, not an error.
   *
   * If an answer comes, messages arrive later as `conversationSync` batches
   * with `context.source === "on_demand"` and `context.requestSessionId`
   * intended to echo this receipt's `requestId` — best-effort correlation,
   * not a guarantee. There is NO completion, exhaustion, or delivered-count
   * signal, and none can be synthesized: silence and "no older messages" are
   * indistinguishable. UI built on this may say "request sent" or "no older
   * saved messages"; it must never claim "all history loaded".
   *
   * Do not await "the result" — there is no result to await. Subscribe to
   * `conversationSync` and treat anything that arrives as a windfall. For
   * live-proof status, observed response rates, and device/platform caveats,
   * see `docs/history-semantics.md` — the single home for those observations.
   *
   * @param anchor - The oldest known message to page back from: its ref plus
   * its timestamp in epoch milliseconds.
   * @param opts - Optional request size; `count` defaults to 50, the protocol
   * request maximum (ADR-0010) — values outside 1..50 are rejected. Not a
   * guarantee that more messages exist.
   * @returns A submission receipt; `requestId` is the outgoing request
   * message id.
   */
  requestHistory(
    anchor: { readonly ref: MessageRef; readonly timestamp: number },
    opts?: { readonly count?: number },
  ): Promise<{ requestId: string }>;
  /**
   * The connected account's own identity.
   *
   * @returns The identity once the socket is open, or `undefined` before then.
   */
  identity(): WaIdentity | undefined;
  /** Tear down the session intentionally; never reported as a fault. */
  stop(): Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A protocol observation reached the session but could not be fully processed. */
class SessionProcessingError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("session event processing failed", { cause });
    this.name = "SessionProcessingError";
    this.cause = cause;
  }
}

type SessionFailureKind = "subscriber" | "teardown" | "run";

class SessionFailure extends Error {
  readonly kind: SessionFailureKind;
  readonly reason: unknown;

  constructor(kind: SessionFailureKind, reason: unknown) {
    super(`session ${kind} failure`, { cause: reason });
    this.name = "SessionFailure";
    this.kind = kind;
    this.reason = reason;
  }
}

const failureFrom = (
  outcome: PromiseSettledResult<unknown> | undefined,
  fallback: Exclude<SessionFailureKind, "subscriber">,
): SessionFailure | undefined =>
  outcome?.status === "rejected"
    ? new SessionFailure(
        outcome.reason instanceof SubscriptionHandlerError ? "subscriber" : fallback,
        outcome.reason,
      )
    : undefined;

const preferredFailure = (
  failures: readonly (SessionFailure | undefined)[],
): SessionFailure | undefined => {
  for (const kind of ["subscriber", "teardown", "run"] as const) {
    const failure = failures.find((candidate) => candidate?.kind === kind);
    if (failure) return failure;
  }
  return undefined;
};

/**
 * Create a single WhatsApp account session.
 *
 * @remarks
 * The returned session is inert until {@link WhatsAppSession.start | start} is
 * called. Subscribe to observe live events; call its command methods to send
 * and interact.
 *
 * @param config - Store, auth strategy, and optional tuning — see
 * {@link SessionConfig}.
 * @returns A not-yet-connected {@link WhatsAppSession}.
 *
 * @example
 * ```ts
 * import { createSession, qrAuth, fileStore, refOf } from "whatsappd";
 *
 * const session = createSession({
 *   store: fileStore("./.wa-auth"),
 *   auth: qrAuth(),
 * });
 *
 * session.subscribe({
 *   connection(status) {
 *     if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
 *       console.log("scan:", status.pairing.qr ?? status.pairing.code);
 *     }
 *   },
 * });
 *
 * await session.start();
 * ```
 */
export function createSession(config: SessionConfig): WhatsAppSession {
  const { store, auth } = config;
  // A library shouldn't spam stdout uninvited, but reconnect/fault warnings are
  // worth surfacing — default to `warn`, overridable via env or an explicit logger.
  const logger =
    config.logger ??
    pino({ level: process.env.WA_LOG_LEVEL ?? "warn", redact: { paths: REDACTED_PATHS } });
  const receiveStatusBroadcast = config.receiveStatusBroadcast ?? false;
  const pacer = createPacer(config.sendMinGapMs ?? 1000);
  // A thrown metrics hook must never break the connection.
  const emit = (event: MetricEvent): void => {
    try {
      config.metrics?.(event);
    } catch (err) {
      logger.warn({ err }, "metrics hook threw");
    }
  };
  const ctx: MachineCtx = {
    method: auth.method,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
  };
  const verdictWindowMs = config.verdictWindowMs ?? 30_000;
  const syncGraceMs = config.syncGraceMs ?? 3_000;

  let status: Status = initialState;
  let stopped = false;
  let supervisor: Promise<void> | undefined;
  let started: Promise<void> | undefined;
  let conn: BaileysConn | undefined;
  const dispatcher = createSubscriptionDispatcher((to, content, options) =>
    send(to, content, options),
  );
  // Test seam: override how the underlying socket is opened (kept off the public
  // SessionConfig type). Defaults to the real openSocket.
  const openSocketImpl = (config as { openSocket?: typeof openSocket }).openSocket ?? openSocket;

  // Per-socket pairing bookkeeping (reset on each open).
  let firstQrSeen = false;
  let verdictTimer: ReturnType<typeof setTimeout> | undefined;
  let verdictFired = false;
  let initialSyncComplete = false;
  // Returning-device backstop: Baileys skips history once accountSyncCounter proves
  // the first history/app-state sync already completed. Fresh post-pairing creds
  // are registered but must still wait for history status.
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let eventPipeline = Promise.resolve();
  let signalPipelineFailure: (error: unknown) => void = () => {};

  function enqueue(work: () => Promise<void>): Promise<void> {
    const task = eventPipeline.then(work);
    eventPipeline = task;
    void task.catch(signalPipelineFailure);
    return task;
  }

  async function apply(input: Input): Promise<void> {
    const next = transition(status, input, ctx, Date.now());
    if (next === status) return;
    emit({ type: "transition", from: status.phase, to: next.phase });
    // Wipe dead creds BEFORE announcing logged_out, so the guarantee "on
    // logged_out the credentials are gone" holds for any consumer — even one
    // that exits the moment it sees the event.
    if (next.phase === "logged_out") await store.clear();
    status = next;
    await dispatcher.dispatch({ type: "connection", status });
  }

  function clearVerdict(): void {
    if (verdictTimer) clearTimeout(verdictTimer);
    verdictTimer = undefined;
  }

  function clearSync(): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
  }

  function armSync(): void {
    clearSync();
    syncTimer = setTimeout(() => {
      void enqueue(() => apply({ t: "synced" }));
    }, syncGraceMs);
  }

  function fireVerdict(): void {
    if (verdictFired) return;
    verdictFired = true;
    clearVerdict();
    void enqueue(() => apply({ t: "pairing_rejected" })); // the silent 400 — no event ever came
  }

  async function handle(ev: RawEvent): Promise<void> {
    switch (ev.t) {
      case "connecting":
        return; // fires before the socket is open — never a readiness signal
      case "qr": {
        if (!firstQrSeen) {
          firstQrSeen = true;
          await apply({ t: "ready", qr: ev.qr, expiresAt: Date.now() + QR_FIRST_MS });
          if (auth.method === "pairing_code" && conn) {
            // Baileys 7 requires the first QR event to prove the socket is ready
            // before requestPairingCode(); requesting at socket creation gets 428.
            const code = await conn.requestPairingCode(assertE164(auth.phone).replace(/^\+/, ""));
            await apply({ t: "code_ready", code, expiresAt: Date.now() + verdictWindowMs });
            verdictTimer = setTimeout(fireVerdict, verdictWindowMs);
          }
          return;
        }
        // A refresh.
        if (auth.method === "qr") {
          await apply({ t: "qr_refresh", qr: ev.qr, expiresAt: Date.now() + QR_REFRESH_MS });
        } else {
          fireVerdict(); // pairing-code: a refresh without `paired` == rejection
        }
        return;
      }
      case "paired":
        clearVerdict();
        await apply({ t: "paired" });
        return;
      case "open":
        await apply({ t: "open" });
        if (initialSyncComplete) armSync();
        return;
      case "pending_drained":
        await apply({ t: "pending_drained" });
        if (initialSyncComplete) {
          clearSync();
          await apply({ t: "synced" }); // returning device already completed initial sync
        }
        return;
      case "conversation_sync_progress":
        await apply({ t: "sync_progress", progress: ev.progress });
        return;
      case "conversation_sync_complete":
        clearSync();
        await apply({ t: "synced" });
        return;
      case "conversation_sync":
        return dispatcher.dispatch({ type: "conversation_sync", batch: ev.sync });
      case "message":
        // Status/story posts arrive as ordinary messages on a reserved jid;
        // most consumers don't want them, so drop unless explicitly opted in.
        if (!receiveStatusBroadcast && ev.msg.chatId === "status@broadcast") return;
        emit({ type: "message_in", kind: ev.msg.kind, live: ev.msg.live });
        return dispatcher.dispatch({ type: "message", message: ev.msg });
      case "update":
        emit({ type: "update_in", kind: ev.update.kind });
        return dispatcher.dispatch({ type: "update", update: ev.update });
      case "contact":
        emit({
          type: "contact_in",
          hasDisplayName: Boolean(ev.contact.displayName),
          identityCount: ev.contact.nativeIds.length,
        });
        return dispatcher.dispatch({ type: "contact", contact: ev.contact });
      case "group":
        emit({ type: "group_in", kind: ev.group.kind });
        return dispatcher.dispatch({ type: "group", group: ev.group });
      case "presence":
        emit({ type: "presence_in", kind: ev.presence.kind });
        return dispatcher.dispatch({ type: "presence", presence: ev.presence });
      case "close":
        clearVerdict();
        clearSync();
        await apply({ t: "close", fault: ev.fault });
        return;
    }
  }

  async function runOnce(): Promise<void> {
    firstQrSeen = false;
    verdictFired = false;
    clearVerdict();
    clearSync();
    eventPipeline = Promise.resolve();
    let reportFailure!: (error: unknown) => void;
    const pipelineFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    signalPipelineFailure = reportFailure;
    const body = await settle(
      (async () => {
        const auth = await loadAuth(store);
        initialSyncComplete = auth.initialSyncComplete;
        conn = await openSocketImpl({
          auth: { creds: auth.creds, keys: auth.keys },
          authMethod: config.auth.method,
          saveCreds: auth.saveCreds,
          logger,
        });

        // stop() may have run while openSocket() was in flight — conn was still
        // undefined then, so stop()'s `conn?.end()` was a no-op. Without this guard
        // the freshly opened socket would leak: the loop below would block on its
        // events after the session was already stopped. Tear it down and bail.
        if (stopped) {
          await conn.end();
          return;
        }

        const events = conn.events[Symbol.asyncIterator]();
        while (true) {
          const next = await Promise.race([
            events.next().then((result) => ({ type: "event" as const, result })),
            pipelineFailure.then((error) => ({ type: "failure" as const, error })),
          ]);
          if (next.type === "failure") throw next.error;
          if (next.result.done) break;
          await enqueue(async () => {
            try {
              await handle(next.result.value);
            } catch (error) {
              throw error instanceof SubscriptionHandlerError
                ? error
                : new SessionProcessingError(error);
            }
          });
        }
        await eventPipeline;
      })(),
    );
    signalPipelineFailure = () => {};

    const teardown = await settle(Promise.resolve(conn?.end()));
    const disconnected =
      teardown.status === "rejected"
        ? await (async () => {
            stopped = true;
            return settle(apply({ t: "stop" }));
          })()
        : undefined;
    const failure = preferredFailure([
      failureFrom(body, "run"),
      failureFrom(disconnected, "run"),
      failureFrom(teardown, "teardown"),
    ]);
    if (failure) throw failure;
  }

  async function failTerminal(failure: SessionFailure): Promise<never> {
    stopped = true;
    const disconnected = await settle(apply({ t: "stop" }));
    const disconnectedFailure = failureFrom(disconnected, "run");
    const reason = failure.reason;
    const terminal =
      reason instanceof SubscriptionHandlerError || reason instanceof SessionProcessingError
        ? new SessionFailure(failure.kind, reason.cause)
        : failure;
    throw preferredFailure([
      disconnectedFailure?.reason instanceof SubscriptionHandlerError
        ? new SessionFailure("subscriber", disconnectedFailure.reason.cause)
        : disconnectedFailure,
      terminal,
    ]);
  }

  async function supervise(): Promise<void> {
    const initial = await settle(apply({ t: "start" }));
    const initialFailure = failureFrom(initial, "run");
    if (initialFailure) return failTerminal(initialFailure);
    while (!stopped) {
      await runOnce().catch(async (error: unknown) => {
        const failure = error instanceof SessionFailure ? error : new SessionFailure("run", error);
        const reason = failure.reason;
        if (reason instanceof SubscriptionHandlerError || reason instanceof SessionProcessingError)
          return failTerminal(failure);
        if (stopped) throw failure;
        logger.error({ err: reason }, "session run errored");
        // Treat an open/run failure as a retryable transport close.
        await apply({
          t: "close",
          fault: { reason: "unknown", retryable: true, disposition: "retryable" },
        });
      });

      // logged_out already wiped creds inside apply(), before the event fired.
      if (isTerminal(status)) break;
      if (status.phase === "disconnected") break; // intentional stop

      if (status.phase === "backing_off") {
        const attempt = status.retryAttempt;
        await delay(Math.max(0, status.nextRetryAt - Date.now()));
        if (stopped) break;
        emit({ type: "reconnect", attempt });
        await apply({ t: "retry_due" }); // → connecting; loop reopens
      }
      // status is now `connecting` (515 restart or post-backoff) → reopen
    }
  }

  const send: WhatsAppSession["send"] = async (to, msg, opts) => {
    if (status.phase !== "online" || !conn) throw new Error(`not online (phase: ${status.phase})`);
    const c = conn;
    const ref = await pacer.run(() => c.send(to, msg, opts)); // FIFO + anti-ban gap
    emit({ type: "message_out" });
    return ref;
  };

  return {
    get status() {
      return status;
    },
    subscribe: (handlers, options) => dispatcher.subscribe(handlers, options),
    // Idempotent: hand back the one running supervisor so stop() can await it.
    start() {
      if (!started) {
        supervisor = supervise();
        started = supervisor.catch((error: unknown) => {
          throw error instanceof SessionFailure ? error.reason : error;
        });
        // Preserve the same rejecting promise for awaiting callers while a
        // documented detached start remains owned by the session itself.
        void started.catch(() => {});
      }
      return started;
    },
    send,
    async markRead(refs) {
      if (status.phase !== "online" || !conn)
        throw new Error(`not online (phase: ${status.phase})`);
      return conn.markRead(refs);
    },
    async setTyping(chatId, on) {
      if (status.phase !== "online" || !conn)
        throw new Error(`not online (phase: ${status.phase})`);
      return conn.setTyping(chatId, on);
    },
    async groupMetadata(chatId) {
      if (status.phase !== "online" || !conn)
        throw new Error(`not online (phase: ${status.phase})`);
      return conn.groupMetadata(chatId);
    },
    async profilePictureUrl(jid, type) {
      if (status.phase !== "online" || !conn)
        throw new Error(`not online (phase: ${status.phase})`);
      return conn.profilePictureUrl(jid, type);
    },
    async unlink() {
      if (status.phase !== "online" || !conn)
        throw new Error(`not online (phase: ${status.phase})`);
      await conn.logout();
      await store.clear();
    },
    async requestHistory(anchor, opts) {
      if (status.phase !== "online" || !conn)
        throw new Error(`not online (phase: ${status.phase})`);
      const count = opts?.count ?? 50;
      // ADR-0010: 50 is the validated protocol request maximum, not a paging size.
      if (!Number.isInteger(count) || count < 1 || count > 50)
        throw new RangeError(`count must be an integer in 1..50, got ${count}`);
      const requestId = await conn.requestHistory(count, anchor.ref, anchor.timestamp);
      return { requestId };
    },
    identity: () => conn?.identity(),
    async stop() {
      stopped = true;
      clearVerdict();
      clearSync();
      const teardown = await settle(Promise.resolve(conn?.end()));
      // Always wait for the supervisor to finish tearing down (incl. any socket
      // opened after this call) so stop() never returns while a live socket
      // lingers — even when end() rejected above.
      const supervised = supervisor
        ? await settle(supervisor)
        : ({ status: "fulfilled", value: undefined } as const);
      // A stop that landed before a socket existed has no close event to move
      // the machine. Settle it explicitly after all late-open teardown finishes.
      const disconnected =
        !isTerminal(status) && status.phase !== "disconnected"
          ? await settle(apply({ t: "stop" }))
          : undefined;
      const supervisedFailure =
        supervised.status === "rejected"
          ? supervised.reason instanceof SessionFailure
            ? supervised.reason
            : new SessionFailure("run", supervised.reason)
          : undefined;
      const failure = preferredFailure([
        failureFrom(disconnected, "run"),
        supervisedFailure,
        failureFrom(teardown, "teardown"),
      ]);
      if (failure)
        throw failure.reason instanceof SubscriptionHandlerError
          ? failure.reason.cause
          : failure.reason;
    },
  };
}
