/**
 * WAMessage → InboundMessage. The ONLY file that reads the message proto.
 *
 * Detection follows Baileys exactly: `normalizeMessageContent` unwraps the
 * wrapper layers (viewOnce / ephemeral / edited / documentWithCaption), then
 * `getContentType` names the variant. We peel the wrappers ourselves first to
 * keep the flags, then map the inner content. Anything we don't model becomes
 * `unsupported` — a message is never dropped or thrown on.
 */
import {
  getContentType,
  isJidGroup,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from "baileys";
import {
  addressOf,
  type InboundMessage,
  type MediaHandle,
  type MediaMeta,
  type MessageContext,
  type MessageFlags,
  type WhatsAppAddress,
} from "../model/message.ts";
import { noDownloader, type DownloadThunk } from "./download.ts";

/**
 * Coerce a proto numeric field to a plain `number`.
 *
 * @remarks
 * protobuf 64-bit fields arrive as either a JS `number` or a Long-like object
 * exposing `toNumber()` (protobufjs), depending on magnitude. This collapses
 * both forms — and `null`/`undefined` — to a single optional `number`.
 *
 * @param v - A proto numeric field: a `number`, a Long-like `{ toNumber() }`, or nullish.
 * @returns The numeric value, or `undefined` when the field was absent.
 */
function num(v: number | { toNumber(): number } | null | undefined): number | undefined {
  if (v == null) return undefined;
  return typeof v === "number" ? v : v.toNumber();
}

/**
 * Convert a WhatsApp message timestamp to epoch milliseconds.
 *
 * @remarks
 * The proto carries `messageTimestamp` in whole seconds (as a Long or number);
 * we scale to the millisecond epoch the model uses. A missing timestamp yields
 * `0` rather than `undefined`, since {@link InboundMessage} requires the field.
 *
 * @param ts - The proto `messageTimestamp` field, in seconds.
 * @returns Epoch milliseconds, or `0` when the timestamp was absent.
 */
function toMillis(ts: WAMessage["messageTimestamp"]): number {
  const s = num(ts);
  return s == null ? 0 : s * 1000;
}

/**
 * Peel the known wrapper layers off a message, recording each as a flag.
 *
 * @remarks
 * WhatsApp nests the real content inside optional wrappers —
 * `ephemeralMessage`, `viewOnceMessage` (+ its V2 / V2Extension variants),
 * `editedMessage`, and `documentWithCaptionMessage`. This mirrors Baileys'
 * `normalizeMessageContent` unwrap, but keeps the wrappers we care about as
 * boolean flags instead of discarding them. The loop is capped at 5 iterations
 * to bound against pathologically or maliciously deep nesting;
 * `documentWithCaptionMessage` is unwrapped for depth but carries no flag.
 *
 * @param message - The raw (still-wrapped) proto content, or nullish.
 * @returns The flags observed while unwrapping; keys are present only when set.
 */
function unwrapFlags(message: WAMessageContent | null | undefined): MessageFlags {
  const flags: { viewOnce?: boolean; ephemeral?: boolean; edited?: boolean } = {};
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    if (m.ephemeralMessage) {
      flags.ephemeral = true;
      m = m.ephemeralMessage.message;
    } else if (m.viewOnceMessage ?? m.viewOnceMessageV2 ?? m.viewOnceMessageV2Extension) {
      flags.viewOnce = true;
      m = (m.viewOnceMessage ?? m.viewOnceMessageV2 ?? m.viewOnceMessageV2Extension)?.message;
    } else if (m.editedMessage) {
      flags.edited = true;
      m = m.editedMessage.message;
    } else if (m.documentWithCaptionMessage) {
      m = m.documentWithCaptionMessage.message;
    } else break;
  }
  return flags;
}

/**
 * Lift the quote / mentions relationships out of a message's `contextInfo`.
 *
 * @remarks
 * Every media and rich-text variant carries its own `contextInfo`, so we probe
 * each known carrier in turn and use the first present. A reply is modeled from
 * `stanzaId` (the quoted message id) plus its author (`participant`, falling
 * back to `remoteJid`, then `""`); mentions come from a non-empty
 * `mentionedJid`. Returns `undefined` unless at least one is present, so callers
 * can conditionally spread the field.
 *
 * @param content - The already-normalized inner message content.
 * @returns The {@link MessageContext}, or `undefined` when neither a quote nor mentions exist.
 */
function context(content: WAMessageContent): MessageContext | undefined {
  const ci =
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    content.extendedTextMessage?.contextInfo ??
    content.locationMessage?.contextInfo ??
    content.contactMessage?.contextInfo;
  if (!ci) return undefined;
  const quoted = ci.stanzaId
    ? { id: ci.stanzaId, from: ci.participant ?? ci.remoteJid ?? "" }
    : undefined;
  const mentions = ci.mentionedJid && ci.mentionedJid.length > 0 ? ci.mentionedJid : undefined;
  if (!quoted && !mentions) return undefined;
  return { ...(quoted && { quoted }), ...(mentions && { mentions }) };
}

/**
 * Project a proto media node onto the protocol-free {@link MediaMeta} shape.
 *
 * @remarks
 * Accepts the structural intersection of the image / video / audio / document /
 * sticker message nodes — only the metadata fields, never the bytes. Every field
 * is copied only when non-null (via conditional spread), so absent proto fields
 * stay absent rather than becoming `null`; `fileLength` is additionally coerced
 * through {@link num}. The encrypted payload is fetched separately via the
 * {@link MediaHandle} that `toInbound` attaches.
 *
 * @param m - A proto media node exposing the common metadata fields.
 * @returns The normalized metadata, carrying only the fields that were present.
 */
