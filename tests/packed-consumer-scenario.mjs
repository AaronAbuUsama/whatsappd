import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWhatsAppClient, fileMediaStore, libsqlBackend } from "whatsappd";
import {
  createTestWhatsAppRuntime as createWhatsAppRuntime,
  createTestWhatsAppSession,
  textMessage,
} from "whatsappd/testing";

const ACCOUNT = "packed-consumer";
const CHAT = "consumer-peer@s.whatsapp.net";
const ROOM = "consumer-room@g.us";
const AT = 1_700_000_000_000;
const MEDIA_BYTES = Uint8Array.from([11, 22, 33, 44, 55]);

const directory = process.env.PACKED_SCENARIO_DIRECTORY;
const mode = process.env.PACKED_SCENARIO_MODE;
const salt = process.env.PACKED_SCENARIO_SALT;
assert.ok(directory, "PACKED_SCENARIO_DIRECTORY is required");
assert.ok(mode === "write" || mode === "read", "PACKED_SCENARIO_MODE must be write or read");
assert.ok(salt, "PACKED_SCENARIO_SALT is required");
await mkdir(directory, { recursive: true });

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => [key, canonical(member)]),
  );
};
const stableDigest = (value) => sha256(`${salt}\0${JSON.stringify(canonical(value))}`);
const media = fileMediaStore({ directory: path.join(directory, "media") });
const backend = libsqlBackend({
  url: pathToFileURL(path.join(directory, "whatsapp.db")).href,
  accountId: ACCOUNT,
  media,
});
const driver = createTestWhatsAppSession({
  identity: { jid: "packed-consumer:1@s.whatsapp.net" },
});
const runtime = createWhatsAppRuntime({
  accountId: ACCOUNT,
  backend,
  openSession: () => driver.session,
});

const waitForPage = async (client) => {
  client.messages.get(CHAT);
  client.messages.older(CHAT);
  for (let turn = 0; turn < 100; turn += 1) {
    const page = client.messages.get(CHAT);
    if (page.older !== "loading" && page.messages.length > 0) return page;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the packed Client did not page the durable chat");
};

const durableReceipt = async (client) => {
  const account = client.account.get();
  const page = await waitForPage(client);
  const mediaDigests = [];
  for (const message of page.messages) {
    if (message.kind !== "document" || message.media.state !== "stored") continue;
    const bytes = await media.read({ accountId: ACCOUNT, ref: message.media.ref });
    assert.ok(bytes, "the packed Client surfaced an unreadable media ref");
    mediaDigests.push(sha256(bytes));
  }
  assert.deepEqual(mediaDigests, [sha256(MEDIA_BYTES)]);
  const durableState = {
    account: {
      accountId: account.accountId,
      lastConnectedAt: account.lastConnectedAt,
      lastDisconnectedAt: account.lastDisconnectedAt,
    },
    chats: client.chats.list(),
    contacts: client.contacts.list(),
    groups: client.groups.list(),
    messages: page.messages,
    mediaDigests,
  };
  return {
    digest: stableDigest(durableState),
    digests: Object.fromEntries(
      Object.entries(durableState).map(([key, value]) => [key, stableDigest(value)]),
    ),
    pageMessageCount: page.messages.length,
    mediaDigests,
  };
};

let client;
let result;
let liveState = {
  connectionPresent: false,
  identityPresent: false,
  presenceObserved: false,
};
const closeOrder = [];
try {
  if (mode === "write") {
    await runtime.start();
    client = await createWhatsAppClient(runtime);
    await driver.emit({ type: "connection", status: { phase: "online" } });
    await driver.emit({
      type: "presence",
      presence: { chatId: CHAT, kind: "typing", at: AT },
    });
    await driver.emit({
      type: "contact",
      contact: { id: CHAT, nativeIds: [CHAT], displayName: "Packed consumer" },
    });
    await driver.emit({
      type: "group",
      group: {
        kind: "metadata",
        id: ROOM,
        subject: "Packed room",
        participants: [{ id: CHAT }],
        at: AT,
      },
    });
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "packed-text",
        chatId: CHAT,
        text: "durable",
        timestamp: AT + 1,
      }),
    });
    await driver.emit({
      type: "message",
      message: {
        id: "packed-document",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 2,
        live: true,
        isGroup: false,
        kind: "document",
        media: {
          mimetype: "application/octet-stream",
          fileName: "packed.bin",
          fileLength: MEDIA_BYTES.byteLength,
          download: async () => Buffer.from(MEDIA_BYTES),
        },
      },
    });
    const liveAccount = client.account.get();
    liveState = {
      connectionPresent: liveAccount.connection !== undefined,
      identityPresent: liveAccount.identity !== undefined,
      presenceObserved: client.contacts.presence(CHAT) !== undefined,
    };
    assert.equal(liveState.connectionPresent, true);
    assert.equal(liveState.identityPresent, true);
    assert.equal(liveState.presenceObserved, true);
    await driver.emit({ type: "connection", status: { phase: "disconnected" } });
    // Exercise the awaited live Client before application-owned teardown, then
    // take the digest from a cold Client after Runtime closure has committed its
    // final durable observed instant.
    await durableReceipt(client);
    await client.close();
    client = undefined;
    await runtime.stop();
    client = await createWhatsAppClient(runtime);
  } else {
    // The replacement deliberately never starts its Runtime. Factory resolution
    // must reconstruct only durable state, before a session can attach.
    client = await createWhatsAppClient(runtime);
  }

  const durable = await durableReceipt(client);
  const account = client.account.get();
  const presenceRestored = client.contacts.presence(CHAT) !== undefined;
  if (mode === "read") {
    assert.equal(account.connection, undefined);
    assert.equal(account.identity, undefined);
    assert.equal(presenceRestored, false);
  }
  result = {
    pid: process.pid,
    mode,
    durableDigest: durable.digest,
    durableDigests: durable.digests,
    accountDurable: {
      accountId: account.accountId,
      lastConnectedAt: account.lastConnectedAt,
      lastDisconnectedAt: account.lastDisconnectedAt,
    },
    pageMessageCount: durable.pageMessageCount,
    mediaDigest: durable.mediaDigests[0],
    connectionPresent: account.connection !== undefined,
    identityPresent: account.identity !== undefined,
    presenceRestored,
    liveConnectionPresent: liveState.connectionPresent,
    liveIdentityPresent: liveState.identityPresent,
    livePresenceObserved: liveState.presenceObserved,
    envKeys: Object.keys(process.env).sort(),
  };
} finally {
  if (client) {
    await client.close();
    closeOrder.push("client");
  }
  await runtime.stop();
  closeOrder.push("runtime");
  await backend.close();
  closeOrder.push("backend");
}
assert.ok(result, "packed scenario completed without a result");
process.stdout.write(JSON.stringify({ ...result, closeOrder }));
