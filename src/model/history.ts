import type { InboundMessage } from "./message.ts";
import type { GroupParticipant } from "./group.ts";

export interface HistoryChat {
  readonly id: string;
  readonly subject?: string;
  readonly isGroup: boolean;
  readonly lastMessageAt?: number;
  readonly participants?: readonly GroupParticipant[];
}

export interface HistoryContact {
  readonly id: string;
  readonly displayName?: string;
}

/**
 * Where a conversation-sync batch came from.
 *
 * - `initial_bootstrap` / `recent` / `full` — connection-driven protocol
 *   delivery. WhatsApp sends a linked device only a bounded slice of history;
 *   no signal marks it complete.
 * - `on_demand` — an answer to `requestHistory`. The phone may never send
 *   one at all; treat absence as an expected outcome.
 * - `unknown` — a batch the protocol did not label (e.g. offline catch-up
 *   appends).
 *
 * Measured slice depths, observed response rates, and device caveats live in
 * `docs/history-semantics.md`.
 */
export type ConversationSyncSource =
  | "initial_bootstrap"
  | "recent"
  | "on_demand"
  | "full"
  | "unknown";

export interface ConversationSyncContext {
  readonly source: ConversationSyncSource;
  /**
   * Whether the protocol flagged this as the last chunk of a sync. whatsappd
   * passes through whatever the protocol delivers; the current upstream layer
   * strips this flag from on-demand syncs, so expect it absent on `on_demand`
   * batches. Present or absent, it cannot establish exhaustion of requested
   * history — nothing can: an absent batch and an exhausted chat are
   * indistinguishable.
   */
  readonly isLatest?: boolean;
  /** Position of this chunk within its sync, when the protocol provided one. */
  readonly chunkOrder?: number;
  /** Sync progress percentage, when the protocol provided one. */
  readonly progress?: number;
  /**
   * On `on_demand` batches: the phone's id for the request being answered.
   * Intended by the protocol to equal the `requestId` from the
   * {@link WhatsAppSession.requestHistory} receipt — treat the match as
   * best-effort correlation, not a guaranteed contract.
   */
  readonly requestSessionId?: string;
  readonly projection:
    | { readonly mode: "upsert" }
    | {
        readonly mode: "authoritative_replacement";
        readonly scope: "account" | { readonly chatId: string };
      };
}

/**
 * One protocol delivery of historical/synced data: chats, contacts, and
 * non-live messages (`live: false`) that flow through the same awaited
 * subscription as everything else. Inspect {@link ConversationSyncContext} to
 * learn why the batch arrived; never infer completeness from its size.
 */
export interface ConversationSyncBatch {
  readonly context: ConversationSyncContext;
  readonly chats: readonly HistoryChat[];
  readonly contacts: readonly HistoryContact[];
  readonly self?: HistoryContact;
  readonly messages: readonly InboundMessage[];
}
