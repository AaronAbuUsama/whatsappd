import assert from "node:assert/strict";
import test from "node:test";
import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  memoryBackend,
  type MediaStore,
} from "whatsappd";
import { createTestWhatsAppSession } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";

const CHAT = "peer@s.whatsapp.net";

void test("a stored record whose media object is missing stays distinct from download failure", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "missing-web-media",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const missingMedia: MediaStore = {
    write: (input) => backend.media.write(input),
    open: async () => null,
  };
  const application = createWhatsAppApplication({
    accountId: "missing-web-media",
    client,
    media: missingMedia,
  });
  try {
    await driver.emit({
      type: "message",
      message: {
        id: "stored-but-missing",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: 1_700_000_000_000,
        live: true,
        isGroup: false,
        kind: "image",
        media: {
          mimetype: "image/png",
          download: async () => Buffer.from("stored-before-loss"),
        },
      },
    });
    const chat = (await application.state()).chats[0]?.key;
    assert.ok(chat);
    const content = (await application.state(chat)).conversation?.messages[0]?.content;
    assert.ok(content?.kind === "image");
    assert.equal(content.state, "stored");
    assert.ok(content.media);
    assert.equal(await application.media(content.media), undefined);
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});
