/**
 * Outbound → Baileys. The pure mirror of `inbound.ts`: our `Outbound` union →
 * `AnyMessageContent`, and `SendOptions` → `MiscMessageGenerationOptions`. The
 * Baileys types stay sealed in this dir. Quoting needs the original `WAMessage`,
 * which the surface must never see — so the caller passes a `MessageRef` and a
 * `resolveQuoted` lookup (the socket's recent-message LRU) turns it back into a
 * `WAMessage` inside this wall.
 */
import { Readable } from "node:stream";
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMediaUpload,
  WAMessage,
  WAMessageKey,
} from "baileys";
import type { BinaryInput, MessageRef, Outbound, SendOptions } from "../model/outbound.ts";

const VOICE_NOTE_MIME = "audio/ogg; codecs=opus";

/** BinaryInput → WAMediaUpload (Buffer | {url} | {stream}). */
function upload(b: BinaryInput): WAMediaUpload {
  if (Buffer.isBuffer(b)) return b;
  if ("url" in b) return { url: b.url };
  return { stream: Readable.from(b.stream) };
}

/** MessageRef → WAMessageKey — plain reconstruction, no proto needed. */
export function refToKey(ref: MessageRef): WAMessageKey {
  return {
    remoteJid: ref.chatId,
    id: ref.id,
    fromMe: ref.fromMe,
    ...(ref.participant && { participant: ref.participant }),
  };
}

/** WAMessageKey → MessageRef — what `send` returns so the caller can edit/delete/react it. */
export function keyToRef(key: WAMessageKey): MessageRef {
  return {
    id: key.id ?? "",
    chatId: key.remoteJid ?? "",
    fromMe: key.fromMe ?? true,
    ...(key.participant && { participant: key.participant }),
  };
}

/** Our union → Baileys content. Pure. */
export function toContent(out: Outbound): AnyMessageContent {
  if ("text" in out) return { text: out.text };
  if ("image" in out)
    return { image: upload(out.image), ...(out.caption && { caption: out.caption }) };
  if ("video" in out)
    return {
      video: upload(out.video),
      ...(out.caption && { caption: out.caption }),
      ...(out.gifPlayback && { gifPlayback: true }),
    };
  if ("audio" in out)
    return {
      audio: upload(out.audio),
      ...(out.ptt && { ptt: true }),
      ...(out.seconds != null && { seconds: out.seconds }),
      mimetype: out.mimetype ?? (out.ptt ? VOICE_NOTE_MIME : "audio/mp4"),
    };
  if ("document" in out)
    return {
      document: upload(out.document),
      fileName: out.fileName,
      mimetype: out.mimetype,
      ...(out.caption && { caption: out.caption }),
    };
  if ("sticker" in out) return { sticker: upload(out.sticker) };
  if ("location" in out)
    return {
      location: {
        degreesLatitude: out.location.lat,
        degreesLongitude: out.location.lng,
        ...(out.location.name && { name: out.location.name }),
        ...(out.location.address && { address: out.location.address }),
      },
    };
  if ("contacts" in out)
    return {
      contacts: {
        ...(out.contacts.displayName && { displayName: out.contacts.displayName }),
        contacts: out.contacts.vcards.map((vcard) => ({ vcard })),
      },
    };
  if ("react" in out) return { react: { text: out.react.emoji, key: refToKey(out.react.to) } };
  if ("edit" in out) return { text: out.edit.text, edit: refToKey(out.edit.target) };
  return { delete: refToKey(out.delete) };
}

/** SendOptions → Baileys generation options; resolves a quote via the LRU. */
export function toOptions(
  opts: SendOptions | undefined,
  resolveQuoted: (ref: MessageRef) => WAMessage | undefined,
): MiscMessageGenerationOptions {
  if (!opts) return {};
  const quoted = opts.quote ? resolveQuoted(opts.quote) : undefined;
  return {
    ...(quoted && { quoted }),
    ...(opts.mentions && opts.mentions.length > 0 && { mentions: [...opts.mentions] }),
  };
}
