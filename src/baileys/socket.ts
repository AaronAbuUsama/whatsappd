/**
 * The single protocol-facing layer. Wraps the WhatsApp socket and turns the raw
 * protocol into a typed `RawEvent` stream plus a few imperative verbs. Socket
 * library types never escape this directory — that boundary is what keeps the
 * rest of the codebase protocol-free. The session orchestrator consumes
 * `RawEvent` and makes all decisions.
 */
import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import { classifyDisconnect, type WhatsAppFault } from "../errors.ts";
import type {
  GroupMetadata,
  GroupUpdate,
  ConversationSyncBatch,
  InboundMessage,
  WaIdentity,
} from "../model/index.ts";
import type { Update } from "../model/update.ts";
import type { MessageRef, Outbound, SendOptions } from "../model/outbound.ts";
import { mapContactUpdates } from "./contacts.ts";
import { mapGroupMetadataUpdates, mapGroupParticipantsUpdate } from "./groups.ts";
import { toConversationSyncBatch } from "./history.ts";
import { toInbound } from "./inbound.ts";
import { mapMessageUpdate, mapReaction, mapReceiptUpdate } from "./updates.ts";
import { mapPresenceUpdate } from "./presence.ts";
import { mediaDownloader, noDownloader, type DownloadThunk } from "./download.ts";
import { keyToRef, refToKey, toContent, toOptions } from "./outbound.ts";

/** How many recent raw messages to retain for quote resolution. */
const RECENT_CAP = 500;
import type { BaileysAuth } from "./authState.ts";

/** Track recent raw messages in an LRU Map for quote/reply resolution. */
function rememberRecent(recent: Map<string, WAMessage>, messages: WAMessage[]): void {
  for (const m of messages) {
    if (m.key.id) {
      recent.set(m.key.id, m);
      if (recent.size > RECENT_CAP) recent.delete(recent.keys().next().value!);
    }
  }
}

/** Raw, already-classified socket events, before semantic translation. */
export type RawEvent =
  | { t: "connecting" }
  | { t: "qr"; qr: string } // session decides first-qr (ready) vs refresh
  | { t: "paired" } // isNewLogin:true
  | { t: "open" }
  | { t: "pending_drained" } // receivedPendingNotifications:true
  | { t: "conversation_sync_progress"; progress: number } // messaging-history.set progress<100
  | { t: "conversation_sync_complete" } // RECENT history status complete/paused or progress===100
  | { t: "conversation_sync"; sync: ConversationSyncBatch }
  | { t: "message"; msg: InboundMessage }
  | { t: "update"; update: Update } // receipt / reaction / edit / revoke
  | { t: "contact"; contact: import("../model/contact.ts").ContactUpdate }
  | { t: "group"; group: GroupUpdate }
  | { t: "presence"; presence: import("../model/presence.ts").PresenceUpdate }
  | { t: "close"; fault: WhatsAppFault }; // connection:'close', classified

export interface BaileysConn {
  /** Single-consumer async stream of raw events; ends after `close`. */
  events: AsyncIterable<RawEvent>;
  /** Request a pairing code; the returned string is the code, not a success signal. */
  requestPairingCode(phoneDigits: string): Promise<string>;
  /** Send any outbound type; returns a ref to the sent message (for edit/delete/react). */
  send(to: string, out: Outbound, opts?: SendOptions): Promise<MessageRef>;
  /** Mark the given messages read (blue ticks for the sender). */
  markRead(refs: MessageRef[]): Promise<void>;
  /** Show/clear the typing indicator in a chat. */
  setTyping(chatId: string, on: boolean): Promise<void>;
  /** Fetch normalized group metadata for a group JID. */
  groupMetadata(chatId: string): Promise<GroupMetadata>;
  /** Fetch the profile picture URL for a contact, account, or group JID. */
  profilePictureUrl(jid: string, type?: "image" | "preview"): Promise<string | undefined>;
  /** The connected account's own identity (jid/pushName/phone), once the socket is open. */
  identity(): WaIdentity | undefined;
  /** Intentional teardown — the resulting close is classified `intentional`. */
  end(): void;
}

