/** Barrel for the pure domain model types. Protocol-free and side-effect-free. */
export type { Status, PairingState, SyncState, ConnectionEvent, WaIdentity } from "./status.ts";
export { isTerminal, isOnline } from "./status.ts";
export type {
  InboundMessage,
  MessageContext,
  Addressing,
  MessageFlags,
  MediaMeta,
  MediaHandle,
} from "./message.ts";
export type { Outbound, BinaryInput, MessageRef, SendOptions } from "./outbound.ts";
export { refOf } from "./outbound.ts";
export type { Update, ReceiptStatus } from "./update.ts";
export type { ContactUpdate } from "./contact.ts";
export type { PresenceKind, PresenceUpdate } from "./presence.ts";
export type { MetricEvent, MetricsHook } from "./metrics.ts";
export type {
  GroupMetadata,
  GroupParticipant,
  GroupParticipantAction,
  GroupUpdate,
} from "./group.ts";
export type {
  ConversationSyncBatch,
  ConversationSyncChat,
  ConversationSyncContact,
  HistoryBatch,
  HistoryChat,
  HistoryContact,
} from "./history.ts";
