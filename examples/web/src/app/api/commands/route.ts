import * as z from "zod";
import { applicationCommand } from "@/lib/whatsapp.server";
import type { WhatsAppApplicationCommand } from "@/lib/whatsapp-application";
import { transcodeVoiceNote } from "@/lib/voice-note.server";

export const dynamic = "force-dynamic";

const key = z.uuid();
const text = z.string().min(1).max(65_536);
const options = {
  quote: key.optional(),
  mentions: z.array(key).max(64).optional(),
};

const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("send_text"), chat: key, text, ...options }),
  z.strictObject({
    type: z.literal("send_location"),
    chat: key,
    location: z.strictObject({
      lat: z.number().finite().min(-90).max(90),
      lng: z.number().finite().min(-180).max(180),
      name: z.string().max(1_024).optional(),
      address: z.string().max(4_096).optional(),
    }),
    ...options,
  }),
  z.strictObject({
    type: z.literal("send_contacts"),
    chat: key,
    contacts: z.strictObject({
      displayName: z.string().max(1_024).optional(),
      vcards: z.array(z.string().min(1).max(128_000)).min(1).max(64),
    }),
    ...options,
  }),
  z.strictObject({ type: z.literal("react"), message: key, emoji: z.string().min(1).max(32) }),
  z.strictObject({ type: z.literal("unreact"), message: key }),
  z.strictObject({ type: z.literal("edit"), message: key, text }),
  z.strictObject({ type: z.literal("revoke"), message: key }),
  z.strictObject({ type: z.literal("mark_read"), messages: z.array(key).min(1).max(1_000) }),
  z.strictObject({ type: z.literal("typing"), chat: key, on: z.boolean() }),
  z.strictObject({ type: z.literal("load_older"), chat: key }),
  z.strictObject({
    type: z.literal("request_phone_history"),
    chat: key,
    count: z.number().int().min(1).max(50).optional(),
  }),
  z.strictObject({ type: z.literal("acknowledge"), operation: key }),
  z.strictObject({
    type: z.literal("group_create"),
    subject: z.string().trim().min(1).max(100),
    participants: z.array(key).min(1).max(20),
  }),
  z.strictObject({
    type: z.literal("group_subject"),
    chat: key,
    subject: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    type: z.literal("group_description"),
    chat: key,
    description: z.string().max(4_096).optional(),
  }),
  z.strictObject({
    type: z.literal("group_participants"),
    chat: key,
    participants: z.array(key).min(1).max(20),
    action: z.enum(["add", "remove", "promote", "demote"]),
  }),
  z.strictObject({
    type: z.literal("group_setting"),
    chat: key,
    setting: z.enum(["announcement", "not_announcement", "locked", "unlocked"]),
  }),
  z.strictObject({ type: z.literal("group_invite"), chat: key }),
  z.strictObject({ type: z.literal("group_revoke_invite"), chat: key }),
  z.strictObject({ type: z.literal("group_remove_picture"), chat: key }),
  z.strictObject({ type: z.literal("group_leave"), chat: key }),
]);

const mediaSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("send_image"),
    chat: key,
    caption: z.string().max(65_536).optional(),
    ...options,
  }),
  z.strictObject({
    type: z.literal("send_video"),
    chat: key,
    caption: z.string().max(65_536).optional(),
    gifPlayback: z.boolean().optional(),
    ...options,
  }),
  z.strictObject({
    type: z.literal("send_audio"),
    chat: key,
    ptt: z.boolean().optional(),
    seconds: z.number().finite().nonnegative().optional(),
    mimetype: z.string().min(1).max(255).optional(),
    ...options,
  }),
  z.strictObject({
    type: z.literal("send_document"),
    chat: key,
    fileName: z.string().min(1).max(1_024),
    mimetype: z.string().min(1).max(255),
    caption: z.string().max(65_536).optional(),
    ...options,
  }),
  z.strictObject({ type: z.literal("send_sticker"), chat: key, ...options }),
  z.strictObject({ type: z.literal("group_picture"), chat: key }),
]);

function failure(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : "Invalid command";
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const command = commandSchema.parse(await request.json()) as WhatsAppApplicationCommand;
    return Response.json(await applicationCommand(command), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}

const FRAME_LIMIT_BYTES = 64 * 1024;

async function framedMedia(body: ReadableStream<Uint8Array> | null): Promise<{
  readonly metadata: z.infer<typeof mediaSchema>;
  readonly source: AsyncIterable<Uint8Array>;
}> {
  if (!body) throw new TypeError("Media body is required");
  const reader = body.getReader();
  const prefixes: Uint8Array[] = [];
  let prefixBytes = 0;
  let remainder: Uint8Array | undefined;
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new TypeError("Media frame has no payload");
    const newline = next.value.indexOf(10);
    if (newline >= 0) {
      prefixes.push(next.value.subarray(0, newline));
      prefixBytes += newline;
      remainder = next.value.subarray(newline + 1);
      break;
    }
    prefixes.push(next.value);
    prefixBytes += next.value.byteLength;
    if (prefixBytes > FRAME_LIMIT_BYTES) throw new TypeError("Media metadata is too large");
  }
  if (prefixBytes > FRAME_LIMIT_BYTES) throw new TypeError("Media metadata is too large");
  const encoded = new Uint8Array(prefixBytes);
  let offset = 0;
  for (const prefix of prefixes) {
    encoded.set(prefix, offset);
    offset += prefix.byteLength;
  }
  const metadata = mediaSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)),
  );
  const source = {
    async *[Symbol.asyncIterator]() {
      try {
        if (remainder?.byteLength) yield remainder;
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  return { metadata, source };
}

export async function PUT(request: Request): Promise<Response> {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const { metadata, source: uploaded } = await framedMedia(request.body);
    let source = uploaded;
    let normalized = metadata;
    if (metadata.type === "send_audio" && metadata.ptt) {
      const voice = await transcodeVoiceNote(uploaded);
      source = voice.source;
      cleanup = () => voice.cleanup();
      normalized = { ...metadata, mimetype: "audio/ogg; codecs=opus" };
    }
    return Response.json(
      await applicationCommand({ ...normalized, source } as WhatsAppApplicationCommand),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  } finally {
    await cleanup?.();
  }
}