type MessagesUpsertPayload = BaileysEventMap["messages.upsert"];
type MessagingHistoryPayload = BaileysEventMap["messaging-history.set"];
type MessagingHistoryStatusPayload = BaileysEventMap["messaging-history.status"];

export function toMessagesUpsertEvents(
  payload: MessagesUpsertPayload,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): RawEvent[] {
  if (payload.type !== "notify") {
    const sync = toConversationSyncBatch(
      { chats: [], contacts: [], messages: payload.messages },
      makeDownload,
    );
    return sync.messages.length > 0 ? [{ t: "conversation_sync", sync }] : [];
  }

  return payload.messages.flatMap((raw) => {
    const msg = toInbound(raw, true, makeDownload);
    return msg ? [{ t: "message", msg } satisfies RawEvent] : [];
  });
}

export function toMessagingHistoryEvents(
  payload: MessagingHistoryPayload,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): RawEvent[] {
  const events: RawEvent[] = [];
  const complete = payload.progress === 100;
  if (!complete && typeof payload.progress === "number" && Number.isFinite(payload.progress)) {
    events.push({ t: "conversation_sync_progress", progress: payload.progress });
  }
  const sync = toConversationSyncBatch(payload, makeDownload);
  if (sync.chats.length > 0 || sync.contacts.length > 0 || sync.messages.length > 0) {
    events.push({ t: "conversation_sync", sync });
  }
  if (complete) events.push({ t: "conversation_sync_complete" });
  return events;
}

export function toMessagingHistoryStatusEvents(payload: MessagingHistoryStatusPayload): RawEvent[] {
  if (
    payload.syncType === proto.HistorySync.HistorySyncType.RECENT &&
    (payload.status === "complete" || payload.status === "paused")
  ) {
    return [{ t: "conversation_sync_complete" }];
  }
  return [];
}

function historySetTelemetry(payload: MessagingHistoryPayload) {
  const chatsWithInlineMessage = payload.chats.filter(
    (chat) => ((chat as { readonly messages?: readonly unknown[] }).messages?.length ?? 0) > 0,
  ).length;
  return {
    syncType: payload.syncType ?? null,
    chunkOrder: payload.chunkOrder ?? null,
    progress: payload.progress ?? null,
    isLatest: payload.isLatest ?? null,
    chats: payload.chats.length,
    contacts: payload.contacts.length,
    messages: payload.messages.length,
    chatsWithInlineMessage,
    chatsWithoutInlineMessage: payload.chats.length - chatsWithInlineMessage,
    peerDataRequestSessionId: payload.peerDataRequestSessionId ?? null,
  };
}

export interface OpenSocketOpts {
  auth: Pick<BaileysAuth, "creds" | "keys">;
  /** Persist creds on every `creds.update`. */
  saveCreds: () => Promise<void>;
  logger: Logger;
}

export function shouldRequestFullHistoryOnOpen(auth: {
  readonly creds: { readonly registered?: boolean; readonly me?: unknown };
}): boolean {
  return auth.creds.registered === true;
}

type PromiseResolver<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

const promiseWithResolvers = Promise as unknown as {
  withResolvers<T>(): PromiseResolver<T>;
};

/** Minimal async queue: push events, await them one at a time, close to end. */
class EventQueue {
  private readonly buffer: RawEvent[] = [];
  private resolve?: (r: IteratorResult<RawEvent>) => void;
  private done = false;

  push(ev: RawEvent): void {
    if (this.done) return;
    if (this.resolve) {
      this.resolve({ value: ev, done: false });
      this.resolve = undefined;
    } else {
      this.buffer.push(ev);
    }
  }

