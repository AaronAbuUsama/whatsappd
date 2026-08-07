import { isOnline, isTerminal, type Status } from "../model/status.ts";
import { refOf } from "../model/outbound.ts";
import type { Update } from "../model/update.ts";
import type { WhatsAppSessionHandlers } from "../subscription.ts";
import type { DurableInboundMessage, DurableUpdate, WhatsAppBackend } from "./contracts.ts";

export async function captureMessage(
  accountId: string,
  mediaStore: WhatsAppBackend["media"],
  message: Parameters<NonNullable<WhatsAppSessionHandlers["message"]>>[0],
): Promise<DurableInboundMessage> {
  switch (message.kind) {
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const source = message.media;
      const metadata = {
        ...(source.mimetype !== undefined && { mimetype: source.mimetype }),
        ...(source.fileLength !== undefined && { fileLength: source.fileLength }),
        ...(source.fileName !== undefined && { fileName: source.fileName }),
        ...(source.seconds !== undefined && { seconds: source.seconds }),
        ...(source.ptt !== undefined && { ptt: source.ptt }),
        ...(source.width !== undefined && { width: source.width }),
        ...(source.height !== undefined && { height: source.height }),
        ...(source.caption !== undefined && { caption: source.caption }),
      };
      let bytes: Uint8Array;
      try {
        bytes = await source.download();
      } catch {
        return { ...message, media: { ...metadata, state: "failed", reason: "download_failed" } };
      }
      try {
        const stored = await mediaStore.put({
          accountId,
          message: refOf(message),
          kind: message.kind,
          bytes,
          ...(metadata.mimetype !== undefined && { mimetype: metadata.mimetype }),
        });
        return { ...message, media: { ...metadata, state: "stored", ...stored } };
      } catch {
        return { ...message, media: { ...metadata, state: "failed", reason: "store_failed" } };
      }
    }
    default:
      return message;
  }
}

export async function durableUpdate(
  accountId: string,
  mediaStore: WhatsAppBackend["media"],
  update: Update,
): Promise<DurableUpdate> {
  if (update.kind !== "edit") return update;
  return { ...update, message: await captureMessage(accountId, mediaStore, update.message) };
}

export function connectionInstant(status: Status): "connected" | "disconnected" | undefined {
  return isOnline(status)
    ? "connected"
    : status.phase === "disconnected" || status.phase === "backing_off" || isTerminal(status)
      ? "disconnected"
      : undefined;
}
