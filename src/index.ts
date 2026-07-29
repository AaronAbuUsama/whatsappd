/**
 * Public entry point for the WhatsApp session engine and its pure model types.
 *
 * The `libsqlStore` implementation is intentionally not re-exported here;
 * import it from `whatsappd/stores/libsql` so the optional
 * `@libsql/client` dependency stays out of this entry's resolution path.
 *
 * @packageDocumentation
 */

// ── Session engine ──
export { createSession } from "./session.ts";
export type { WhatsAppSession, SessionConfig } from "./session.ts";
export type {
  Awaitable,
  MessageHandlerContext,
  Unsubscribe,
  WhatsAppSessionHandlers,
} from "./subscription.ts";
export { qrAuth, pairingAuth } from "./ports.ts";
export type { CredentialStore, AuthStrategy } from "./ports.ts";
export { fileStore } from "./stores/file.ts";
export { memoryStore } from "./stores/memory.ts";
export type {
  Status,
  PairingState,
  SyncState,
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
  ConversationSyncContext,
  ConversationSyncSource,
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