  close(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve({ value: undefined, done: true });
      this.resolve = undefined;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RawEvent> {
    return {
      next: (): Promise<IteratorResult<RawEvent>> => {
        const queued = this.buffer.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        const { promise, resolve } = promiseWithResolvers.withResolvers<IteratorResult<RawEvent>>();
        this.resolve = resolve;
        return promise;
      },
    };
  }
}

function summarizeLogValue(value: unknown, depth = 0): unknown {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length };
  if (Array.isArray(value)) {
    if (depth >= 2) return { type: "Array", length: value.length };
    return value.slice(0, 10).map((item) => summarizeLogValue(item, depth + 1));
  }
  if (typeof value !== "object")
    return String(value as string | number | boolean | symbol | undefined);
  if (depth >= 2) return { type: "Object" };
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function") continue;
    out[key] = summarizeLogValue(child, depth + 1);
  }
  return out;
}

function disconnectTelemetry(error: unknown) {
  const err = error as
    | {
        readonly name?: string;
        readonly message?: string;
        readonly data?: unknown;
        readonly output?: { readonly statusCode?: number; readonly payload?: unknown };
      }
    | undefined;
  return {
    name: err?.name,
    message: err?.message,
    statusCode: err?.output?.statusCode,
    payload: summarizeLogValue(err?.output?.payload),
    data: summarizeLogValue(err?.data),
  };
}

function connectionUpdateTelemetry(update: BaileysEventMap["connection.update"]) {
  return {
    connection: update.connection,
    hasQr: Boolean(update.qr),
    qrChars: typeof update.qr === "string" ? update.qr.length : undefined,
    isNewLogin: update.isNewLogin,
    receivedPendingNotifications: update.receivedPendingNotifications,
    lastDisconnect: update.lastDisconnect
      ? disconnectTelemetry(update.lastDisconnect.error)
      : undefined,
  };
}

