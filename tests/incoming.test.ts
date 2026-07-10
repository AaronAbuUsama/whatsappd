import { expect, test } from "./_expect.ts";
import { incoming } from "../src/incoming.ts";
import { refOf } from "../src/model/outbound.ts";
import type { InboundMessage } from "../src/model/message.ts";
import type { MessageRef, Outbound, SendOptions } from "../src/model/outbound.ts";

function textMsg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "M1",
    chatId: "chat@s.whatsapp.net",
    from: "sender@s.whatsapp.net",
    fromMe: false,
    timestamp: 100,
    live: true,
    isGroup: false,
    kind: "text",
    text: "hi",
    ...over,
  } as InboundMessage;
}

function recorder(): {
  calls: { to: string; msg: Outbound; opts?: SendOptions }[];
  send: (to: string, msg: Outbound, opts?: SendOptions) => Promise<MessageRef>;
} {
  const calls: { to: string; msg: Outbound; opts?: SendOptions }[] = [];
  return {
    calls,
    send: async (to, msg, opts) => {
      calls.push({ to, msg, opts });
      return { id: "OUT", chatId: to, fromMe: true };
    },
  };
}

test("reply: a string is sent as text to the message's chat, quoting it", async () => {
  const { calls, send } = recorder();
  const m = textMsg();

  await incoming(m, send).reply("pong");

  expect(calls.length).toBe(1);
  expect(calls[0]!.to).toBe(m.chatId);
  expect(calls[0]!.msg).toEqual({ text: "pong" });
  expect(calls[0]!.opts!.quote).toEqual(refOf(m));
});

test("reply: a non-string Outbound is passed through unchanged", async () => {
  const { calls, send } = recorder();
  const m = textMsg();
  const img: Outbound = { image: Buffer.from("x"), caption: "hey" };

  await incoming(m, send).reply(img);

  expect(calls[0]!.msg).toBe(img);
  expect(calls[0]!.opts!.quote).toEqual(refOf(m));
});

test("reply: caller opts merge in, and an explicit quote overrides the default", async () => {
  const { calls, send } = recorder();
  const m = textMsg();
  const otherQuote: MessageRef = { id: "OTHER", chatId: "elsewhere@s.whatsapp.net", fromMe: false };

  await incoming(m, send).reply("hi", { mentions: ["a@s.whatsapp.net"], quote: otherQuote });

  expect(calls[0]!.opts!.mentions).toEqual(["a@s.whatsapp.net"]);
  expect(calls[0]!.opts!.quote).toEqual(otherQuote);
});

test("incoming: preserves the original message fields", () => {
  const m = textMsg({ text: "keepme" } as Partial<InboundMessage>);
  const inc = incoming(m, recorder().send);

  expect(inc.kind).toBe("text");
  if (inc.kind === "text") expect(inc.text).toBe("keepme");
  expect(inc.chatId).toBe(m.chatId);
  expect(inc.from).toBe(m.from);
});
