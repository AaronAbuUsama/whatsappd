import { expect, test } from "./_expect.ts";
import type { InboundMessage } from "../packages/whatsappd/src/model/index.ts";
import { replyToProofPing } from "./proof-handler.ts";

const message = (text: string, live = true): InboundMessage =>
  ({
    id: text,
    chatId: "1555@s.whatsapp.net",
    sender: { id: "1555@s.whatsapp.net", mode: "pn" },
    fromMe: true,
    timestamp: 1,
    live,
    isGroup: false,
    kind: "text",
    text,
  }) as InboundMessage;

test("proof sends one pong for a live self ping without looping on pong or history", async () => {
  const sent: [string, string][] = [];
  const send = async (chatId: string, text: "pong") => {
    sent.push([chatId, text]);
  };

  for (const candidate of [message("ping"), message("pong"), message("ping", false)]) {
    await replyToProofPing(candidate, send);
  }

  expect(sent).toEqual([["1555@s.whatsapp.net", "pong"]]);
});
