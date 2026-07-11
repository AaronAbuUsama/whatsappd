/**
 * The session orchestrator. Feeds raw socket events through the pure connection
 * state machine, owns the timers the machine cannot (the pairing verdict window
 * and reconnect backoff), drives reconnection, and exposes the public surface:
 * a set of async-iterable streams plus `start`/`send`/`stop`. It makes only
 * timing decisions — never protocol ones.
 */
import pino, { type Logger } from "pino";
import { assertE164 } from "./errors.ts";
import { createPacer } from "./pacer.ts";
import type { MetricEvent, MetricsHook } from "./model/metrics.ts";
import { initialState, transition, type Input, type MachineCtx } from "./machine.ts";
import type {
  ContactUpdate,
  ConversationSyncBatch,
  ConnectionEvent,
  GroupUpdate,
  InboundMessage,
  PresenceUpdate,
  GroupMetadata,
  Outbound,
  Status,
  Update,
  WaIdentity,
} from "./model/index.ts";
import type { MessageRef, SendOptions } from "./model/outbound.ts";
import { isTerminal } from "./model/index.ts";
import type { AuthStrategy, SessionStore } from "./ports.ts";
import { loadAuth } from "./baileys/authState.ts";
import { openSocket, type BaileysConn, type RawEvent } from "./baileys/socket.ts";
import { Channel } from "./stream.ts";
import { incoming, type IncomingMessage, type Send } from "./incoming.ts";

/** A stream listener; may be async — thrown errors are logged, never fatal. */
export type Listener<T> = (value: T) => void | Promise<void>;
/** Removes a {@link Listener} registered through an `onX` method. */
export type Unsubscribe = () => void;

const QR_FIRST_MS = 60_000;
const QR_REFRESH_MS = 20_000;

/** Configuration for {@link createSession}. */
export interface SessionConfig {
  /** Where this session's credentials are persisted. */
  store: SessionStore;
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
   * inbound stream.
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
 * One WhatsApp account's live session: a set of read-only event streams plus
 * the commands that act on the connection. Create one with {@link createSession}
 * and call {@link WhatsAppSession.start | start} to connect.
 */
export interface WhatsAppSession {
  /** The current connection status (also emitted on {@link connection}). */
  readonly status: Status;
  /** Connection-lifecycle events: pairing, online, backing off, terminal. */
  readonly connection: AsyncIterable<ConnectionEvent>;
  /** Incoming messages, normalized into a closed union. */
  readonly inbound: AsyncIterable<InboundMessage>;
  /** Batches of conversation history delivered during initial sync. */
  readonly conversationSync: AsyncIterable<ConversationSyncBatch>;
  /** Receipts, reactions, edits, and revokes on existing messages. */
  readonly updates: AsyncIterable<Update>;
  /** Address-book and profile-metadata updates from contact events. */
  readonly contacts: AsyncIterable<ContactUpdate>;
  /** Group metadata and participant updates from group events. */
  readonly groups: AsyncIterable<GroupUpdate>;
  /** Ephemeral remote typing/recording/availability signals. */
  readonly presence: AsyncIterable<PresenceUpdate>;

  /**
   * Register a callback for connection-status events. Returns an unsubscribe.
   * Any number of listeners receive each event; a listener that throws or
   * rejects is logged and isolated, never fatal to the connection.
   */
  onStatus(handler: Listener<Status>): Unsubscribe;
  /**
   * Register a callback for inbound messages, each enriched with a bound
   * {@link IncomingMessage.reply | reply}. Returns an unsubscribe.
   */
  onMessage(handler: Listener<IncomingMessage>): Unsubscribe;
  /** Register a callback for receipts/reactions/edits/revokes. */
  onUpdate(handler: Listener<Update>): Unsubscribe;
  /** Register a callback for conversation-history sync batches. */
  onConversationSync(handler: Listener<ConversationSyncBatch>): Unsubscribe;
  /** Register a callback for address-book and profile-metadata updates. */
  onContact(handler: Listener<ContactUpdate>): Unsubscribe;
  /** Register a callback for group metadata and participant updates. */
  onGroup(handler: Listener<GroupUpdate>): Unsubscribe;
  /** Register a callback for remote typing/recording/availability signals. */
  onPresence(handler: Listener<PresenceUpdate>): Unsubscribe;

  /** Connect to WhatsApp and begin emitting on the streams above. */
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

/**
 * Create a single WhatsApp account session.
 *
 * @remarks
 * The returned session is inert until {@link WhatsAppSession.start | start} is
 * called. Consume its streams to observe the connection lifecycle and incoming
 * messages; call its command methods to send and interact.
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
 * for await (const status of session.connection) {
 *   if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
 *     console.log("scan:", status.pairing.qr ?? status.pairing.code);
 *   }
 * }
 *
 * await session.start();
 * ```
 */
export function createSession(config: SessionConfig): WhatsAppSession {
  const { store, auth } = config;
  // A library shouldn't spam stdout uninvited, but reconnect/fault warnings are
  // worth surfacing — default to `warn`, overridable via env or an explicit logger.
  const logger = config.logger ?? pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });
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

