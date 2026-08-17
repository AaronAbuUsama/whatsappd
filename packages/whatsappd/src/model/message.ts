/**
 * Inbound message shapes. Protocol-free types.
 *
 * @remarks
 * A closed discriminated union with an `unsupported` catch-all, so it is
 * type-impossible to crash on — or silently drop — a message. Media bodies are
 * a lazy {@link MediaHandle}: the bytes never sit in the event payload and are
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
 * An actual WhatsApp address (ADR-0001).
 *
 * @remarks
 * `id` is the native address of the party WhatsApp named, and `mode` says which
 * identity scheme it belongs to; `alt` carries the known equivalent native form
 * (LID ↔ phone-number JID) when WhatsApp supplies one, so a host can join the
 * two schemes. This is an address, not a person: no identity is merged,
 * invented, or resolved beyond the forms WhatsApp itself delivered.
 */
export interface WhatsAppAddress {
  readonly id: string;
  readonly mode: "lid" | "pn";
  /** The known equivalent native form, when available. */
  readonly alt?: string;
}

/**
 * Name an address by the native form WhatsApp delivered.
 *
 * @remarks
 * The suffix decides the scheme, so `mode` can never contradict `id` — the
 * proto's own `addressingMode` describes the *chat*, and trusting it would let
 * a phone-number address be labelled `lid` and corrupt any downstream join.
 *
 * @param id - The native address, e.g. `15551234567@s.whatsapp.net` or `55555@lid`.
 * @param alt - The known equivalent native form, when WhatsApp supplied one.
 * @returns The address, carrying `alt` only when it is present.
 */
export function addressOf(id: string, alt?: string): WhatsAppAddress {
  return { id, mode: id.endsWith("@lid") ? "lid" : "pn", ...(alt && { alt }) };
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
  /**
   * The actual author of the message. Own-sent messages name the linked
   * account, never the peer or the group chat.
   */
  readonly sender: WhatsAppAddress;
  /**
   * The participant WhatsApp delivered on this message's protocol key, when it
   * set one.
   *
   * @remarks
   * A routing detail, **not** an author — read {@link Base.sender} for that.
   * React, edit, and delete target a message by handing its exact key back to
   * WhatsApp, so the delivered participant is kept verbatim: `sender` is the
   * account's one stable address, which is deliberately not restated per chat
   * and so may differ from the form the key carried.
   */
  readonly keyParticipant?: string;
  /** sender's WhatsApp display name (proto pushName), when present. */
  readonly pushName?: string;
  readonly fromMe: boolean;
  readonly timestamp: number;
  /** true = live (`messages.upsert` type "notify"); false = history ("append"). */
  readonly live: boolean;
  readonly isGroup: boolean;
  readonly context?: MessageContext;
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
 * Bytes never travel in the event payload — the consumer pulls them when ready.
 *
 * A failure rejects with `MediaDownloadError`, whose `reason` and `retryable`
 * separate media that is gone from media you are merely being throttled on.
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
