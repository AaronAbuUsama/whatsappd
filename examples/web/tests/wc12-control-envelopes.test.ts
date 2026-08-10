import assert from "node:assert/strict";
import test from "node:test";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "whatsappd";
import { createTestWhatsAppSession } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";

const CHAT = "peer@s.whatsapp.net";

void test("WC-12 poll controls update their target while unknown content stays explicit", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "control-envelopes",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "control-envelopes",
    client,
    media: backend.media,
  });

  try {
    await driver.emit({
      type: "message",
      message: {
        id: "poll-target",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: 1_700_000_000_000,
        live: true,
        isGroup: false,
        kind: "poll",
        name: "Lunch?",
        options: ["Waakye", "Jollof"],
        selectableCount: 1,
      },
    });
    await driver.emit({
      type: "update",
      update: {
        kind: "poll_votes",
        ref: { id: "poll-target", chatId: CHAT, fromMe: false },
        votes: [
          {
            by: CHAT,
            selectedOptionIds: ["d18003aabfd6c7e9c5cba811355a4a6061237d3463652a59cf12af00b656c027"],
          },
        ],
      },
    });
    await driver.emit({
      type: "message",
      message: {
        id: "unknown-content",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: 1_700_000_001_000,
        live: true,
        isGroup: false,
        kind: "unsupported",
        rawType: "inventedFutureEnvelope",
      },
    });

    const chat = (await application.state()).chats[0]?.key;
    assert.ok(chat);
    const messages = (await application.state(chat)).conversation?.messages ?? [];
    assert.equal(messages.length, 2);
    const poll = messages.find(({ content }) => content.kind === "poll")?.content;
    assert.ok(poll?.kind === "poll");
    assert.deepEqual(poll.votes, [
      { option: "Waakye", voters: 1 },
      { option: "Jollof", voters: 0 },
    ]);
    assert.deepEqual(messages.find(({ content }) => content.kind === "unsupported")?.content, {
      kind: "unsupported",
      rawType: "inventedFutureEnvelope",
    });
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});
