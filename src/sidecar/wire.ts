/**
 * Wire format — the JSON-safe shapes that cross the HTTP bridge between the
 * sidecar process and framework adapters (Eve, or any other HTTP consumer).
 *
 * `InboundMessage` and `Update` are not JSON-safe as-is: media kinds carry a
 * `MediaHandle` whose `download()` closure cannot travel. The wire variants
 * replace the handle with its metadata plus an optional `url` pointing at the
 * sidecar's `/media/...` endpoint, where the bytes can be fetched on demand.
 */
import type { InboundMessage, MediaMeta } from "../model/message.ts";
import type { Outbound, MessageRef, SendOptions } from "../model/outbound.ts";
import type { PresenceKind } from "../model/presence.ts";
import type { Status } from "../model/status.ts";
import type { Update, ReceiptStatus } from "../model/update.ts";

/** Media metadata plus an optional sidecar URL where the bytes are served. */
export interface WireMedia extends MediaMeta {
  /**
   * Where to fetch the decrypted bytes. Relative (`/media/...`) unless the
   * sidecar was configured with a base URL — resolve against the sidecar URL.
   */
  readonly url?: string;
}

/** `InboundMessage` with `MediaHandle` flattened to `WireMedia`. */
export type WireMessage = {
  readonly id: string;
  readonly chatId: string;
  readonly from: string;
  readonly pushName?: string;
  readonly fromMe: boolean;
  readonly timestamp: number;
  readonly isGroup: boolean;
} & (
  | { kind: "text"; text: string }
  | {
      kind: "image" | "video" | "audio" | "document" | "sticker";
      media: WireMedia;
      text?: string;
    }
  | { kind: "location"; lat: number; lng: number; name?: string; address?: string }
  | { kind: "contacts"; contacts: readonly { name?: string; vcard: string }[] }
  | { kind: "poll"; name: string; options: readonly string[]; selectableCount: number }
  | { kind: "unsupported"; rawType: string }
);

/** `Update` with the edit arm's `InboundMessage` flattened to `WireMessage`. */
export type WireUpdate =
  | { kind: "receipt"; ref: MessageRef; at?: number; status: ReceiptStatus; by?: string }
  | {
      kind: "reaction";
      ref: MessageRef;
      at?: number;
      emoji?: string;
      by?: string;
      removed: boolean;
    }
  | { kind: "edit"; ref: MessageRef; at?: number; message: WireMessage }
  | { kind: "revoke"; ref: MessageRef; at?: number; by?: string };

/** One event POSTed by the sidecar to each forward target. */
export type SidecarEvent =
  | {
      type: "message";
      accountId: string;
      chatId: string;
      isGroup: boolean;
      from?: string;
      pushName?: string;
      message: WireMessage;
    }
  | { type: "update"; accountId: string; chatId: string; update: WireUpdate }
  | { type: "status"; accountId: string; status: Status };

/**
 * Media bytes in a request body: base64, or a URL Baileys fetches itself.
 * (A raw Buffer cannot travel as JSON.)
 */
export type WireBinary = { b64: string } | { url: string };

/** Body of `POST /send`. `content` is `Outbound` with `WireBinary` media. */
export interface SendRequest {
  readonly accountId: string;
  readonly chatId: string;
  readonly content: Record<string, unknown>;
  readonly opts?: SendOptions;
}

/** Body of `POST /markRead`. */
export interface MarkReadRequest {
  readonly accountId: string;
  readonly chatId: string;
}

/** Body of `POST /setTyping`. */
export interface SetTypingRequest {
  readonly accountId: string;
  readonly chatId: string;
  readonly kind?: PresenceKind;
}

/** Drop undefined values so wire objects survive a JSON round-trip unchanged. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Flatten an `InboundMessage` for the wire. `mediaUrl` is the sidecar path
 * serving this message's bytes (set only for media kinds).
 */
export function toWireMessage(msg: InboundMessage, mediaUrl?: string): WireMessage {
  const base = {
    id: msg.id,
    chatId: msg.chatId,
    from: msg.from,
    ...(msg.pushName !== undefined && { pushName: msg.pushName }),
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    isGroup: msg.isGroup,
  };
  switch (msg.kind) {
    case "text":
      return { ...base, kind: msg.kind, text: msg.text };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const { mimetype, fileLength, fileName, seconds, ptt, width, height, caption } = msg.media;
      // compact: a JSON round-trip drops undefined values, so never emit them
      const media: WireMedia = compact({
        mimetype,
        fileLength,
        fileName,
        seconds,
        ptt,
        width,
        height,
        caption,
        url: mediaUrl,
      });
      return { ...base, kind: msg.kind, media, ...(msg.text !== undefined && { text: msg.text }) };
    }
    case "location":
      return compact({
        ...base,
        kind: msg.kind,
        lat: msg.lat,
        lng: msg.lng,
        name: msg.name,
        address: msg.address,
      });
    case "contacts":
      return { ...base, kind: msg.kind, contacts: msg.contacts };
    case "poll":
      return {
        ...base,
        kind: msg.kind,
        name: msg.name,
        options: msg.options,
        selectableCount: msg.selectableCount,
      };
    case "unsupported":
      return { ...base, kind: msg.kind, rawType: msg.rawType };
  }
}

/** Flatten an `Update` for the wire (the edit arm carries an `InboundMessage`). */
export function toWireUpdate(update: Update): WireUpdate {
  if (update.kind === "edit") {
    return compact({
      kind: "edit",
      ref: update.ref,
      at: update.at,
      message: toWireMessage(update.message),
    });
  }
  return update;
}

const MEDIA_KEYS = ["image", "video", "audio", "document", "sticker"] as const;

/**
 * Revive a `POST /send` body's content into a real `Outbound`: `{ b64 }`
 * media becomes a Buffer, `{ url }` passes through for Baileys to fetch.
 */
export function reviveOutbound(content: Record<string, unknown>): Outbound {
  const out: Record<string, unknown> = { ...content };
  for (const key of MEDIA_KEYS) {
    const media = out[key];
    if (media && typeof media === "object" && "b64" in media) {
      out[key] = Buffer.from((media as { b64: string }).b64, "base64");
    }
  }
  return out as unknown as Outbound;
}

/** A short human-readable placeholder for non-text message kinds. */
export function messagePreview(msg: WireMessage): string {
  switch (msg.kind) {
    case "text":
      return msg.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return msg.text ?? msg.media.caption ?? `[${msg.kind}]`;
    case "location":
      return `[location${msg.name ? `: ${msg.name}` : ""} ${msg.lat},${msg.lng}]`;
    case "contacts":
      return `[contact card${msg.contacts.length > 1 ? `s (${msg.contacts.length})` : ""}]`;
    case "poll":
      return `[poll: ${msg.name}]`;
    case "unsupported":
      return `[unsupported: ${msg.rawType}]`;
  }
}
