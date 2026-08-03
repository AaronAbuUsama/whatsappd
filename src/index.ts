/**
 * Public entry point for the WhatsApp session engine and its pure model types.
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
  WhatsAppAddress,
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

// ── Runtime, backends, and client ──
export { createWhatsAppRuntime, createInProcessWhatsAppClient } from "./runtime/runtime.ts";
export type { RuntimeSession, WhatsAppRuntime, WhatsAppRuntimeConfig } from "./runtime/runtime.ts";
export {
  memoryBackend,
  memoryDataStore,
  memoryLeaseStore,
  memoryMediaStore,
} from "./runtime/memory.ts";
export { libsqlBackend } from "./runtime/libsql.ts";
export type { LibsqlBackend, LibsqlBackendOptions } from "./runtime/libsql.ts";
export { fileMediaStore } from "./runtime/file-media.ts";
export type { FileMediaStoreOptions } from "./runtime/file-media.ts";
export {
  AccountAlreadyClaimedError,
  AccountNotHeldError,
  StaleAccountClaimError,
  UnsupportedDurableEventError,
} from "./runtime/contracts.ts";
export type {
  AcceptedWhatsAppBatch,
  AccountLease,
  AccountLeaseStore,
  AccountRecord,
  ChatRecord,
  ContactRecord,
  DurableMedia,
  DurableInboundMessage,
  DurableUpdate,
  GroupRecord,
  MediaStore,
  MessageReaction,
  MessageReceipt,
  MessageRecord,
  MirrorAlias,
  MirrorRecord,
  MirrorView,
  ObservedInstant,
  StoredMessageCursor,
  StoredMessagePage,
  StoredMessagePageOptions,
  WhatsAppBackend,
  WhatsAppClient,
  WhatsAppClientConnectionState,
  WhatsAppClientFrame,
  WhatsAppDataEvent,
  WhatsAppDataStore,
  WhatsAppDurableEvent,
  WhatsAppPatch,
  WhatsAppSnapshot,
} from "./runtime/contracts.ts";

// ── Error model ──
export {
  PairingError,
  classifyDisconnect,
  isRetryable,
  dispositionFor,
  assertE164,
} from "./errors.ts";
export type { FaultReason, WhatsAppFault, Disposition } from "./errors.ts";
