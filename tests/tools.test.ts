import { expect, test } from "./_expect.ts";
import {
  sendText,
  sendMedia,
  reply,
  markRead,
  setTyping,
  react,
  edit,
  deleteMsg,
  bindTools,
  allTools,
  type ToolContext,
} from "../src/tools/index.ts";
import type { WhatsAppChannelAdapter } from "../src/channel/types.ts";
import type { Outbound, MessageRef, SendOptions } from "../src/model/outbound.ts";
import type { PresenceKind } from "../src/model/presence.ts";

const REF: MessageRef = { id: "M1", chatId: "chat@s.whatsapp.net", fromMe: true };
const REF2: MessageRef = {
  id: "M2",
  chatId: "chat@s.whatsapp.net",
  fromMe: false,
  participant: "p@s.whatsapp.net",
};

/** A fake adapter that records all calls. */
function fakeAdapter(): WhatsAppChannelAdapter & {
  sends: { to: string; content: Outbound; opts?: SendOptions }[];
  markReadCalls: string[];
  typingCalls: { chatId: string; kind: PresenceKind }[];
} {
  const sends: { to: string; content: Outbound; opts?: SendOptions }[] = [];
  const markReadCalls: string[] = [];
  const typingCalls: { chatId: string; kind: PresenceKind }[] = [];
  return {
    accountId: "test",
    async start() {},
    async send(to, content, opts) {
      sends.push({ to, content, opts });
      return { id: "SENT1", chatId: to, fromMe: true };
    },
    async markRead(chatId) {
      markReadCalls.push(chatId);
    },
    async setTyping(chatId, kind) {
      typingCalls.push({ chatId, kind });
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
    sends,
    markReadCalls,
    typingCalls,
  };
}

function ctx(adapter: WhatsAppChannelAdapter, chatId = "chat@s.whatsapp.net"): ToolContext {
  return { chatId, adapter };
}

// ── sendText ──

test("sendText sends { text } to the current chat", async () => {
  const a = fakeAdapter();
  const ref = await sendText.call({ text: "hello" }, ctx(a));
  expect(ref.id).toBe("SENT1");
  expect(a.sends.length).toBe(1);
  expect(a.sends[0]!.to).toBe("chat@s.whatsapp.net");
  expect((a.sends[0]!.content as { text: string }).text).toBe("hello");
});

// ── sendMedia ──

test("sendMedia sends image with caption", async () => {
  const a = fakeAdapter();
  const buf = Buffer.from("img");
  await sendMedia.call({ kind: "image", media: buf, caption: "a photo" }, ctx(a));
  expect(a.sends.length).toBe(1);
  const c = a.sends[0]!.content as { image: Buffer; caption?: string };
  expect(c.image).toBe(buf);
  expect(c.caption).toBe("a photo");
});

test("sendMedia sends audio as voice note with ptt", async () => {
  const a = fakeAdapter();
  const buf = Buffer.from("audio");
  await sendMedia.call(
    { kind: "audio", media: buf, ptt: true, seconds: 5, mimetype: "audio/ogg" },
    ctx(a),
  );
  const c = a.sends[0]!.content as {
    audio: Buffer;
    ptt?: boolean;
    seconds?: number;
    mimetype?: string;
  };
  expect(c.audio).toBe(buf);
  expect(c.ptt).toBe(true);
  expect(c.seconds).toBe(5);
  expect(c.mimetype).toBe("audio/ogg");
});

test("sendMedia sends document with fileName + mimetype", async () => {
  const a = fakeAdapter();
  const buf = Buffer.from("doc");
  await sendMedia.call(
    { kind: "document", media: buf, fileName: "report.pdf", mimetype: "application/pdf" },
    ctx(a),
  );
  const c = a.sends[0]!.content as { document: Buffer; fileName: string; mimetype: string };
  expect(c.document).toBe(buf);
  expect(c.fileName).toBe("report.pdf");
  expect(c.mimetype).toBe("application/pdf");
});

test("sendMedia sends video with gifPlayback", async () => {
  const a = fakeAdapter();
  const buf = Buffer.from("vid");
  await sendMedia.call({ kind: "video", media: buf, gifPlayback: true }, ctx(a));
  const c = a.sends[0]!.content as { video: Buffer; gifPlayback?: boolean };
  expect(c.video).toBe(buf);
  expect(c.gifPlayback).toBe(true);
});

test("sendMedia sends sticker", async () => {
  const a = fakeAdapter();
  const buf = Buffer.from("stk");
  await sendMedia.call({ kind: "sticker", media: buf }, ctx(a));
  const c = a.sends[0]!.content as { sticker: Buffer };
  expect(c.sticker).toBe(buf);
});

// ── reply ──

test("reply sends text with quote in SendOptions", async () => {
  const a = fakeAdapter();
  await reply.call({ text: "replying!", quote: REF }, ctx(a));
  expect(a.sends.length).toBe(1);
  expect((a.sends[0]!.content as { text: string }).text).toBe("replying!");
  expect(a.sends[0]!.opts!.quote).toBe(REF);
});

// ── markRead ──

test("markRead calls adapter.markRead with chatId", async () => {
  const a = fakeAdapter();
  await markRead.call(undefined, ctx(a));
  expect(a.markReadCalls.length).toBe(1);
  expect(a.markReadCalls[0]).toBe("chat@s.whatsapp.net");
});

// ── setTyping ──

test("setTyping defaults to 'typing'", async () => {
  const a = fakeAdapter();
  await setTyping.call({}, ctx(a));
  expect(a.typingCalls.length).toBe(1);
  expect(a.typingCalls[0]!.kind).toBe("typing");
});

test("setTyping passes 'recording' through", async () => {
  const a = fakeAdapter();
  await setTyping.call({ kind: "recording" }, ctx(a));
  expect(a.typingCalls[0]!.kind).toBe("recording");
});

// ── react ──

test("react sends { react: { to, emoji } }", async () => {
  const a = fakeAdapter();
  await react.call({ emoji: "👍", ref: REF2 }, ctx(a));
  const c = a.sends[0]!.content as { react: { to: MessageRef; emoji: string } };
  expect(c.react.to).toBe(REF2);
  expect(c.react.emoji).toBe("👍");
});

test("react with empty emoji clears the reaction", async () => {
  const a = fakeAdapter();
  await react.call({ emoji: "", ref: REF2 }, ctx(a));
  const c = a.sends[0]!.content as { react: { to: MessageRef; emoji: string } };
  expect(c.react.emoji).toBe("");
});

// ── edit ──

test("edit sends { edit: { target, text } }", async () => {
  const a = fakeAdapter();
  await edit.call({ text: "corrected text", ref: REF }, ctx(a));
  const c = a.sends[0]!.content as { edit: { target: MessageRef; text: string } };
  expect(c.edit.target).toBe(REF);
  expect(c.edit.text).toBe("corrected text");
});

// ── deleteMsg ──

test("deleteMsg sends { delete: ref }", async () => {
  const a = fakeAdapter();
  await deleteMsg.call({ ref: REF }, ctx(a));
  const c = a.sends[0]!.content as { delete: MessageRef };
  expect(c.delete).toBe(REF);
});

// ── registry ──

test("allTools has exactly 8 tools", () => {
  expect(allTools.length).toBe(8);
});

test("allTools names are unique and prefixed whatsapp.", () => {
  const names = allTools.map((t) => t.name);
  expect(names.length).toBe(8);
  for (const n of names) {
    expect(n.startsWith("whatsapp.")).toBe(true);
  }
  const unique = new Set(names);
  expect(unique.size).toBe(8);
});

test("bindTools returns the same 8 tools", () => {
  const a = fakeAdapter();
  const tools = bindTools(ctx(a));
  expect(tools.length).toBe(8);
  expect(tools[0]!.name).toBe("whatsapp.sendText");
  expect(tools[7]!.name).toBe("whatsapp.delete");
});

test("every tool has a name and description", () => {
  for (const t of allTools) {
    expect(t.name.length > 0).toBe(true);
    expect(t.description.length > 0).toBe(true);
    expect(typeof t.call).toBe("function");
  }
});