  // A listener that throws or rejects is logged and isolated here — never
  // allowed to break event delivery or the connection.
  const onHandlerError = (err: unknown): void => logger.warn({ err }, "event listener threw");
  const connection = new Channel<ConnectionEvent>(onHandlerError);
  const inbound = new Channel<InboundMessage>(onHandlerError);
  const conversationSync = new Channel<ConversationSyncBatch>(onHandlerError);
  const updates = new Channel<Update>(onHandlerError);
  const contacts = new Channel<ContactUpdate>(onHandlerError);
  const groups = new Channel<GroupUpdate>(onHandlerError);
  const presence = new Channel<PresenceUpdate>(onHandlerError);

  let status: Status = initialState;
  let stopped = false;
  let supervisor: Promise<void> | undefined;
  let conn: BaileysConn | undefined;
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

  async function apply(input: Input): Promise<void> {
    const next = transition(status, input, ctx, Date.now());
    if (next === status) return;
    emit({ type: "transition", from: status.phase, to: next.phase });
    // Wipe dead creds BEFORE announcing logged_out, so the guarantee "on
    // logged_out the credentials are gone" holds for any consumer — even one
    // that exits the moment it sees the event.
    if (next.phase === "logged_out") await store.clear().catch(() => {});
    status = next;
    connection.push(status);
    if (isTerminal(status)) {
      connection.close();
      inbound.close();
      conversationSync.close();
      updates.close();
      contacts.close();
      groups.close();
      presence.close();
    }
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
    syncTimer = setTimeout(() => void apply({ t: "synced" }), syncGraceMs);
  }

  function fireVerdict(): void {
    if (verdictFired) return;
    verdictFired = true;
    clearVerdict();
    void apply({ t: "pairing_rejected" }); // the silent 400 — no event ever came
  }

  async function handle(ev: RawEvent): Promise<void> {
    switch (ev.t) {
      case "connecting":
        return; // fires before the socket is open — never a readiness signal
      case "qr": {
        if (!firstQrSeen) {
          firstQrSeen = true;
          await apply({ t: "ready", qr: ev.qr, expiresAt: Date.now() + QR_FIRST_MS });
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
        conversationSync.push(ev.sync);
        return;
      case "message":
        // Status/story posts arrive as ordinary messages on a reserved jid;
        // most consumers don't want them, so drop unless explicitly opted in.
        if (!receiveStatusBroadcast && ev.msg.chatId === "status@broadcast") return;
        inbound.push(ev.msg);
        emit({ type: "message_in", kind: ev.msg.kind, live: ev.msg.live });
        return;
      case "update":
        updates.push(ev.update);
        emit({ type: "update_in", kind: ev.update.kind });
        return;
      case "contact":
        contacts.push(ev.contact);
        emit({
          type: "contact_in",
          hasDisplayName: Boolean(ev.contact.displayName),
          identityCount: ev.contact.nativeIds.length,
        });
        return;
      case "group":
        groups.push(ev.group);
        emit({ type: "group_in", kind: ev.group.kind });
        return;
      case "presence":
        presence.push(ev.presence);
        emit({ type: "presence_in", kind: ev.presence.kind });
        return;
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

    const auth = await loadAuth(store);
    initialSyncComplete = auth.initialSyncComplete;
    conn = await openSocketImpl({
      auth: { creds: auth.creds, keys: auth.keys },
      saveCreds: auth.saveCreds,
      logger,
    });

    // stop() may have run while openSocket() was in flight — conn was still
    // undefined then, so stop()'s `conn?.end()` was a no-op. Without this guard
    // the freshly opened socket would leak: the loop below would block on its
    // events after the session was already stopped. Tear it down and bail.
    if (stopped) {
      conn.end();
      return;
    }

    if (config.auth.method === "pairing_code" && !auth.creds.me) {
      // Baileys' pairing-code flow starts from fresh creds by requesting the
      // phone-number code immediately after socket creation; it does not wait
      // for a QR readiness event.
      const code = await conn.requestPairingCode(assertE164(config.auth.phone).replace(/^\+/, ""));
      await apply({ t: "code_ready", code, expiresAt: Date.now() + verdictWindowMs });
      verdictTimer = setTimeout(fireVerdict, verdictWindowMs);
    }

    for await (const ev of conn.events) await handle(ev);
  }

  async function supervise(): Promise<void> {
    await apply({ t: "start" });
    while (!stopped) {
      await runOnce().catch(async (err) => {
        logger.error({ err }, "session run errored");
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
    connection.close();
    inbound.close();
    conversationSync.close();
    updates.close();
    contacts.close();
    groups.close();
    presence.close();
  }

  const send: Send = async (to, msg, opts) => {
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
    connection,
    inbound,
    conversationSync,
    updates,
    contacts,
    groups,
    presence,
    onStatus: (handler) => connection.on(handler),
    onMessage: (handler) => inbound.on((m) => handler(incoming(m, send))),
    onUpdate: (handler) => updates.on(handler),
    onConversationSync: (handler) => conversationSync.on(handler),
    onContact: (handler) => contacts.on(handler),
    onGroup: (handler) => groups.on(handler),
    onPresence: (handler) => presence.on(handler),
    // Idempotent: hand back the one running supervisor so stop() can await it.
    start: () => (supervisor ??= supervise()),
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
    identity: () => conn?.identity(),
    async stop() {
      stopped = true;
      clearVerdict();
      clearSync();
      conn?.end(); // close → classified intentional → machine → disconnected
      // Wait for the supervisor to finish tearing down (incl. any socket opened
      // after this call) so stop() never returns while a live socket lingers.
      await supervisor;
    },
  };
}