function media(m: {
  mimetype?: string | null;
  fileLength?: number | { toNumber(): number } | null;
  fileName?: string | null;
  seconds?: number | null;
  ptt?: boolean | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
}): MediaMeta {
  return {
    ...(m.mimetype != null && { mimetype: m.mimetype }),
    ...(num(m.fileLength) != null && { fileLength: num(m.fileLength) }),
    ...(m.fileName != null && { fileName: m.fileName }),
    ...(m.seconds != null && { seconds: m.seconds }),
    ...(m.ptt != null && { ptt: m.ptt }),
    ...(m.width != null && { width: m.width }),
    ...(m.height != null && { height: m.height }),
    ...(m.caption != null && { caption: m.caption }),
  };
}

/**
 * Resolve the actual author of a message (ADR-0001).
 *
 * @remarks
 * Own-sent messages name the linked account, always by the same address — the
 * account's own, never a per-chat restatement of it, so one account is never
 * two identities. WhatsApp leaves `key.participant` empty on own DMs, so the
 * peer fallback below would otherwise attribute them to the conversation
 * counterpart: the misattribution this function exists to prevent. Incoming
 * messages keep the real participant, falling back to the chat id for 1:1
 * chats, where `participant` is legitimately absent because the chat *is* the
 * sender.
 *
 * @param raw - The raw proto message.
 * @param self - The linked account's own address, already normalized (no device suffix).
 * @returns The author's address, carrying its equivalent native form when known.
 */
function senderOf(raw: WAMessage, self: WhatsAppAddress): WhatsAppAddress {
  const key = raw.key;
  if (key.fromMe) return self;
  // `||` not `??`: LID 1:1 DMs deliver participant as "" (empty), not undefined,
  // and the sender there IS the chat peer — fall back to chatId. (live-observed)
  return addressOf(
    key.participant || key.remoteJid || "",
    key.participantAlt || key.remoteJidAlt || undefined,
  );
}

export function toInbound(
  raw: WAMessage,
  live: boolean,
  self: WhatsAppAddress,
  makeDownload: (raw: WAMessage) => DownloadThunk = noDownloader,
): InboundMessage | undefined {
  /** Attach the on-demand byte fetcher to the media metadata. */
  const handle = (meta: MediaMeta): MediaHandle => ({ ...meta, download: makeDownload(raw) });
  const chatId = raw.key.remoteJid;
  const id = raw.key.id;
  if (!chatId || !id) return undefined; // not a real, addressable message

  const flags = unwrapFlags(raw.message);
  const content = normalizeMessageContent(raw.message);
  if (!content) return undefined;
  const kind = getContentType(content);

  const base = {
    id,
    chatId,
    sender: senderOf(raw, self),
    ...(raw.key.participant && { keyParticipant: raw.key.participant }),
    ...(raw.pushName && { pushName: raw.pushName }),
    fromMe: raw.key.fromMe ?? false,
    timestamp: toMillis(raw.messageTimestamp),
    live,
    isGroup: isJidGroup(chatId) ?? false,
    ...(context(content) && { context: context(content) }),
    ...(Object.keys(flags).length > 0 && { flags }),
  };

  switch (kind) {
    case "conversation":
      return { ...base, kind: "text", text: content.conversation ?? "" };
    case "extendedTextMessage":
      return { ...base, kind: "text", text: content.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return {
        ...base,
        kind: "image",
        media: handle(media(content.imageMessage!)),
        ...textOf(content.imageMessage?.caption),
      };
    case "videoMessage":
      return {
        ...base,
        kind: "video",
        media: handle(media(content.videoMessage!)),
        ...textOf(content.videoMessage?.caption),
      };
    case "audioMessage":
      return { ...base, kind: "audio", media: handle(media(content.audioMessage!)) };
    case "documentMessage":
      return {
        ...base,
        kind: "document",
        media: handle(media(content.documentMessage!)),
        ...textOf(content.documentMessage?.caption),
      };
    case "stickerMessage":
      return { ...base, kind: "sticker", media: handle(media(content.stickerMessage!)) };
    case "locationMessage": {
      const l = content.locationMessage!;
      return {
        ...base,
        kind: "location",
        lat: l.degreesLatitude ?? 0,
        lng: l.degreesLongitude ?? 0,
        ...(l.name != null && { name: l.name }),
        ...(l.address != null && { address: l.address }),
      };
    }
    case "contactMessage": {
      const c = content.contactMessage!;
      return {
        ...base,
        kind: "contacts",
        contacts: [{ ...(c.displayName != null && { name: c.displayName }), vcard: c.vcard ?? "" }],
      };
    }
    case "contactsArrayMessage": {
      const arr = content.contactsArrayMessage?.contacts ?? [];
      return {
        ...base,
        kind: "contacts",
        contacts: arr.map((c) => ({
          ...(c.displayName != null && { name: c.displayName }),
          vcard: c.vcard ?? "",
        })),
      };
    }
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3": {
      const p = content[kind]!;
      return {
        ...base,
        kind: "poll",
        name: p.name ?? "",
        options: (p.options ?? []).map((o) => o.optionName ?? ""),
        selectableCount: p.selectableOptionsCount ?? 0,
      };
    }
    default:
      return { ...base, kind: "unsupported", rawType: kind ?? "unknown" };
  }
}

const textOf = (caption: string | null | undefined): { text?: string } =>
  caption != null && caption !== "" ? { text: caption } : {};
