/**
 * Update protos → `Update`. The companion to the inbound mapper, for the
 * updates stream. Three socket events feed it (all confined here):
 *
 *   - `messages.update`        — multiplexed: per-message status (receipt),
 *                                 plus edits and revokes (both arrive rewritten
 *                                 into this event).
 *   - `message-receipt.update` — per-participant receipts (the group case).
 *   - `messages.reaction`      — a reaction added or cleared.
 *
 * All pure: proto in, `Update` out. Edits reuse the inbound mapper so the new
 * content lands in the exact same shape as anything on the inbound stream.
 */
import {
  proto,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type MessageUserReceiptUpdate,
} from "baileys";
import type { ReceiptStatus, Update } from "../model/update.ts";
import type { DownloadThunk } from "./download.ts";
import { keyToRef } from "./outbound.ts";
import { toInbound } from "./inbound.ts";
import { noDownloader } from "./download.ts";

const Status = proto.WebMessageInfo.Status;

/** Long | number | null → ms epoch (receipts are in seconds). */
function secsToMs(v: number | { toNumber(): number } | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : v.toNumber();
  return n * 1000;
}

/** WebMessageInfo.Status enum → our ladder. SERVER_ACK is "sent to server". */
function statusOf(s: number | null | undefined): ReceiptStatus | undefined {
  switch (s) {
    case Status.ERROR:
      return "error";
    case Status.PENDING:
      return "pending";
    case Status.SERVER_ACK:
      return "server_ack";
    case Status.DELIVERY_ACK:
      return "delivered";
    case Status.READ:
      return "read";
    case Status.PLAYED:
      return "played";
    default:
      return undefined;
  }
}

/**
 * Map one `messages.update`. It carries three distinct things; we discriminate:
 *   revoke  → update.messageStubType === REVOKE (Baileys nulls the message)
 *   edit    → update.message.editedMessage present (the rewritten content)
 *   receipt → update.status is a known Status
 * Returns undefined for updates we don't model (e.g. starred, label changes).
 */
export function mapMessageUpdate(
  u: WAMessageUpdate,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): Update | undefined {
  const ref = keyToRef(u.key);
  const up = u.update;

  // REVOKE — delete-for-everyone. update.key is the revoke stanza's own key
  // (who did it); the top-level key.id is the message that was revoked.
  if (up.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
    const by = up.key?.participant ?? up.key?.remoteJid ?? undefined;
    return { kind: "revoke", ref, ...(by != null && { by }) };
  }

  // EDIT — Baileys rewrites a MESSAGE_EDIT protocolMessage to
  // { update: { message: { editedMessage: { message } }, messageTimestamp } }.
  const edited = up.message?.editedMessage?.message;
  if (edited) {
    const synthetic = {
      key: u.key,
      message: edited,
      messageTimestamp: up.messageTimestamp ?? undefined,
    } as WAMessage;
    const message = toInbound(synthetic, true, makeDownload);
    if (!message) return undefined;
    return { kind: "edit", ref, message };
  }

  // RECEIPT — plain per-message status change (the 1:1 case).
  const status = statusOf(up.status);
  if (status) return { kind: "receipt", ref, status };

  return undefined;
}

/** Map a per-participant receipt (`message-receipt.update`, the group case). */
export function mapReceiptUpdate(r: MessageUserReceiptUpdate): Update {
  const ref = keyToRef(r.key);
  const rc = r.receipt;
  // Richest signal wins: played > read > delivered.
  const at =
    secsToMs(rc.playedTimestamp) ?? secsToMs(rc.readTimestamp) ?? secsToMs(rc.receiptTimestamp);
  const status: ReceiptStatus = rc.playedTimestamp
    ? "played"
    : rc.readTimestamp
      ? "read"
      : "delivered";
  const by = rc.userJid ?? undefined;
  return { kind: "receipt", ref, status, ...(by != null && { by }), ...(at != null && { at }) };
}

/** Map a reaction (`messages.reaction`). Falsey `text` means it was cleared. */
export function mapReaction(r: { key: WAMessageKey; reaction: proto.IReaction }): Update {
  const ref = keyToRef(r.key);
  const emoji = r.reaction.text || undefined;
  // The reactor is on the reaction's own key (group: participant; DM: remoteJid).
  const by = r.reaction.key?.participant ?? r.reaction.key?.remoteJid ?? undefined;
  // senderTimestampMs is already milliseconds (Long | number).
  const ms = r.reaction.senderTimestampMs;
  const at = ms == null ? undefined : typeof ms === "number" ? ms : ms.toNumber();
  return {
    kind: "reaction",
    ref,
    removed: !emoji,
    ...(emoji != null && { emoji }),
    ...(by != null && { by }),
    ...(at != null && { at }),
  };
}
