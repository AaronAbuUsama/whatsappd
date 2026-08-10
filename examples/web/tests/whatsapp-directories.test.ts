import assert from "node:assert/strict";
import test from "node:test";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";

const ACCOUNT = "account@s.whatsapp.net";
const PEER = "peer@s.whatsapp.net";
const PEER_LID = "peer@lid";
const ROOM = "common@g.us";

void test("chat summaries expose truthful preview direction and aggregate receipt", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession({
    identity: { jid: ACCOUNT, pushName: "Test account" },
  });
  const runtime = createWhatsAppRuntime({
    accountId: "chat-directory",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "chat-directory",
    client,
    media: backend.media,
  });

  try {
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "latest-own-message",
        chatId: PEER,
        sender: ACCOUNT,
        fromMe: true,
        text: "Latest preview",
        timestamp: 1_700_000_000_000,
      }),
    });
    await driver.emit({
      type: "update",
      update: {
        kind: "receipt",
        ref: { id: "latest-own-message", chatId: PEER, fromMe: true },
        status: "delivered",
      },
    });

    assert.deepEqual((await application.state()).chats[0], {
      key: (await application.state()).chats[0]?.key,
      name: "peer",
      initials: "P",
      isGroup: false,
      lastMessageAt: 1_700_000_000_000,
      preview: "Latest preview",
      previewFromMe: true,
      previewReceipt: "delivered",
      canSend: true,
    });
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("WC-10 WC-11 WC-23 WC-24 directories preserve identity and membership truth", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "directories",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "directories",
    client,
    media: backend.media,
    canSend: () => true,
  });

  try {
    await driver.emit({
      type: "contact",
      contact: {
        id: PEER_LID,
        nativeIds: [PEER_LID, PEER],
        displayName: "Display",
        profileName: "Profile",
        verifiedName: "Verified",
        username: "handle",
        status: "Available",
      },
    });
    await driver.emit({
      type: "contact",
      contact: {
        id: "alpha@s.whatsapp.net",
        nativeIds: ["alpha@s.whatsapp.net"],
        displayName: "Alpha",
      },
    });
    await driver.emit({
      type: "contact",
      contact: { id: ROOM, nativeIds: [ROOM], displayName: "Not a contact" },
    });
    await driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "recent", projection: { mode: "upsert" } },
        chats: [{ id: "unknown@g.us", isGroup: true, subject: "Unknown" }],
        contacts: [],
        messages: [],
      },
    });
    await driver.emit({
      type: "group",
      group: {
        kind: "metadata",
        id: ROOM,
        subject: "Common",
        participants: [{ id: PEER_LID, role: "admin" }],
        at: 1_700_000_000_000,
      },
    });
    await driver.emit({
      type: "group",
      group: {
        kind: "metadata",
        id: "empty@g.us",
        subject: "Empty",
        participants: [],
        at: 1_700_000_000_001,
      },
    });

    const view = await application.state();
    assert.deepEqual(
      view.contacts.map(({ name }) => name),
      ["Alpha", "Display"],
    );
    const display = view.contacts[1];
    assert.deepEqual(display?.names, [
      { label: "Display name", value: "Display" },
      { label: "Profile name", value: "Profile" },
      { label: "Verified name", value: "Verified" },
      { label: "Username", value: "handle" },
    ]);
    assert.equal(display?.about, "Available");
    assert.deepEqual(
      display?.commonGroups?.map(({ name }) => name),
      ["Common"],
    );
    assert.deepEqual(
      view.groups.map(({ name, participantCount }) => ({ name, participantCount })),
      [
        { name: "Common", participantCount: 1 },
        { name: "Empty", participantCount: 0 },
        { name: "Unknown", participantCount: undefined },
      ],
    );

    const common = view.groups.find(({ name }) => name === "Common");
    assert.ok(common);
    assert.deepEqual((await application.state(common.key)).conversation?.participants, [
      { key: display?.key, name: "Display", role: "admin" },
    ]);
    await driver.emit({
      type: "group",
      group: {
        kind: "participants",
        id: ROOM,
        action: "add",
        participants: [{ id: "alpha@s.whatsapp.net" }],
        at: 1_700_000_000_002,
      },
    });
    assert.deepEqual(
      (await application.state(common.key)).conversation?.participants?.map(({ name, role }) => ({
        name,
        role,
      })),
      [
        { name: "Display", role: "admin" },
        { name: "Alpha", role: undefined },
      ],
    );
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("durable-send availability distinguishes authorization from terminal account state", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "send-availability",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "send-availability",
    client,
    media: backend.media,
    canSend: () => true,
  });

  try {
    await driver.emit({
      type: "message",
      message: textMessage({ id: "chat", chatId: PEER, text: "hello" }),
    });
    await driver.emit({ type: "connection", status: { phase: "online" } });
    const online = (await application.state()).chats[0];
    assert.equal(online?.canSend, true);
    assert.equal(online?.sendDisabledReason, undefined);

    await driver.emit({
      type: "connection",
      status: { phase: "logged_out", reason: "logged_out_remote" },
    });
    const loggedOut = (await application.state()).chats[0];
    assert.equal(loggedOut?.canSend, false);
    assert.equal(loggedOut?.sendDisabledReason, "Account is logged out: logged_out_remote");
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});
