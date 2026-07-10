import { expect, test } from "./_expect.ts";
import { generateWAMessage, type AnyMessageContent } from "baileys";
import { toContent, refToKey, keyToRef, toOptions } from "../src/baileys/outbound.ts";
import { toInbound } from "../src/baileys/inbound.ts";
import { refOf, type MessageRef, type Outbound } from "../src/model/outbound.ts";

const REF: MessageRef = { id: "MSG1", chatId: "111@s.whatsapp.net", fromMe: false };

// ── pure mapping: Outbound → AnyMessageContent ───────────────────────────────

test("text → { text }", () => {
  expect(toContent({ text: "hi" })).toEqual({ text: "hi" });
});

test("image (Buffer) → { image, caption }", () => {
  const buf = Buffer.from("x");
  const c = toContent({ image: buf, caption: "cap" }) as { image: Buffer; caption?: string };
  expect(c.image).toBe(buf);
  expect(c.caption).toBe("cap");
});

test("image ({url}) → passthrough upload", () => {
  const c = toContent({ image: { url: "https://x/y.jpg" } }) as { image: { url: string } };
  expect(c.image.url).toBe("https://x/y.jpg");
});

test("video gifPlayback flag carried", () => {
  const c = toContent({ video: Buffer.from("v"), gifPlayback: true }) as { gifPlayback?: boolean };
  expect(c.gifPlayback).toBe(true);
});

test("audio ptt → voice note with ogg/opus default mimetype", () => {
  const c = toContent({ audio: Buffer.from("a"), ptt: true }) as {
    ptt?: boolean;
    mimetype?: string;
  };
  expect(c.ptt).toBe(true);
  expect(c.mimetype).toContain("opus");
});

test("document → fileName + mimetype", () => {
  const c = toContent({
    document: Buffer.from("d"),
    fileName: "r.pdf",
    mimetype: "application/pdf",
  }) as {
    fileName: string;
    mimetype: string;
  };
  expect(c.fileName).toBe("r.pdf");
  expect(c.mimetype).toBe("application/pdf");
});

test("location → proto degrees", () => {
  const c = toContent({ location: { lat: 51.5, lng: -0.12, name: "London" } }) as {
    location: { degreesLatitude: number; degreesLongitude: number; name?: string };
  };
  expect(c.location.degreesLatitude).toBe(51.5);
  expect(c.location.degreesLongitude).toBe(-0.12);
  expect(c.location.name).toBe("London");
});

test("contacts → displayName + vcards", () => {
  const c = toContent({
    contacts: { displayName: "Jane", vcards: ["BEGIN:VCARD\nEND:VCARD"] },
  }) as {
    contacts: { displayName?: string; contacts: { vcard: string }[] };
  };
  expect(c.contacts.displayName).toBe("Jane");
  expect(c.contacts.contacts[0]!.vcard).toContain("VCARD");
});

test("react → { react: { text, key } }", () => {
  const c = toContent({ react: { to: REF, emoji: "👍" } }) as {
    react: { text: string; key: { id: string } };
  };
  expect(c.react.text).toBe("👍");
  expect(c.react.key.id).toBe("MSG1");
});

test("edit → { text, edit: key }", () => {
  const c = toContent({ edit: { target: REF, text: "fixed" } }) as {
    text: string;
    edit: { id: string };
  };
  expect(c.text).toBe("fixed");
  expect(c.edit.id).toBe("MSG1");
});

test("delete → { delete: key }", () => {
  const c = toContent({ delete: REF }) as { delete: { id: string; remoteJid: string } };
  expect(c.delete.id).toBe("MSG1");
  expect(c.delete.remoteJid).toBe("111@s.whatsapp.net");
});

test("refToKey reconstructs the WAMessageKey from a plain ref", () => {
  const k = refToKey({ id: "A", chatId: "g@g.us", fromMe: true, participant: "p@s.whatsapp.net" });
  expect(k).toEqual({
    remoteJid: "g@g.us",
    id: "A",
    fromMe: true,
    participant: "p@s.whatsapp.net",
  });
});

