import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  memoryBackend,
  type BinaryInput,
  type InboundMessage,
  type Outbound,
} from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { createWhatsAppApplication } from "../src/lib/whatsapp-application.ts";

const CHAT = "peer@s.whatsapp.net";
const PEER_LID = "peer@lid";

async function waitForLength(values: readonly unknown[], length: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && values.length < length; attempt += 1) await delay(10);
  assert.equal(values.length, length);
}

async function binary(value: BinaryInput): Promise<string> {
  if (Buffer.isBuffer(value)) return value.toString();
  if ("url" in value) return value.url;
  const chunks: Uint8Array[] = [];
  for await (const chunk of value.stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function contentOf(content: Outbound): Promise<unknown> {
  if ("image" in content)
    return {
      image: await binary(content.image),
      ...(content.caption && { caption: content.caption }),
    };
  if ("video" in content)
    return {
      video: await binary(content.video),
      ...(content.caption && { caption: content.caption }),
      ...(content.gifPlayback !== undefined && { gifPlayback: content.gifPlayback }),
    };
  if ("audio" in content)
    return {
      audio: await binary(content.audio),
      ...(content.ptt !== undefined && { ptt: content.ptt }),
      ...(content.seconds !== undefined && { seconds: content.seconds }),
      ...(content.mimetype && { mimetype: content.mimetype }),
    };
  if ("document" in content)
    return {
      document: await binary(content.document),
      fileName: content.fileName,
      mimetype: content.mimetype,
      ...(content.caption && { caption: content.caption }),
    };
  if ("sticker" in content) return { sticker: await binary(content.sticker) };
  return content;
}

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
    resolveAvatar: async (nativeId) =>
      nativeId === CHAT ? "https://example.test/avatar.jpg" : undefined,
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
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "status-1",
        chatId: "status@broadcast",
        sender: CHAT,
        text: "saved status",
        timestamp: 1_700_000_001_000,
      }),
    });

    const initial = await application.state();
    assert.equal(initial.account.connection?.phase, "online");
    assert.equal(initial.chats.length, 1);
    assert.equal(initial.chats[0]?.name, "peer");
    assert.equal(initial.chats[0]?.preview, "hello from the peer");
    assert.equal(initial.updates.length, 1);
    assert.equal(initial.updates[0]?.content.kind, "text");
    assert.equal(initial.updates[0]?.content.text, "saved status");
    assert.ok(initial.chats[0]?.avatar);
    assert.equal(
      await application.avatar(initial.chats[0].avatar),
      "https://example.test/avatar.jpg",
    );

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
    await waitForLength(driver.commands.sent, 1);
    assert.deepEqual(driver.commands.sent[0]?.content, { text: "hello back" });
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});

