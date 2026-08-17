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
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  type BaileysEventMap,
  type WABrowserDescription,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import { classifyDisconnect, type WhatsAppFault } from "../errors.ts";
import type { AuthStrategy } from "../ports.ts";
import { settle } from "../outcome.ts";
import {
  addressOf,
  type GroupMetadata,
  type GroupParticipantAction,
  type GroupParticipantUpdateResult,
  type GroupSetting,
  type GroupUpdate,
  type ConversationSyncBatch,
  type InboundMessage,
  type WaIdentity,
  type WhatsAppAddress,
} from "../model/index.ts";
import type { Update } from "../model/update.ts";
import type { MessageRef, Outbound, SendOptions } from "../model/outbound.ts";
import { mapContactUpdates } from "./contacts.ts";
import { mapGroupMetadataUpdates, mapGroupParticipantsUpdate } from "./groups.ts";
import { toConversationSyncBatch } from "./history.ts";
import { toInbound } from "./inbound.ts";
import { mapMessageControl, mapMessageUpdate, mapReaction, mapReceiptUpdate } from "./updates.ts";
import { mapPresenceUpdate } from "./presence.ts";
import { mediaDownloader, noDownloader, type DownloadThunk } from "./download.ts";
import { keyToRef, refToKey, toContent, toOptions } from "./outbound.ts";

/** How many recent raw messages to retain for quote and poll-key resolution.
 * ponytail: add a private durable poll-key capability only if votes older than
 * this live cache are required; never expose message secrets in the mirror. */
const RECENT_CAP = 500;
import type { BaileysAuth } from "./auth-state.ts";

/** Canonical web companion identity required by WhatsApp pairing-code registration. */
export const PAIRING_BROWSER = Browsers.ubuntu("Chrome");

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
  | { t: "update"; update: Update } // receipt / reaction / edit / revoke / poll result
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
  groupCreate(subject: string, participants: string[]): Promise<GroupMetadata>;
  groupLeave(chatId: string): Promise<void>;
  groupUpdateSubject(chatId: string, subject: string): Promise<void>;
  groupUpdateDescription(chatId: string, description?: string): Promise<void>;
  groupParticipantsUpdate(
    chatId: string,
    participants: string[],
    action: GroupParticipantAction,
  ): Promise<readonly GroupParticipantUpdateResult[]>;
  groupSettingUpdate(chatId: string, setting: GroupSetting): Promise<void>;
  groupInviteCode(chatId: string): Promise<string | undefined>;
  groupRevokeInvite(chatId: string): Promise<string | undefined>;
  groupUpdatePicture(chatId: string, image: Uint8Array): Promise<void>;
  groupRemovePicture(chatId: string): Promise<void>;
  /** Fetch the profile picture URL for a contact, account, or group JID. */
  profilePictureUrl(jid: string, type?: "image" | "preview"): Promise<string | undefined>;
  /**
   * Submit an on-demand history request to the linked phone, anchored at the
   * given oldest known message. Resolves with the id of the outgoing request
   * message — a submission receipt, not a delivery signal.
   */
  requestHistory(count: number, ref: MessageRef, timestampMs: number): Promise<string>;
  /** The connected account's own identity (jid/pushName/phone), once the socket is open. */
  identity(): WaIdentity | undefined;
  /** Intentional teardown — the resulting close is classified `intentional`. */
  end(): void | Promise<void>;
}

function toGroupMetadata(
  metadata: {
    id?: string;
    subject?: string;
    desc?: string;
    announce?: boolean;
    restrict?: boolean;
    participants: readonly {
      id: string;
      phoneNumber?: string;
      lid?: string;
      admin?: string | null;
    }[];
  },
  fallbackId: string,
): GroupMetadata {
  return {
    id: metadata.id ?? fallbackId,
    ...(metadata.subject ? { subject: metadata.subject } : {}),
    ...(metadata.desc ? { description: metadata.desc } : {}),
    ...(metadata.announce !== undefined ? { announcement: metadata.announce } : {}),
    ...(metadata.restrict !== undefined ? { locked: metadata.restrict } : {}),
    participants: metadata.participants.map((participant) => ({
      id: participant.id,
      ...(participant.phoneNumber && {
        phoneJid: jidNormalizedUser(participant.phoneNumber),
      }),
      ...(participant.lid && { lid: jidNormalizedUser(participant.lid) }),
      ...(participant.admin ? { role: participant.admin } : {}),
    })),
  };
}

