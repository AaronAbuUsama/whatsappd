/**
 * Outbound message shapes that cross the surface. Pure types only — no Baileys.
 * Maps 1:1 to Baileys' `AnyMessageContent` in `baileys/outbound.ts`.
 */
import type { InboundMessage } from "./message.ts";

/** Bytes to send: an in-memory buffer, a URL Baileys fetches, or a byte stream. */
export type BinaryInput = Buffer | { url: string } | { stream: AsyncIterable<Uint8Array> };

/**
 * A plain reference to an existing message — enough to rebuild the Baileys key
 * for react/edit/delete/quote WITHOUT leaking the proto. Build one from an
 * `InboundMessage` via `refOf`, or construct it yourself.
 */
export interface MessageRef {
  readonly id: string;
  readonly chatId: string;
  readonly fromMe: boolean;
  /** group sender, if the target is a group message */
  readonly participant?: string;
}

export type Outbound =
  | { text: string }
  | { image: BinaryInput; caption?: string }
  | { video: BinaryInput; caption?: string; gifPlayback?: boolean }
  /** `ptt: true` sends a voice note (mimetype defaults to ogg/opus). */
  | { audio: BinaryInput; ptt?: boolean; seconds?: number; mimetype?: string }
  | { document: BinaryInput; fileName: string; mimetype: string; caption?: string }
  | { sticker: BinaryInput }
  | { location: { lat: number; lng: number; name?: string; address?: string } }
  | { contacts: { displayName?: string; vcards: readonly string[] } }
  /** React to a message; `emoji: ""` clears the reaction. */
  | { react: { to: MessageRef; emoji: string } }
  | { edit: { target: MessageRef; text: string } }
  | { delete: MessageRef };

export interface SendOptions {
  /** reply to / quote this message */
  readonly quote?: MessageRef;
  /** jids to @mention (must also appear in the text) */
  readonly mentions?: readonly string[];
}

/** Build a `MessageRef` from a received message, for react/edit/delete/quote. */
export function refOf(m: InboundMessage): MessageRef {
  return {
    id: m.id,
    chatId: m.chatId,
    fromMe: m.fromMe,
    ...(m.isGroup && { participant: m.from }),
  };
}
