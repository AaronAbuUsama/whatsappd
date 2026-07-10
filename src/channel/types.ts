/**
 * Agent Channel Interface — the framework-agnostic contract between the
 * WhatsApp deep module and framework adapters (Eve, or any future host).
 *
 * The core idea: `chatId` (JID) is the canonical conversation id. Eve maps
 * `continuationToken` ↔ `chatId`. For group messages, `from` (sender JID)
 * disambiguates senders within the same chat.
 */
import type {
  InboundMessage,
  Outbound,
  MessageRef,
  SendOptions,
  Status,
  Update,
  PresenceKind,
} from "../model/index.ts";

/**
 * A resolved WhatsApp conversation — enough context for both Eve and Flue to
 * address a session. `chatId` is always the JID (`xxx@s.whatsapp.net` or
 * `xxx@g.us`). `from` is the sender within that chat (equal to `chatId` for
 * DMs, the participant JID for groups).
 */
export interface ConversationRef {
  readonly chatId: string;
  readonly isGroup: boolean;
  /** Sender JID — equal to chatId for DMs, participant for groups. */
  readonly from?: string;
  /** Sender display name from WhatsApp. */
  readonly pushName?: string;
}

/**
 * Events the channel adapter emits to its handlers. Framework adapters
 * translate these into their own session-start/dispatch calls.
 */
export type ChannelEvent =
  | { type: "message"; ref: ConversationRef; message: InboundMessage }
  | { type: "update"; ref: ConversationRef; update: Update }
  | { type: "status"; accountId: string; status: Status };

/**
 * Callbacks the framework adapter provides. The channel adapter calls these
 * when WhatsApp events arrive. Returning a Promise is fine — the adapter
 * awaits before continuing to drain its event queue.
 */
export interface ChannelHandlers {
  onEvent(event: ChannelEvent): void | Promise<void>;
}

/**
 * The framework-agnostic WhatsApp channel surface: one adapter wraps one
 * account's session. Framework adapters (and the sidecar) hold one of these
 * and call its methods; the deep module sits behind it.
 */
export interface WhatsAppChannelAdapter {
  /** Label for this account, carried on status events and wire payloads. */
  readonly accountId: string;

  /** Start the underlying session (connects to WhatsApp). */
  start(): Promise<void>;

  /**
   * Send an outbound message to a chat. Returns a ref for follow-up
   * react/edit/delete/quote operations.
   */
  send(chatId: string, content: Outbound, opts?: SendOptions): Promise<MessageRef>;

  /** Mark a chat as read (blue ticks). */
  markRead(chatId: string): Promise<void>;

  /** Set or clear typing/recording presence in a chat. */
  setTyping(chatId: string, kind: PresenceKind): Promise<void>;

  /**
   * Subscribe to channel events. Returns an unsubscribe function.
   * Multiple subscribers are supported; each receives every event.
   */
  subscribe(handlers: ChannelHandlers): () => void;

  /** Intentional teardown. */
  stop(): Promise<void>;
}
