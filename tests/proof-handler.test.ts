import { expect, test } from "./_expect.ts";
import type { InboundMessage } from "../src/model/index.ts";
import { proofReply } from "./proof-handler.ts";

const message = (text: string, live = true): InboundMessage =>
  ({
    id: text,
    chatId: "1555@s.whatsapp.net",
    from: "1555@s.whatsapp.net",
    fromMe: true,
    timestamp: 1,
    live,
    isGroup: false,
    kind: "text",
    text,
  }) as InboundMessage;

test("proof replies once to a live self ping without looping on pong or history", () => {
  expect([message("ping"), message("pong"), message("ping", false)].map(proofReply)).toEqual([
    "pong",
    undefined,
    undefined,
  ]);
});