void test("the web media capability survives restart for every attachment kind", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-web-media-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const accountId = "web-media";
  const attachment = (
    kind: "image" | "video" | "audio" | "document" | "sticker",
    id: string,
    value: string,
  ): InboundMessage => ({
    id,
    chatId: CHAT,
    sender: { id: CHAT, mode: "pn" },
    fromMe: false,
    timestamp: 1_700_000_000_000,
    live: true,
    isGroup: false,
    kind,
    media: {
      mimetype: kind === "audio" ? "audio/ogg; codecs=opus" : `application/x-${kind}`,
      fileName: `${kind}.proof`,
      ...(kind === "audio" && { ptt: true, seconds: 3 }),
      download: async () => Buffer.from(value),
    },
  });
  try {
    const firstMedia = fileMediaStore({ directory });
    const firstBackend = libsqlBackend({ url, accountId, media: firstMedia });
    const firstDriver = createTestWhatsAppSession();
    const firstRuntime = createWhatsAppRuntime({
      accountId,
      backend: firstBackend,
      openSession: () => firstDriver.session,
    });
    await firstRuntime.start();
    for (const [kind, value] of [
      ["image", "image-bytes"],
      ["video", "video-bytes"],
      ["audio", "voice-bytes"],
      ["document", "document-bytes"],
      ["sticker", "sticker-bytes"],
    ] as const)
      await firstDriver.emit({ type: "message", message: attachment(kind, kind, value) });
    await firstDriver.emit({
      type: "message",
      message: {
        id: "failed",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: 1_700_000_000_000,
        live: true,
        isGroup: false,
        kind: "image",
        media: {
          mimetype: "image/png",
          download: async () => {
            throw new Error("fixture download failed");
          },
        },
      },
    });
    await firstRuntime.stop();
    await firstBackend.close();

    const replacementMedia = fileMediaStore({ directory });
    const replacementBackend = libsqlBackend({ url, accountId, media: replacementMedia });
    const replacementRuntime = createWhatsAppRuntime({
      accountId,
      backend: replacementBackend,
      openSession: () => createTestWhatsAppSession().session,
    });
    const client = await createWhatsAppClient(replacementRuntime);
    const application = createWhatsAppApplication({
      accountId,
      client,
      media: replacementMedia,
    });
    try {
      const chat = (await application.state()).chats[0]?.key;
      assert.ok(chat);
      const messages = (await application.state(chat)).conversation?.messages ?? [];
      const failed = messages.find(
        (message) =>
          message.key && message.content.kind === "image" && message.content.state === "failed",
      );
      assert.ok(failed);
      assert.ok(failed.content.kind === "image" && failed.content.state === "failed");
      assert.equal("media" in failed.content, false);
      assert.equal(failed.content.failure, "download_failed");
      const expected = {
        image: {
          bytes: "image-bytes",
          mimetype: "application/x-image",
          fileName: "image.proof",
        },
        video: {
          bytes: "video-bytes",
          mimetype: "application/x-video",
          fileName: "video.proof",
        },
        audio: {
          bytes: "voice-bytes",
          mimetype: "audio/ogg; codecs=opus",
          fileName: "audio.proof",
          ptt: true,
          seconds: 3,
        },
        document: {
          bytes: "document-bytes",
          mimetype: "application/x-document",
          fileName: "document.proof",
        },
        sticker: {
          bytes: "sticker-bytes",
          mimetype: "application/x-sticker",
          fileName: "sticker.proof",
        },
      } as const;
      const recovered: Partial<Record<keyof typeof expected, string>> = {};
      for (const message of messages) {
        const content = message.content;
        if (!("media" in content) || !content.media) continue;
        const wanted = expected[content.kind];
        const target = await application.media(content.media);
        assert.ok(target);
        const chunks: Uint8Array[] = [];
        for await (const chunk of target.source) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(target.byteLength, bytes.byteLength);
        assert.equal(target.mimetype, wanted.mimetype);
        assert.equal(target.fileName, wanted.fileName);
        assert.equal(content.mimetype, wanted.mimetype);
        assert.equal(content.fileName, wanted.fileName);
        if (content.kind === "audio") {
          assert.equal(content.ptt, expected.audio.ptt);
          assert.equal(content.seconds, expected.audio.seconds);
        }
        recovered[content.kind] = bytes.toString();
      }
      assert.deepEqual(recovered, {
        image: "image-bytes",
        video: "video-bytes",
        audio: "voice-bytes",
        document: "document-bytes",
        sticker: "sticker-bytes",
      });
    } finally {
      await application.close();
      await client.close();
      await replacementBackend.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("every browser message command reaches the public Client with exact metadata", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "message-commands",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId: "message-commands",
    client,
    media: backend.media,
  });

  try {
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "incoming-command-target",
        chatId: CHAT,
        text: "incoming",
        timestamp: 1_700_000_000_000,
      }),
    });
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "outgoing-command-target",
        chatId: CHAT,
        sender: "account@s.whatsapp.net",
        fromMe: true,
        text: "outgoing",
        timestamp: 1_700_000_001_000,
      }),
    });
    const chat = (await application.state()).chats[0]?.key;
    assert.ok(chat);
    const selected = await application.state(chat);
    const incoming = selected.conversation?.messages.find((message) => !message.fromMe)?.key;
    const outgoing = selected.conversation?.messages.find((message) => message.fromMe)?.key;
    assert.ok(incoming);
    assert.ok(outgoing);

    const first = await application.command({
      type: "send_text",
      chat,
      text: "text",
      quote: incoming,
      mentions: [chat],
    });
    assert.equal(first.type, "operation");
    await application.command({
      type: "send_image",
      chat,
      source: Buffer.from("image"),
      caption: "image caption",
    });
    await application.command({
      type: "send_video",
      chat,
      source: Buffer.from("video"),
      caption: "video caption",
      gifPlayback: true,
    });
    await application.command({
      type: "send_audio",
      chat,
      source: Buffer.from("audio"),
      seconds: 3,
      mimetype: "audio/mpeg",
    });
    await application.command({
      type: "send_document",
      chat,
      source: Buffer.from("document"),
      fileName: "proof.txt",
      mimetype: "text/plain",
      caption: "document caption",
    });
    await application.command({
      type: "send_sticker",
      chat,
      source: Buffer.from("sticker"),
    });
    await application.command({
      type: "send_location",
      chat,
      location: { lat: 5.6037, lng: -0.187, name: "Accra", address: "Proof location" },
    });
    await application.command({
      type: "send_contacts",
      chat,
      contacts: { displayName: "Proof", vcards: ["BEGIN:VCARD\nEND:VCARD"] },
    });
    await waitForLength(driver.commands.sent, 8);

    assert.deepEqual(
      await Promise.all(driver.commands.sent.map(({ content }) => contentOf(content))),
      [
        { text: "text" },
        { image: "image", caption: "image caption" },
        { video: "video", caption: "video caption", gifPlayback: true },
        { audio: "audio", seconds: 3, mimetype: "audio/mpeg" },
        {
          document: "document",
          fileName: "proof.txt",
          mimetype: "text/plain",
          caption: "document caption",
        },
        { sticker: "sticker" },
        { location: { lat: 5.6037, lng: -0.187, name: "Accra", address: "Proof location" } },
        { contacts: { displayName: "Proof", vcards: ["BEGIN:VCARD\nEND:VCARD"] } },
      ],
    );
    assert.deepEqual(driver.commands.sent[0]?.options, {
      quote: {
        id: "incoming-command-target",
        chatId: CHAT,
        fromMe: false,
      },
      mentions: [CHAT],
    });

    await application.command({ type: "react", message: incoming, emoji: "👍" });
    await application.command({ type: "unreact", message: incoming });
    await application.command({ type: "edit", message: outgoing, text: "edited" });
    await application.command({ type: "revoke", message: outgoing });
    await waitForLength(driver.commands.sent, 12);
    assert.deepEqual(
      await Promise.all(driver.commands.sent.slice(8).map(({ content }) => contentOf(content))),
      [
        {
          react: {
            to: { id: "incoming-command-target", chatId: CHAT, fromMe: false },
            emoji: "👍",
          },
        },
        {
          react: {
            to: { id: "incoming-command-target", chatId: CHAT, fromMe: false },
            emoji: "",
          },
        },
        {
          edit: {
            target: { id: "outgoing-command-target", chatId: CHAT, fromMe: true },
            text: "edited",
          },
        },
        { delete: { id: "outgoing-command-target", chatId: CHAT, fromMe: true } },
      ],
    );

    await application.command({ type: "mark_read", messages: [incoming] });
    await application.command({ type: "typing", chat, on: true });
    await application.command({ type: "typing", chat, on: false });
    await application.command({ type: "request_phone_history", chat, count: 12 });
    await waitForLength(driver.commands.read, 1);
    await waitForLength(driver.commands.historyRequests, 1);
    assert.deepEqual(driver.commands.read, [
      { refs: [{ id: "incoming-command-target", chatId: CHAT, fromMe: false }] },
    ]);
    assert.deepEqual(driver.commands.typing, [
      { chatId: CHAT, on: true },
      { chatId: CHAT, on: false },
    ]);
    assert.equal(driver.commands.historyRequests[0]?.count, 12);
    if (first.type === "operation")
      await application.command({ type: "acknowledge", operation: first.key });
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
    canCreateGroupWith: (participantId) => participantId === CHAT || participantId === PEER_LID,
    onGroupCreated: (chatId) => allowed.add(chatId),
  });

  try {
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await driver.emit({
      type: "contact",
      contact: { id: PEER_LID, nativeIds: [PEER_LID, CHAT], displayName: "Proof peer" },
    });
    const peer = (await application.state()).contacts[0];
    assert.ok(peer?.canCreateGroup);
    assert.ok(peer.groupKey);
    const created = await application.command({
      type: "group_create",
      subject: "Evidence",
      participants: [peer.groupKey],
    });
    assert.equal(created.type, "group");
    if (created.type !== "group") return;
    await application.command({
      type: "group_subject",
      chat: created.key,
      subject: "Evidence renamed",
    });
    await application.command({
      type: "group_description",
      chat: created.key,
      description: "Browser group",
    });
    for (const action of ["add", "promote", "demote", "remove"] as const)
      await application.command({
        type: "group_participants",
        chat: created.key,
        participants: [peer.groupKey],
        action,
      });
    for (const setting of ["announcement", "not_announcement", "locked", "unlocked"] as const)
      await application.command({ type: "group_setting", chat: created.key, setting });
    assert.deepEqual(await application.command({ type: "group_invite", chat: created.key }), {
      type: "invite",
      code: "test-invite",
    });
    assert.deepEqual(
      await application.command({ type: "group_revoke_invite", chat: created.key }),
      { type: "invite", code: "test-invite-revoked" },
    );
    await application.command({
      type: "group_picture",
      chat: created.key,
      source: Buffer.from("picture"),
    });
    await application.command({ type: "group_remove_picture", chat: created.key });
    await application.command({ type: "group_leave", chat: created.key });
    assert.deepEqual(driver.commands.groups, [
      ["create", "Evidence", [CHAT]],
      ["subject", "test-group@g.us", "Evidence renamed"],
      ["description", "test-group@g.us", "Browser group"],
      ["participants", "test-group@g.us", [CHAT], "add"],
      ["participants", "test-group@g.us", [CHAT], "promote"],
      ["participants", "test-group@g.us", [CHAT], "demote"],
      ["participants", "test-group@g.us", [CHAT], "remove"],
      ["setting", "test-group@g.us", "announcement"],
      ["setting", "test-group@g.us", "not_announcement"],
      ["setting", "test-group@g.us", "locked"],
      ["setting", "test-group@g.us", "unlocked"],
      ["invite", "test-group@g.us"],
      ["revoke_invite", "test-group@g.us"],
      ["picture", "test-group@g.us", 7],
      ["remove_picture", "test-group@g.us"],
      ["leave", "test-group@g.us"],
    ]);
  } finally {
    await application.close();
    await client.close();
    await runtime.stop();
  }
});