type MessagesUpsertPayload = BaileysEventMap["messages.upsert"];
type MessagingHistoryPayload = BaileysEventMap["messaging-history.set"];
type MessagingHistoryStatusPayload = BaileysEventMap["messaging-history.status"];

/**
 * The linked account's own address, in the forms WhatsApp knows it by.
 *
 * @remarks
 * `sock.user` is the registered credential identity, so it exists from the
 * moment credentials do — strictly before any message event can arrive. The
 * device suffix (`:12`) is stripped because participants are never named with
 * one, and the LID form rides along as the equivalent native address so a host
 * can join the two schemes.
 *
 * Throws rather than returning a placeholder if the identity is somehow absent:
 * a message that cannot name its author must not be converted at all, since an
 * empty or borrowed sender is the corruption ADR-0001 exists to prevent, and
 * this repo fails the pipeline instead of logging and skipping (ADR-0013).
 *
 * @param sock - The socket, for its registered `user`.
 * @returns The account's address, with its `lid` form as `alt`.
 * @throws TypeError - When the socket has no registered account identity.
 */
export function selfAddress(sock: Pick<WASocket, "user">): WhatsAppAddress {
  const u = sock.user;
  if (!u?.id) throw new TypeError("no account identity: cannot name the author of a message");
  return addressOf(jidNormalizedUser(u.id), u.lid ? jidNormalizedUser(u.lid) : undefined);
}

export function toMessagesUpsertEvents(
  payload: MessagesUpsertPayload,
  self: WhatsAppAddress,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
  resolveMessage?: (ref: MessageRef) => WAMessage | undefined,
): RawEvent[] {
  if (payload.type !== "notify") {
    const sync = toConversationSyncBatch(
      { chats: [], contacts: [], messages: payload.messages },
      self,
      makeDownload,
    );
    return sync.messages.length > 0 || (sync.updates?.length ?? 0) > 0
      ? [{ t: "conversation_sync", sync }]
      : [];
  }

  return payload.messages.flatMap((raw): RawEvent[] => {
    const control = mapMessageControl(raw, true, self, makeDownload, resolveMessage);
    // Baileys 7.0.0-rc14 does not emit a decrypted messages.update for poll
    // votes, so the raw envelope is the one live path that must publish here.
    if (control?.update?.kind === "poll_votes") return [{ t: "update", update: control.update }];
    // Baileys emits the matching messages.update/messages.reaction event for
    // the other live controls. Drop only those duplicate upsert envelopes.
    if (control) return [];
    const msg = toInbound(raw, true, self, makeDownload);
    return msg ? [{ t: "message", msg } satisfies RawEvent] : [];
  });
}

