/**
 * Updates to messages that already exist — delivery/read receipts, reactions,
 * edits, and revokes. Kept on their own stream, separate from inbound messages,
 * so a consumer can persist messages and mutate them in place without
 * conflating the two. Protocol-free types.
 *
 * @packageDocumentation
 */
import type { InboundMessage } from "./message.ts";
import type { MessageRef } from "./outbound.ts";

/**
 * Delivery progression of a message. Mirrors WhatsApp's own ladder; in practice
 * monotonic (`server_ack → delivered → read → played`). `error` means the send
 * was rejected after the fact.
 */
export type ReceiptStatus = "pending" | "server_ack" | "delivered" | "read" | "played" | "error";

interface UpdateBase {
  /** The message this update is about. */
  ref: MessageRef;
  /** When it happened (ms epoch), when the wire tells us. */
  at?: number;
}

export type Update =
  /** A receipt for a message — usually one we sent. `by` is set for the
   *  per-participant receipts that groups produce. */
  | (UpdateBase & { kind: "receipt"; status: ReceiptStatus; by?: string })
  /** Someone reacted, or cleared their reaction (`removed: true`, `emoji`
   *  undefined). `by` is the reactor. */
  | (UpdateBase & { kind: "reaction"; emoji?: string; by?: string; removed: boolean })
  /** A message was edited; `message` is the new content, re-mapped to the same
   *  shape as anything on the `inbound` stream. */
  | (UpdateBase & { kind: "edit"; message: InboundMessage })
  /** A message was deleted for everyone (revoked). `by` is who revoked it. */
  | (UpdateBase & { kind: "revoke"; by?: string });
