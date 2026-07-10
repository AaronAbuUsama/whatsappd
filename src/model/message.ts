/**
 * Inbound message shapes. Protocol-free types.
 *
 * @remarks
 * A closed discriminated union with an `unsupported` catch-all, so it is
 * type-impossible to crash on — or silently drop — a message. Media bodies are
 * a lazy {@link MediaHandle}: the bytes never sit in the event stream and are
 * fetched on demand, so the media kinds carry metadata only until you download.
 *
 * @packageDocumentation
 */

/** Quote / mentions, lifted from the proto contextInfo (WAProto ContextInfo). */
export interface MessageContext {
  /** the message being replied to: contextInfo.stanzaId + participant */
  readonly quoted?: { readonly id: string; readonly from: string };
  /** contextInfo.mentionedJid */
  readonly mentions?: readonly string[];
}

/**
 * How the sender identity was resolved. `from` on the message is the resolved
 * id; `alt` carries the alternate form so a host can map between the two
 * identity schemes (LID and phone number).
 */
export interface Addressing {
  readonly mode: "lid" | "pn";
  /** The alternate identity, when available. */
  readonly alt?: string;
}

/** Unwrapped wrapper flags — kept even though we detect on the inner content. */
export interface MessageFlags {
  readonly viewOnce?: boolean;
  readonly ephemeral?: boolean;
  readonly edited?: boolean;
}

interface Base {
  readonly id: string;
  readonly chatId: string;
  /** resolved sender identity (see `addressing` for the alternate form) */
  readonly from: string;
  /** sender's WhatsApp display name (proto pushName), when present. */
  readonly pushName?: string;
  readonly fromMe: boolean;
  readonly timestamp: number;
  /** true = live (`messages.upsert` type "notify"); false = history ("append"). */
  readonly live: boolean;
  readonly isGroup: boolean;
  readonly context?: MessageContext;
  readonly addressing?: Addressing;
  readonly flags?: MessageFlags;
}

/** Media metadata, lifted from the proto. The bytes are fetched via `MediaHandle`. */
export interface MediaMeta {
  readonly mimetype?: string;
  readonly fileLength?: number;
  readonly fileName?: string;
  readonly seconds?: number;
  readonly ptt?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly caption?: string;
}

/**
 * Opaque, on-demand media: metadata now, bytes when you ask.
 * `download()` fetches + decrypts, transparently re-uploading expired media.
 * Bytes never travel in the event stream — the consumer pulls them when ready.
 */
export interface MediaHandle extends MediaMeta {
  download(): Promise<Buffer>;
}

export type InboundMessage = Base &
  (
    | { kind: "text"; text: string }
    | {
        kind: "image" | "video" | "audio" | "document" | "sticker";
        media: MediaHandle;
        text?: string;
      }
    | {
        kind: "location";
        lat: number;
        lng: number;
        name?: string;
        address?: string;
      }
    | { kind: "contacts"; contacts: readonly { name?: string; vcard: string }[] }
    | { kind: "poll"; name: string; options: readonly string[]; selectableCount: number }
    | { kind: "unsupported"; rawType: string } // catch-all — never drop a message
  );