export function toMessagingHistoryEvents(
  payload: MessagingHistoryPayload,
  self: WhatsAppAddress,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): RawEvent[] {
  const events: RawEvent[] = [];
  const complete = payload.progress === 100;
  if (!complete && typeof payload.progress === "number" && Number.isFinite(payload.progress)) {
    events.push({ t: "conversation_sync_progress", progress: payload.progress });
  }
  const sync = toConversationSyncBatch(payload, self, makeDownload);
  if (
    sync.chats.length > 0 ||
    sync.contacts.length > 0 ||
    sync.messages.length > 0 ||
    (sync.updates?.length ?? 0) > 0
  ) {
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
  authMethod: AuthStrategy["method"];
  /** Persist creds on every `creds.update`. */
  saveCreds: () => Promise<void>;
  logger: Logger;
  /**
   * Ask WhatsApp for a full history sync. Only the Pairing connect can carry
   * the request; later logins use it solely for the desktop sub-platform.
   *
   * @defaultValue `true` — Baileys' own default, and the pairing WhatsApp's
   * desktop client performs.
   */
  syncFullHistory?: boolean;
}

export interface OpenSocketDependencies {
  fetchLatestVersion: typeof fetchLatestBaileysVersion;
  makeSocket: typeof makeWASocket;
}

/**
 * The companion identity this socket announces.
 *
 * @remarks
 * `Browsers.macOS("Chrome")` — Baileys' own default — rather than the
 * `macOS("Desktop")` this replaced, and the reason is a coupling that is not
 * visible from here. Upstream's `getWebInfo` upgrades `webInfo.webSubPlatform`
 * from `WEB_BROWSER` to `DARWIN` when `syncFullHistory` is set **and** the
 * browser is `["Mac OS"|"Windows", "Desktop", …]`. WhatsApp refuses a
 * registration node carrying `DARWIN`.
 *
 * That was measured, not reasoned about. Same commit, same machine, one field
 * apart: with `Desktop` the socket never reached a QR at all — `connection_lost`,
 * reconnect, repeat — and with a non-`Desktop` browser it paired in about a
 * second and delivered a full history sync. `"Desktop"` therefore only works
 * while full history is switched off, which is how it survived this long.
 *
 * Pairing-code registration keeps its own identity: WhatsApp requires the
 * canonical Chrome web companion (`CompanionWebClientType.CHROME`) there.
 */
export function browserForOpen(
  authMethod: AuthStrategy["method"],
  auth: { readonly creds: { readonly registered?: boolean } },
): WABrowserDescription {
  return authMethod === "pairing_code" && auth.creds.registered !== true
    ? PAIRING_BROWSER
    : Browsers.macOS("Chrome");
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
  return openSocketWith(opts, {
    fetchLatestVersion: fetchLatestBaileysVersion,
    makeSocket: makeWASocket,
  });
}

/** Open the real adapter with replaceable protocol constructors for direct tests. */
export async function openSocketWith(
  opts: OpenSocketOpts,
  dependencies: OpenSocketDependencies,
): Promise<BaileysConn> {
  const { auth, authMethod, saveCreds, logger } = opts;
  const { version } = await dependencies.fetchLatestVersion();
  const queue = new EventQueue();
  let intentional = false;
  const requestFullHistory = opts.syncFullHistory ?? true;
  const browser = browserForOpen(authMethod, auth);
  logger.info(
    {
      version,
      requestFullHistory,
      credsRegistered: auth.creds.registered === true,
      hasCredsMe: Boolean(auth.creds.me),
      browser: browser.join(" "),
    },
    "opening baileys socket",
  );

  const sock: WASocket = dependencies.makeSocket({
    version,
    logger,
    browser,
    // Two fields downstream depend on this, and only one is about the request.
    // `companion.requireFullSync` ships in the registration node ONLY — Baileys
    // picks that node by `!creds.me` (socket.js), so a credential can ask for
    // full history exactly once, at Pairing, and never again on a login.
    // `webInfo.webSubPlatform` is the other: it upgrades WEB_BROWSER → DARWIN on
    // every connect, but only when this is true AND the browser is a desktop one.
    // Gating this on credential state therefore did not defer the request, it
    // deleted it, and left the companion claiming to be a macOS Desktop client
    // in three fields while asking like a browser in the two that gate history.
    syncFullHistory: requestFullHistory,
    shouldSyncHistoryMessage: () => true,
    auth: {
      creds: auth.creds,
      keys: makeCacheableSignalKeyStore(auth.keys, logger),
    },
  });

  let credentialWrites = Promise.resolve();
  let credentialWriteOutcome: PromiseSettledResult<void> = {
    status: "fulfilled",
    value: undefined,
  };
  sock.ev.on("creds.update", () => {
    credentialWrites = credentialWrites.then(async () => {
      const outcome = await settle(saveCreds());
      if (credentialWriteOutcome.status === "fulfilled" && outcome.status === "rejected")
        credentialWriteOutcome = outcome;
    });
  });
  let ending: Promise<void> | undefined;
  const end = (): Promise<void> =>
    (ending ??= (async () => {
      intentional = true;
      void sock.end(undefined);
      let pending: Promise<void>;
      do {
        pending = credentialWrites;
        await pending;
      } while (pending !== credentialWrites);
      if (credentialWriteOutcome.status === "rejected") throw credentialWriteOutcome.reason;
    })());

  // Media bytes are pulled on demand via this factory — never buffered here.
  const makeDownload = mediaDownloader(sock, logger);

  // Recent raw messages let quote/reply and encrypted poll votes resolve their
  // target without a Baileys proto ever crossing the public surface.
  const recent = new Map<string, WAMessage>();
  const resolveQuoted = (ref: MessageRef): WAMessage | undefined => recent.get(ref.id);

  // `selfAddress(sock)` is resolved per event, not hoisted beside `makeDownload`:
  // a fresh pairing has no `sock.user` at wiring time, and hoisting would throw
  // before the account it names exists.
  sock.ev.on("messages.upsert", (payload) => {
    rememberRecent(recent, payload.messages);
    for (const event of toMessagesUpsertEvents(
      payload,
      selfAddress(sock),
      makeDownload,
      resolveQuoted,
    )) {
      queue.push(event);
    }
  });

  // Update events: receipts, reactions, edits, revokes. Each mapper returns
  // undefined for shapes we don't model — we only enqueue hits.
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const update = mapMessageUpdate(u, selfAddress(sock), makeDownload);
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
    for (const event of toMessagingHistoryEvents(payload, selfAddress(sock), makeDownload)) {
      queue.push(event);
    }
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
      return toGroupMetadata(metadata, chatId);
    },
    groupCreate: async (subject, participants) =>
      toGroupMetadata(await sock.groupCreate(subject, participants), ""),
    groupLeave: (chatId) => sock.groupLeave(chatId),
    groupUpdateSubject: (chatId, subject) => sock.groupUpdateSubject(chatId, subject),
    groupUpdateDescription: (chatId, description) =>
      sock.groupUpdateDescription(chatId, description),
    groupParticipantsUpdate: async (chatId, participants, action) =>
      (await sock.groupParticipantsUpdate(chatId, participants, action)).map((result) => ({
        ...(result.jid ? { id: result.jid } : {}),
        status: result.status,
      })),
    groupSettingUpdate: (chatId, setting) => sock.groupSettingUpdate(chatId, setting),
    groupInviteCode: (chatId) => sock.groupInviteCode(chatId),
    groupRevokeInvite: (chatId) => sock.groupRevokeInvite(chatId),
    groupUpdatePicture: (chatId, image) => sock.updateProfilePicture(chatId, Buffer.from(image)),
    groupRemovePicture: (chatId) => sock.removeProfilePicture(chatId),
    profilePictureUrl: (jid, type) => sock.profilePictureUrl(jid, type),
    requestHistory: (count, ref, timestampMs) =>
      sock.fetchMessageHistory(count, refToKey(ref), timestampMs),
    identity: () => {
      const u = sock.user;
      if (!u?.id) return undefined;
      const phoneJid = u.phoneNumber
        ? jidNormalizedUser(u.phoneNumber)
        : u.id.endsWith("@s.whatsapp.net")
          ? jidNormalizedUser(u.id)
          : undefined;
      const lid = u.lid ? jidNormalizedUser(u.lid) : undefined;
      const digits = phoneJid?.split("@", 1)[0] ?? "";
      const phoneE164 = /^\d+$/.test(digits) ? `+${digits}` : undefined;
      return {
        jid: u.id,
        ...(phoneJid && { phoneJid }),
        ...(lid && { lid }),
        pushName: u.name ?? undefined,
        phoneE164,
      };
    },
    end,
  };
}
