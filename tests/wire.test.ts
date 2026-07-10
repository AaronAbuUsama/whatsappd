import { expect, test } from "./_expect.ts";
import {
  messagePreview,
  reviveOutbound,
  toWireMessage,
  toWireUpdate,
  type WireMessage,
} from "../src/sidecar/wire.ts";
import type { InboundMessage, MediaHandle } from "../src/model/message.ts";
import type { Update } from "../src/model/update.ts";

const BASE = {
  id: "M1",
  chatId: "1234567890@s.whatsapp.net",
  from: "1234567890@s.whatsapp.net",
  fromMe: false,
  timestamp: 1675888000,
  live: true,
  isGroup: false,
} as const;

function mediaHandle(meta: Partial<MediaHandle> = {}): MediaHandle {
  return {
    mimetype: "image/jpeg",
    fileLength: 3,
    ...meta,
    download: async () => Buffer.from("img"),
  };
}

// ── toWireMessage ──

test("toWireMessage passes text messages through", () => {
  const msg: InboundMessage = { ...BASE, kind: "text", text: "hello" };
  const wire = toWireMessage(msg);
  expect(wire).toEqual({
    id: "M1",
    chatId: BASE.chatId,
    from: BASE.from,
    fromMe: false,
    timestamp: BASE.timestamp,
    isGroup: false,
    kind: "text",
    text: "hello",
  });
});

test("toWireMessage flattens media to metadata + url (no download fn)", () => {
  const msg: InboundMessage = {
    ...BASE,
    kind: "image",
    media: mediaHandle({ caption: "a photo", width: 100 }),
    text: "a photo",
  };
  const wire = toWireMessage(msg, "/media/acc/M1");
  expect(wire.kind).toBe("image");
  if (wire.kind !== "image") throw new Error("unreachable");
  expect(wire.media.url).toBe("/media/acc/M1");
  expect(wire.media.mimetype).toBe("image/jpeg");
  expect(wire.media.caption).toBe("a photo");
  expect("download" in wire.media).toBe(false);
  // the whole thing must survive JSON
  expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
});

test("toWireMessage omits url when none is given", () => {
  const msg: InboundMessage = { ...BASE, kind: "audio", media: mediaHandle({ ptt: true }) };
  const wire = toWireMessage(msg);
  if (wire.kind !== "audio") throw new Error("unreachable");
  expect(wire.media.url).toBe(undefined);
  expect(wire.media.ptt).toBe(true);
});

test("toWireMessage keeps location, poll, and unsupported payloads", () => {
  const loc: InboundMessage = { ...BASE, kind: "location", lat: 1.5, lng: 2.5, name: "Cafe" };
  const wireLoc = toWireMessage(loc);
  if (wireLoc.kind !== "location") throw new Error("unreachable");
  expect(wireLoc.lat).toBe(1.5);
  expect(wireLoc.name).toBe("Cafe");

  const unsupported: InboundMessage = { ...BASE, kind: "unsupported", rawType: "weird" };
  const wireUn = toWireMessage(unsupported);
  if (wireUn.kind !== "unsupported") throw new Error("unreachable");
  expect(wireUn.rawType).toBe("weird");
});

// ── toWireUpdate ──

test("toWireUpdate passes receipts through and flattens edits", () => {
  const ref = { id: "M1", chatId: BASE.chatId, fromMe: true };
  const receipt: Update = { kind: "receipt", ref, status: "read" };
  expect(toWireUpdate(receipt)).toEqual(receipt);

  const edit: Update = {
    kind: "edit",
    ref,
    message: { ...BASE, kind: "image", media: mediaHandle() },
  };
  const wire = toWireUpdate(edit);
  if (wire.kind !== "edit") throw new Error("unreachable");
  expect(wire.message.kind).toBe("image");
  expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
});

// ── reviveOutbound ──

test("reviveOutbound turns { b64 } media into a Buffer", () => {
  const revived = reviveOutbound({
    image: { b64: Buffer.from("img").toString("base64") },
    caption: "hi",
  });
  const image = (revived as { image: Buffer }).image;
  expect(Buffer.isBuffer(image)).toBe(true);
  expect(image.toString()).toBe("img");
  expect((revived as { caption: string }).caption).toBe("hi");
});

test("reviveOutbound leaves { url } media and text alone", () => {
  const withUrl = reviveOutbound({ video: { url: "https://x/v.mp4" } });
  expect((withUrl as { video: { url: string } }).video.url).toBe("https://x/v.mp4");
  expect(reviveOutbound({ text: "hello" })).toEqual({ text: "hello" });
});

// ── messagePreview ──

test("messagePreview prefers text, then caption, then a [kind] tag", () => {
  const text: WireMessage = { ...BASE, kind: "text", text: "hi" };
  expect(messagePreview(text)).toBe("hi");

  const captioned: WireMessage = { ...BASE, kind: "image", media: { caption: "sunset" } };
  expect(messagePreview(captioned)).toBe("sunset");

  const bare: WireMessage = { ...BASE, kind: "sticker", media: {} };
  expect(messagePreview(bare)).toBe("[sticker]");

  const poll: WireMessage = {
    ...BASE,
    kind: "poll",
    name: "Lunch?",
    options: ["yes", "no"],
    selectableCount: 1,
  };
  expect(messagePreview(poll)).toBe("[poll: Lunch?]");
});
