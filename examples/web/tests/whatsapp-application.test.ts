import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";

const CHAT = "peer@s.whatsapp.net";

void test("browser state and commands use the public WhatsApp Client", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession({
    identity: { jid: "account@s.whatsapp.net", pushName: "Test account" },
  });
  const runtime = createWhatsAppRuntime({
    accountId: "browser",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "browser",
    client,
    media: backend.media,
  });

  try {
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "incoming-1",
        chatId: CHAT,
        text: "hello from the peer",
        timestamp: 1_700_000_000_000,
      }),
    });

    const initial = await application.state();
    assert.equal(initial.account.connection?.phase, "online");
    assert.equal(initial.chats.length, 1);
    assert.equal(initial.chats[0]?.name, "peer");
    assert.equal(initial.chats[0]?.preview, "hello from the peer");

    const chat = initial.chats[0]?.key;
    assert.ok(chat);
    const selected = await application.state(chat);
    assert.equal(selected.conversation?.messages[0]?.content.kind, "text");
    assert.equal(selected.conversation?.messages[0]?.content.text, "hello from the peer");

    const submitted = await application.command({
      type: "send_text",
      chat,
      text: "hello back",
    });
    assert.equal(submitted.type, "operation");
    for (let attempt = 0; attempt < 50 && driver.commands.sent.length === 0; attempt += 1) {
      await delay(10);
    }
    assert.equal(driver.commands.sent.length, 1);
    assert.deepEqual(driver.commands.sent[0]?.content, { text: "hello back" });
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("group commands stay opaque and only accept the configured proof peer", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "groups",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const allowed = new Set<string>();
  const application = createWhatsAppApplication({
    accountId: "groups",
    client,
    media: backend.media,
    canSend: (chatId) => allowed.has(chatId),
    canCreateGroupWith: (participantId) => participantId === CHAT,
    onGroupCreated: (chatId) => allowed.add(chatId),
  });

  try {
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await driver.emit({
      type: "contact",
      contact: { id: CHAT, nativeIds: [CHAT], displayName: "Proof peer" },
    });
    const peer = (await application.state()).contacts[0];
    assert.ok(peer?.canCreateGroup);
    const created = await application.command({
      type: "group_create",
      subject: "Evidence",
      participants: [peer.key],
    });
    assert.equal(created.type, "group");
    if (created.type !== "group") return;
    await application.command({
      type: "group_subject",
      chat: created.key,
      subject: "Evidence renamed",
    });
    assert.deepEqual(driver.commands.groups.slice(0, 2), [
      ["create", "Evidence", [CHAT]],
      ["subject", "test-group@g.us", "Evidence renamed"],
    ]);
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});
