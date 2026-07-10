/**
 * Public entry point for `whatsappd` — the WhatsApp session engine, its
 * pure model types, the error model, the framework-agnostic channel adapter,
 * and the plug-and-play agent tools.
 *
 * The `libsqlStore` implementation is intentionally not re-exported here;
 * import it from `whatsappd/stores/libsql` so the optional
 * `@libsql/client` dependency stays out of this entry's resolution path.
 *
 * @packageDocumentation
 */

// ── Session engine ──
export { createSession } from "./session.ts";
export type { WhatsAppSession, SessionConfig, Listener, Unsubscribe } from "./session.ts";
export type { IncomingMessage, ReplyContent } from "./incoming.ts";
export { qrAuth, pairingAuth } from "./ports.ts";
export type { SessionStore, AuthStrategy } from "./ports.ts";
export { fileStore } from "./stores/file.ts";
export { memoryStore } from "./stores/memory.ts";
export type {
  Status,
  PairingState,
  SyncState,
  ConnectionEvent,
  WaIdentity,
  InboundMessage,
  MessageContext,
  Addressing,
  MessageFlags,
  MediaMeta,
  MediaHandle,
  ContactUpdate,
  Outbound,
  BinaryInput,
  MessageRef,
  SendOptions,
  GroupMetadata,
  GroupParticipant,
  GroupParticipantAction,
  GroupUpdate,
  PresenceKind,
  PresenceUpdate,
  Update,
  ReceiptStatus,
  MetricEvent,
  MetricsHook,
  ConversationSyncBatch,
  ConversationSyncChat,
  ConversationSyncContact,
  HistoryBatch,
  HistoryChat,
  HistoryContact,
} from "./model/index.ts";
export { isTerminal, isOnline, refOf } from "./model/index.ts";

// ── Error model ──
export {
  PairingError,
  classifyDisconnect,
  isRetryable,
  dispositionFor,
  assertE164,
} from "./errors.ts";
export type { FaultReason, WhatsAppFault, Disposition } from "./errors.ts";

// ── Agent Channel Interface (framework-agnostic) ──
export { createChannelAdapter } from "./channel/adapter.ts";
export type { CreateChannelAdapterOptions } from "./channel/adapter.ts";
export type {
  ConversationRef,
  ChannelEvent,
  ChannelHandlers,
  WhatsAppChannelAdapter,
} from "./channel/types.ts";

// ── Agent Tools (plug-and-play) ──
export {
  sendText,
  sendMedia,
  reply,
  markRead,
  setTyping,
  react,
  edit,
  deleteMsg,
  allTools,
  bindTools,
} from "./tools/index.ts";
export type {
  AgentTool,
  ToolContext,
  MediaKind,
  SendTextInput,
  SendMediaInput,
  ReplyInput,
  SetTypingInput,
  ReactInput,
  EditInput,
  DeleteInput,
} from "./tools/index.ts";