export async function openSocket(opts: OpenSocketOpts): Promise<BaileysConn> {
  const { auth, saveCreds, logger } = opts;
  const { version } = await fetchLatestBaileysVersion();
  const queue = new EventQueue();
  let intentional = false;
  const requestFullHistory = shouldRequestFullHistoryOnOpen(auth);
  logger.info(
    {
      version,
      requestFullHistory,
      credsRegistered: auth.creds.registered === true,
      hasCredsMe: Boolean(auth.creds.me),
      browser: "macOS Desktop",
    },
    "opening baileys socket",
  );

  const sock: WASocket = makeWASocket({
    version,
    logger,
    // Desktop companion mode is required for the richest linked-device history sync.
    browser: Browsers.macOS("Desktop"),
    // Fresh Desktop registration is not complete at pair-success. Baileys first
    // persists `creds.me`, then later sets `creds.registered` after the
    // link_code_companion_reg finish notification. Asking for full history in
    // that in-between state leaves the phone stuck at "logging in" and the
    // socket in a reconnect/backoff loop.
    syncFullHistory: requestFullHistory,
    shouldSyncHistoryMessage: () => true,
    auth: {
      creds: auth.creds,
      keys: makeCacheableSignalKeyStore(auth.keys, logger),
    },
  });

  sock.ev.on("creds.update", () => void saveCreds());

  // Media bytes are pulled on demand via this factory — never buffered here.
  const makeDownload = mediaDownloader(sock, logger);

  // Recent raw messages, kept only so quote/reply can resolve a MessageRef back
  // to the original WAMessage without that proto ever crossing the surface.
  const recent = new Map<string, WAMessage>();
  const resolveQuoted = (ref: MessageRef): WAMessage | undefined => recent.get(ref.id);

  sock.ev.on("messages.upsert", (payload) => {
    rememberRecent(recent, payload.messages);
    for (const event of toMessagesUpsertEvents(payload, makeDownload)) queue.push(event);
  });

  // The update stream: receipts, reactions, edits, revokes. Each mapper returns
  // undefined for shapes we don't model — we only enqueue hits.
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const update = mapMessageUpdate(u, makeDownload);
      if (update) queue.push({ t: "update", update });
    }
  });

  sock.ev.on("message-receipt.update", (receipts) => {
    for (const r of receipts) queue.push({ t: "update", update: mapReceiptUpdate(r) });
  });

  sock.ev.on("messages.reaction", (reactions) => {
    for (const r of reactions) queue.push({ t: "update", update: mapReaction(r) });
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of mapContactUpdates(contacts)) queue.push({ t: "contact", contact });
  });

  sock.ev.on("contacts.update", (contacts) => {
    for (const contact of mapContactUpdates(contacts)) queue.push({ t: "contact", contact });
  });

  sock.ev.on("groups.upsert", (groups) => {
    for (const group of mapGroupMetadataUpdates(groups)) queue.push({ t: "group", group });
  });

  sock.ev.on("groups.update", (groups) => {
    for (const group of mapGroupMetadataUpdates(groups)) queue.push({ t: "group", group });
  });

  sock.ev.on("group-participants.update", (update) => {
    const group = mapGroupParticipantsUpdate(update);
    if (group) queue.push({ t: "group", group });
  });

  sock.ev.on("presence.update", (update) => {
    for (const presence of mapPresenceUpdate(update)) queue.push({ t: "presence", presence });
  });

  sock.ev.on("messaging-history.set", (payload) => {
    logger.info(historySetTelemetry(payload), "messaging history set");
    rememberRecent(recent, payload.messages);
    for (const event of toMessagingHistoryEvents(payload, makeDownload)) queue.push(event);
  });

  sock.ev.on("messaging-history.status", (payload) => {
    logger.info(
      {
        syncType: payload.syncType,
        status: payload.status,
        explicit: payload.explicit,
      },
      "messaging history status",
    );
    for (const event of toMessagingHistoryStatusEvents(payload)) queue.push(event);
  });

  sock.ev.on("connection.update", (u) => {
    logger.info(connectionUpdateTelemetry(u), "connection update");
    if (u.connection === "connecting") queue.push({ t: "connecting" });
    if (u.qr) queue.push({ t: "qr", qr: u.qr });
    if (u.isNewLogin) queue.push({ t: "paired" }); // the real pairing confirmation
    if (u.connection === "open") queue.push({ t: "open" });
    if (u.receivedPendingNotifications) queue.push({ t: "pending_drained" });
    if (u.connection === "close") {
      const fault = classifyDisconnect(u.lastDisconnect?.error, intentional);
      queue.push({ t: "close", fault });
      queue.close();
    }
  });

  return {
    events: queue,
    requestPairingCode: (digits) => sock.requestPairingCode(digits),
    send: async (to, out, opts) => {
      const sent = await sock.sendMessage(to, toContent(out), toOptions(opts, resolveQuoted));
      return keyToRef(sent?.key ?? { remoteJid: to, fromMe: true });
    },
    markRead: (refs) => sock.readMessages(refs.map(refToKey)),
    setTyping: (chatId, on) => sock.sendPresenceUpdate(on ? "composing" : "paused", chatId),
    groupMetadata: async (chatId) => {
      const metadata = await sock.groupMetadata(chatId);
      return {
        id: metadata.id ?? chatId,
        ...(metadata.subject ? { subject: metadata.subject } : {}),
        participants: metadata.participants.map((participant) => ({
          id: participant.id,
          ...(participant.admin ? { role: participant.admin } : {}),
        })),
      };
    },
    profilePictureUrl: (jid, type) => sock.profilePictureUrl(jid, type),
    identity: () => {
      const u = sock.user;
      if (!u?.id) return undefined;
      const digits = u.id.split(/[:@]/)[0] ?? "";
      const phoneE164 = /^\d+$/.test(digits) ? `+${digits}` : undefined;
      return { jid: u.id, pushName: u.name ?? undefined, phoneE164 };
    },
    end: () => {
      intentional = true;
      void sock.end(undefined);
    },
  };
}
