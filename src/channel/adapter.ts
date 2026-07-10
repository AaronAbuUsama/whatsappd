/**
 * Channel adapter — wraps one WhatsApp session behind the
 * `WhatsAppChannelAdapter` interface. Framework adapters (Eve, or any HTTP
 * consumer via the sidecar) hold one of these and call its methods; the deep
 * module sits behind it.
 *
 * One adapter = one session = one WhatsApp account. Running several accounts
 * means running several sidecar processes — crash isolation and per-account
 * pairing come free, and no fan-in layer is needed.
 *
 * The adapter pumps the session's streams into `ChannelEvent`s and forwards
 * them to all registered `ChannelHandlers`. Outbound calls
 * (send/markRead/setTyping) are delegated to the session.
 */
import type { Logger } from "pino";
import type { WhatsAppSession } from "../session.ts";
import type { InboundMessage } from "../model/message.ts";
import type { Outbound, MessageRef, SendOptions } from "../model/outbound.ts";
import type { Update } from "../model/update.ts";
import type { PresenceKind } from "../model/presence.ts";
import {
  type ChannelEvent,
  type ChannelHandlers,
  type ConversationRef,
  type WhatsAppChannelAdapter,
} from "./types.ts";

/** Build a ConversationRef from an inbound message. */
function refFromMessage(msg: InboundMessage): ConversationRef {
  return {
    chatId: msg.chatId,
    isGroup: msg.isGroup,
    from: msg.from,
    pushName: msg.pushName,
  };
}

/** Build a ConversationRef from an update's ref. */
function refFromUpdate(update: Update): ConversationRef | undefined {
  const chatId = update.ref.chatId;
  if (!chatId) return undefined;
  const isGroup = chatId.includes("@g.us");
  return { chatId, isGroup, from: update.ref.participant };
}

export interface CreateChannelAdapterOptions {
  /** The single-account session to wrap. */
  session: WhatsAppSession;
  /** Label carried on status events and sidecar wire payloads. Default "default". */
  accountId?: string;
  /** Optional logger. */
  logger?: Logger;
}

/**
 * Create a `WhatsAppChannelAdapter` over one session.
 *
 * Construction does NOT connect — call `start()` to begin pumping the
 * session's streams and open the socket to WhatsApp.
 */
export function createChannelAdapter(opts: CreateChannelAdapterOptions): WhatsAppChannelAdapter {
  const { session } = opts;
  const accountId = opts.accountId ?? "default";
  const log = opts.logger;

  const subscribers = new Set<ChannelHandlers>();
  let started = false;

  function emit(event: ChannelEvent): void {
    for (const h of subscribers) {
      const result = h.onEvent(event);
      if (result instanceof Promise) void result;
    }
  }

  /** Pump the session's streams into ChannelEvents (they end on stop/terminal). */
  function startPump(): void {
    const tasks: Promise<void>[] = [
      (async (): Promise<void> => {
        for await (const message of session.inbound) {
          emit({ type: "message", ref: refFromMessage(message), message });
        }
      })(),
      (async (): Promise<void> => {
        for await (const update of session.updates) {
          const ref = refFromUpdate(update);
          if (ref) emit({ type: "update", ref, update });
        }
      })(),
      (async (): Promise<void> => {
        for await (const status of session.connection) {
          emit({ type: "status", accountId, status });
        }
      })(),
    ];

    void Promise.all(tasks).catch((err) => {
      log?.error({ err }, "channel adapter stream pump error");
    });
  }

  function requireStarted(): WhatsAppSession {
    if (!started) throw new Error(`adapter for account ${accountId} — call start() first`);
    return session;
  }

  return {
    accountId,

    async start(): Promise<void> {
      if (started) return;
      started = true;
      // Pump first so no early event (e.g. the pairing QR) is missed.
      startPump();
      await session.start();
    },

    async send(chatId: string, content: Outbound, opts?: SendOptions): Promise<MessageRef> {
      return requireStarted().send(chatId, content, opts);
    },

    async markRead(chatId: string): Promise<void> {
      // markRead takes MessageRef[] — we construct a minimal ref from the chatId.
      await requireStarted().markRead([{ id: "", chatId, fromMe: false }]);
    },

    async setTyping(chatId: string, kind: PresenceKind): Promise<void> {
      const on = kind === "typing" || kind === "recording";
      await requireStarted().setTyping(chatId, on);
    },

    subscribe(handler: ChannelHandlers): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    async stop(): Promise<void> {
      await session.stop();
    },
  };
}
