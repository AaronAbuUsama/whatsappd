import assert from "node:assert/strict";
import test from "node:test";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";

const CHAT = "peer@s.whatsapp.net";
const ROOM = "room@g.us";

void test("historical and live receipts reach the application through the public Client", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "web-receipts",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "web-receipts",
    client,
    media: backend.media,
  });
  const ref = { id: "historical-outgoing", chatId: CHAT, fromMe: true } as const;
  try {
    await driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "recent", projection: { mode: "upsert" } },
        chats: [{ id: CHAT, isGroup: false }],
        contacts: [],
        messages: [
          textMessage({
            ...ref,
            sender: "account@s.whatsapp.net",
            text: "historical outgoing",
            live: false,
          }),
        ],
        updates: [{ kind: "receipt", ref, status: "pending" }],
      },
    });
    const chat = (await application.state()).chats[0]?.key;
    assert.ok(chat);
    const receipt = async () => (await application.state(chat)).conversation?.messages[0]?.receipt;
    assert.deepEqual(await receipt(), { status: "pending", participants: [] });

    for (const status of ["server_ack", "delivered", "read", "played", "error"] as const) {
      await driver.emit({ type: "update", update: { kind: "receipt", ref, status } });
      assert.deepEqual(await receipt(), { status, participants: [] });
    }

    const groupRef = {
      id: "group-outgoing",
      chatId: ROOM,
      fromMe: true,
      participant: "account@s.whatsapp.net",
    } as const;
    await driver.emit({
      type: "message",
      message: textMessage({
        id: groupRef.id,
        chatId: ROOM,
        sender: groupRef.participant,
        fromMe: true,
        text: "group outgoing",
      }),
    });
    const groupChat = (await application.state()).chats.find((value) => value.isGroup)?.key;
    assert.ok(groupChat);
    await application.state(groupChat);
    await driver.emit({
      type: "update",
      update: { kind: "receipt", ref: groupRef, status: "read", by: "reader@lid" },
    });
    await driver.emit({
      type: "update",
      update: { kind: "receipt", ref: groupRef, status: "delivered", by: "delivered@lid" },
    });
    assert.deepEqual((await application.state(groupChat)).conversation?.messages[0]?.receipt, {
      participants: [
        { status: "delivered", count: 1 },
        { status: "read", count: 1 },
      ],
    });
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("every durable operation state reaches the application and terminal states survive replacement", async () => {
  const accountId = "web-operation-states";
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({ accountId, backend, openSession: () => driver.session });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({ accountId, client, media: backend.media });
  await driver.emit({
    type: "message",
    message: textMessage({ id: "operation-chat", chatId: CHAT, text: "retain chat" }),
  });
  const chat = (await application.state()).chats[0]?.key;
  assert.ok(chat);
  await application.state(chat);
  await runtime.stop();

  const submit = (label: string) =>
    client.messages.send.text(CHAT, label, { idempotencyKey: `web-${label}` });
  const transition = async (label: string, terminal?: "succeeded" | "failed" | "unknown") => {
    const operation = await submit(label);
    const attempt = `attempt-${label}`;
    assert.equal((await backend.operations.claim(accountId, attempt, 60_000))?.id, operation.id);
    if (!terminal && label === "claimed") return;
    if (terminal === "failed") {
      await backend.operations.fail(accountId, operation.id, attempt, {
        name: "FixtureError",
        message: "fixture failure",
        code: "FIXTURE",
      });
      return;
    }
    assert.equal(
      (await backend.operations.start(accountId, operation.id, attempt, 60_000))?.id,
      operation.id,
    );
    if (terminal === "succeeded")
      await backend.operations.succeed(accountId, operation.id, attempt, {
        id: "fixture-result",
        chatId: CHAT,
        fromMe: true,
      });
    else if (terminal === "unknown")
      await backend.operations.unknown(accountId, operation.id, attempt, "fixture uncertainty");
  };

  try {
    await transition("claimed");
    await transition("executing");
    await transition("succeeded", "succeeded");
    await transition("failed", "failed");
    await transition("unknown", "unknown");
    await submit("queued");
    const statuses = (await application.state(chat)).conversation?.messages
      .flatMap((message) => (message.operation ? [message.operation.status] : []))
      .sort();
    assert.deepEqual(statuses, [
      "claimed",
      "executing",
      "failed",
      "outcome_unknown",
      "queued",
      "succeeded",
    ]);

    await application.close();
    await client.close();
    const replacementRuntime = createWhatsAppRuntime({
      accountId,
      backend,
      openSession: () => createTestWhatsAppSession().session,
    });
    const replacementClient = await createWhatsAppClient(replacementRuntime);
    const replacement = createWhatsAppApplication({
      accountId,
      client: replacementClient,
      media: backend.media,
    });
    try {
      const replacementChat = (await replacement.state()).chats[0]?.key;
      assert.ok(replacementChat);
      const terminal = (await replacement.state(replacementChat)).conversation?.messages
        .flatMap((message) =>
          message.operation &&
          ["succeeded", "failed", "outcome_unknown"].includes(message.operation.status)
            ? [message.operation.status]
            : [],
        )
        .sort();
      assert.deepEqual(terminal, ["failed", "outcome_unknown", "succeeded"]);
    } finally {
      await replacement.close();
      await replacementClient.close();
      await replacementRuntime.stop();
    }
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("group counts preserve unknown and authoritative empty membership", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "group-knowledge",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "group-knowledge",
    client,
    media: backend.media,
  });

  try {
    await driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "recent", projection: { mode: "upsert" } },
        chats: [{ id: ROOM, isGroup: true, subject: "Room" }],
        contacts: [],
        messages: [],
      },
    });
    const unknown = await application.state();
    assert.equal(unknown.groups.length, 1);
    assert.equal(unknown.groups[0]?.participantCount, undefined);

    await driver.emit({
      type: "group",
      group: { kind: "metadata", id: ROOM, participants: [], at: 1_700_000_000_000 },
    });
    const empty = await application.state();
    assert.equal(empty.groups.length, 1);
    assert.equal(empty.groups[0]?.participantCount, 0);
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});