test("refOf lifts an inbound message into a ref", () => {
  const inbound = toInbound(
    {
      key: { remoteJid: "c@s.whatsapp.net", id: "ID9", fromMe: false },
      message: { conversation: "hi" },
      messageTimestamp: 1,
    } as never,
    true,
  )!;
  expect(refOf(inbound)).toEqual({ id: "ID9", chatId: "c@s.whatsapp.net", fromMe: false });
});

// ── round-trip through Baileys' OWN generator (the strong test) ───────────────

async function roundTrip(out: Outbound) {
  const raw = await generateWAMessage("111@s.whatsapp.net", toContent(out) as AnyMessageContent, {
    userJid: "me@s.whatsapp.net",
    messageId: "RT",
    upload: () => {
      throw new Error("no media upload in round-trip");
    },
  });
  return toInbound(raw, true)!;
}

test("round-trip: text survives Outbound → Baileys → Inbound", async () => {
  const m = await roundTrip({ text: "hello world" });
  expect(m.kind).toBe("text");
  expect((m as { text: string }).text).toBe("hello world");
});

test("round-trip: location survives the full loop", async () => {
  const m = await roundTrip({ location: { lat: 40.7, lng: -74, name: "NYC" } });
  expect(m.kind).toBe("location");
  const l = m as { lat: number; lng: number; name?: string };
  expect(l.lat).toBe(40.7);
  expect(l.lng).toBe(-74);
  expect(l.name).toBe("NYC");
});

test("round-trip: contacts survive the full loop", async () => {
  const m = await roundTrip({
    contacts: { displayName: "Jane", vcards: ["BEGIN:VCARD\nFN:Jane\nEND:VCARD"] },
  });
  expect(m.kind).toBe("contacts");
  expect((m as unknown as { contacts: { vcard: string }[] }).contacts[0]!.vcard).toContain("Jane");
});

// ── previously untested edges (bucket A) ─────────────────────────────────────

test("image ({stream}) → upload as a Readable stream", async () => {
  async function* bytes() {
    yield new Uint8Array([1, 2, 3]);
  }
  const c = toContent({ image: { stream: bytes() } }) as { image: { stream?: unknown } };
  // node Readable is an async-iterable object; assert we produced a stream, not a Buffer/url.
  expect(typeof (c.image.stream as { pipe?: unknown })?.pipe).toBe("function");
});

test("keyToRef maps a WAMessageKey back to a MessageRef (group: keeps participant)", () => {
  const ref = keyToRef({
    remoteJid: "g@g.us",
    id: "M1",
    fromMe: false,
    participant: "p@s.whatsapp.net",
  });
  expect(ref).toEqual({
    id: "M1",
    chatId: "g@g.us",
    fromMe: false,
    participant: "p@s.whatsapp.net",
  });
});

test("keyToRef defaults fromMe true and drops empty participant", () => {
  const ref = keyToRef({ remoteJid: "c@s.whatsapp.net", id: "M2" });
  expect(ref).toEqual({ id: "M2", chatId: "c@s.whatsapp.net", fromMe: true });
});

test("toOptions carries mentions through", () => {
  const o = toOptions({ mentions: ["a@s.whatsapp.net", "b@s.whatsapp.net"] }, () => undefined) as {
    mentions?: string[];
  };
  expect(o.mentions).toEqual(["a@s.whatsapp.net", "b@s.whatsapp.net"]);
});

test("toOptions drops a quote whose ref is not in the recent LRU (graceful, no throw)", () => {
  const o = toOptions({ quote: REF }, () => undefined) as { quoted?: unknown };
  expect(o.quoted).toBe(undefined);
});

test("toOptions resolves a quote when the ref IS in the LRU", () => {
  const fakeQuoted = { key: { id: "MSG1" }, message: { conversation: "x" } } as never;
  const o = toOptions({ quote: REF }, () => fakeQuoted) as { quoted?: unknown };
  expect(o.quoted).toBe(fakeQuoted);
});
