import { expect, test } from "./_expect.ts";
import { toInbound } from "../src/baileys/inbound.ts";
import { baseMessage, realMessage } from "./fixtures.ts";

// ── text ───────────────────────────────────────────────────────────────────

test("conversation → text", () => {
  const m = toInbound(baseMessage({}, { conversation: "hello" }), true)!;
  expect(m.kind).toBe("text");
  expect((m as { text: string }).text).toBe("hello");
  expect(m.live).toBe(true);
  expect(m.id).toBe("ABC");
  expect(m.chatId).toBe("1234567890@s.whatsapp.net");
});

test("extendedTextMessage → text", () => {
  const m = toInbound(baseMessage({}, { extendedTextMessage: { text: "hi there" } }), false)!;
  expect(m.kind).toBe("text");
  expect((m as { text: string }).text).toBe("hi there");
  expect(m.live).toBe(false); // history append
});

// round-trip through Baileys' OWN generator — the strong test
test("round-trip: real generated text message parses back to text", async () => {
  const raw = await realMessage({ text: "round trip" });
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("text");
  expect((m as { text: string }).text).toBe("round trip");
});

// ── media (hand-built proto — metadata only, bytes fetched on demand) ────────

test("imageMessage → image with metadata + caption", () => {
  const raw = baseMessage(
    {},
    {
      imageMessage: {
        mimetype: "image/jpeg",
        fileLength: 12345,
        width: 640,
        height: 480,
        caption: "a photo",
        mediaKey: new Uint8Array([1, 2, 3]),
      },
    },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("image");
  const im = m as {
    media: { mimetype?: string; fileLength?: number; width?: number };
    text?: string;
  };
  expect(im.media.mimetype).toBe("image/jpeg");
  expect(im.media.fileLength).toBe(12345);
  expect(im.media.width).toBe(640);
  expect(im.text).toBe("a photo");
});

test("audioMessage ptt → audio voice-note metadata", () => {
  const raw = baseMessage(
    {},
    { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 7, ptt: true } },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("audio");
  const a = m as { media: { ptt?: boolean; seconds?: number } };
  expect(a.media.ptt).toBe(true);
  expect(a.media.seconds).toBe(7);
});

test("documentMessage → document with fileName", () => {
  const raw = baseMessage(
    {},
    { documentMessage: { mimetype: "application/pdf", fileName: "report.pdf", fileLength: 999 } },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("document");
  expect((m as { media: { fileName?: string } }).media.fileName).toBe("report.pdf");
});

test("media handle: download() is wired to the injected fetcher", async () => {
  const bytes = Buffer.from("FAKEBYTES");
  const makeDownload = () => () => Promise.resolve(bytes);
  const raw = baseMessage({}, { imageMessage: { mimetype: "image/jpeg" } });
  const m = toInbound(raw, true, makeDownload)!;
  const im = m as { media: { download(): Promise<Buffer> } };
  expect((await im.media.download()).toString()).toBe("FAKEBYTES");
});

test("media handle: default (no socket) exists but rejects on download()", async () => {
  const raw = baseMessage({}, { imageMessage: { mimetype: "image/jpeg" } });
  const m = toInbound(raw, true)!; // no downloader bound
  const im = m as { media: { download(): Promise<Buffer> } };
  let rejected = false;
  await im.media.download().catch((e: Error) => {
    rejected = true;
    expect(e.message).toContain("no downloader");
  });
  expect(rejected).toBe(true);
});

// ── location / contacts / poll ───────────────────────────────────────────────

test("locationMessage → location", () => {
  const raw = baseMessage(
    {},
    { locationMessage: { degreesLatitude: 51.5, degreesLongitude: -0.12, name: "London" } },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("location");
  const l = m as { lat: number; lng: number; name?: string };
  expect(l.lat).toBe(51.5);
  expect(l.lng).toBe(-0.12);
  expect(l.name).toBe("London");
});

test("contactMessage → contacts", () => {
  const raw = baseMessage(
    {},
    { contactMessage: { displayName: "Jane", vcard: "BEGIN:VCARD\nEND:VCARD" } },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("contacts");
  const c = m as unknown as { contacts: { name?: string; vcard: string }[] };
  expect(c.contacts[0]!.name).toBe("Jane");
});

test("pollCreationMessage → poll", () => {
  const raw = baseMessage(
    {},
    {
      pollCreationMessage: {
        name: "Lunch?",
        options: [{ optionName: "A" }, { optionName: "B" }],
        selectableOptionsCount: 1,
      },
    },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("poll");
  const p = m as unknown as { name: string; options: string[]; selectableCount: number };
  expect(p.name).toBe("Lunch?");
  expect(p.options).toEqual(["A", "B"]);
  expect(p.selectableCount).toBe(1);
});

// ── catch-all + flags + context + addressing ─────────────────────────────────

test("unknown type → unsupported (never dropped, never thrown)", () => {
  const raw = baseMessage({}, { reactionMessage: { text: "👍", key: { id: "X" } } });
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("unsupported");
  expect((m as { rawType: string }).rawType).toBe("reactionMessage");
});

test("viewOnce wrapper → inner image detected, flag kept", () => {
  const raw = baseMessage(
    {},
    {
      viewOnceMessage: { message: { imageMessage: { mimetype: "image/jpeg", caption: "secret" } } },
    },
  );
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("image");
  expect(m.flags?.viewOnce).toBe(true);
});

test("ephemeral wrapper → inner text detected, flag kept", () => {
  const raw = baseMessage({}, { ephemeralMessage: { message: { conversation: "poof" } } });
  const m = toInbound(raw, true)!;
  expect(m.kind).toBe("text");
  expect((m as { text: string }).text).toBe("poof");
  expect(m.flags?.ephemeral).toBe(true);
});

test("quote + mentions lifted into context", () => {
  const raw = baseMessage(
    {},
    {
      extendedTextMessage: {
        text: "@you reply",
        contextInfo: {
          stanzaId: "QUOTED1",
          participant: "9999@s.whatsapp.net",
          mentionedJid: ["111@s.whatsapp.net"],
        },
      },
    },
  );
  const m = toInbound(raw, true)!;
  expect(m.context?.quoted?.id).toBe("QUOTED1");
  expect(m.context?.quoted?.from).toBe("9999@s.whatsapp.net");
  expect(m.context?.mentions).toEqual(["111@s.whatsapp.net"]);
});

test("LID addressing resolved + alt kept (decode-wa-message.ts)", () => {
  const raw = baseMessage({
    addressingMode: "lid",
    participant: "55555@lid",
    participantAlt: "12345@s.whatsapp.net",
  });
  const m = toInbound(raw, true)!;
  expect(m.from).toBe("55555@lid");
  expect(m.addressing?.mode).toBe("lid");
  expect(m.addressing?.alt).toBe("12345@s.whatsapp.net");
});

test("LID 1:1 DM with empty-string participant → from falls back to chatId (live-observed)", () => {
  // WhatsApp delivers participant="" (not undefined) on LID-addressed DMs.
  const raw = baseMessage({
    remoteJid: "100000000000000@lid",
    participant: "",
    addressingMode: "lid",
  });
  const m = toInbound(raw, true)!;
  expect(m.from).toBe("100000000000000@lid");
});

test("group chat flagged isGroup", () => {
  const raw = baseMessage({ remoteJid: "123-456@g.us", participant: "777@s.whatsapp.net" });
  const m = toInbound(raw, true)!;
  expect(m.isGroup).toBe(true);
  expect(m.from).toBe("777@s.whatsapp.net");
});

test("no remoteJid/id → dropped (not addressable)", () => {
  expect(toInbound({ key: { id: "X" }, message: { conversation: "x" } } as never, true)).toBe(
    undefined,
  );
});

// ── contacts array (multiple) — was untested ─────────────────────────────────

test("contactsArrayMessage → contacts with multiple entries", () => {
  const m = toInbound(
    baseMessage(
      {},
      {
        contactsArrayMessage: {
          displayName: "Two People",
          contacts: [
            { displayName: "Alice", vcard: "BEGIN:VCARD\nFN:Alice\nEND:VCARD" },
            { displayName: "Bob", vcard: "BEGIN:VCARD\nFN:Bob\nEND:VCARD" },
          ],
        },
      },
    ),
    true,
  )!;
  expect(m.kind).toBe("contacts");
  const c = m as unknown as { contacts: { name?: string; vcard: string }[] };
  expect(c.contacts.length).toBe(2);
  expect(c.contacts[0]!.name).toBe("Alice");
  expect(c.contacts[1]!.vcard).toContain("Bob");
});
