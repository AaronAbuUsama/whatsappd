import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./_expect.ts";
import {
  fileMediaStore,
  libsqlBackend,
  memoryMediaStore,
  AccountAlreadyClaimedError,
  StaleAccountClaimError,
} from "../src/index.ts";
import type { RuntimeFrameClient, CurrentMirrorSnapshot } from "../src/runtime/contracts.ts";
import {
  createRuntimeFrameClient,
  createWhatsAppRuntime as createPublicWhatsAppRuntime,
  type InProcessWhatsAppRuntime,
} from "../src/runtime/runtime.ts";
import type { InboundMessage, MediaHandle } from "../src/model/message.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";
import { dataStoreConformance } from "./data-store-conformance.ts";

const ACCOUNT = "personal";
const CHAT = "person@s.whatsapp.net";
const ROOM = "room@g.us";
const AT = 1_700_000_000_000;

/** Reach the source-only raw Runtime seam in tests without widening the package root. */
const createWhatsAppRuntime = (
  config: Parameters<typeof createPublicWhatsAppRuntime>[0],
): InProcessWhatsAppRuntime => createPublicWhatsAppRuntime(config) as InProcessWhatsAppRuntime;

dataStoreConformance("memory data", async () => ({
  data: (await import("../src/runtime/memory.ts")).memoryDataStore(),
  close: async () => {},
}));

dataStoreConformance("libSQL data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-data-"));
  const backend = libsqlBackend({
    url: pathToFileURL(path.join(directory, "whatsapp.db")).href,
    accountId: ACCOUNT,
    media: memoryMediaStore(),
  });
  return {
    data: backend.data,
    async close() {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

async function firstSnapshot(client: RuntimeFrameClient): Promise<CurrentMirrorSnapshot> {
  const controller = new AbortController();
  const frames = client.watch({ signal: controller.signal })[Symbol.asyncIterator]();
  const first = await frames.next();
  controller.abort();
  await frames.return?.();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "snapshot");
  return first.value.snapshot;
}

const mediaMessage = (
  kind: "image" | "audio",
  id: string,
  bytes: Uint8Array,
): InboundMessage & { readonly kind: "image" | "audio"; readonly media: MediaHandle } => ({
  id,
  chatId: CHAT,
  sender: { id: CHAT, mode: "pn" },
  fromMe: false,
  timestamp: AT,
  live: true,
  isGroup: false,
  kind,
  media: {
    mimetype: kind === "image" ? "image/png" : "audio/ogg; codecs=opus",
    ...(kind === "audio" && { ptt: true }),
    download: async () => Buffer.from(bytes),
  },
});

test("a new libSQL backend reconstructs one account through Runtime, DataStore, and Client", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-backend-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;

  try {
    const firstBackend = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
    const firstSession = createTestWhatsAppSession();
    const firstRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend: firstBackend,
      openSession: () => firstSession.session,
    });

    await firstRuntime.start();
    await firstBackend.credentials.write({ registration: "durable" });
    await firstSession.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: CHAT, text: "Hello", timestamp: AT }),
    });
    await firstSession.emit({
      type: "message",
      message: {
        id: "location-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 1,
        live: true,
        isGroup: false,
        kind: "location",
        lat: 5.6037,
        lng: -0.187,
        name: "Accra",
        address: "Greater Accra",
      },
    });
    await firstSession.emit({
      type: "message",
      message: {
        id: "contacts-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 2,
        live: true,
        isGroup: false,
        kind: "contacts",
        contacts: [{ name: "Ada", vcard: "BEGIN:VCARD\nFN:Ada\nEND:VCARD" }],
      },
    });
    await firstSession.emit({
      type: "message",
      message: {
        id: "poll-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 3,
        live: true,
        isGroup: false,
        kind: "poll",
        name: "Lunch?",
        options: ["Waakye", "Jollof"],
        selectableCount: 1,
      },
    });
    await firstSession.emit({
      type: "message",
      message: {
        id: "future-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 4,
        live: true,
        isGroup: false,
        kind: "unsupported",
        rawType: "futureMessage",
      },
    });
    await firstSession.emit({
      type: "message",
      message: {
        id: "group-1",
        chatId: ROOM,
        sender: { id: CHAT, mode: "pn", alt: "55555@lid" },
        keyParticipant: "55555:7@lid",
        pushName: "Ada",
        fromMe: false,
        timestamp: AT + 5,
        live: true,
        isGroup: true,
        context: { mentions: [CHAT] },
        flags: { ephemeral: true },
        kind: "text",
        text: "Group metadata",
      },
    });
    await firstSession.emit({
      type: "message",
      message: textMessage({ id: "updated", chatId: CHAT, text: "Before", timestamp: AT + 6 }),
    });
    await firstSession.emit({
      type: "update",
      update: {
        kind: "receipt",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        status: "read",
        at: AT + 7,
      },
    });
    await firstSession.emit({
      type: "update",
      update: {
        kind: "reaction",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        emoji: "👍",
        by: "alice@s.whatsapp.net",
        removed: false,
        at: AT + 8,
      },
    });
    await firstSession.emit({
      type: "update",
      update: {
        kind: "edit",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        at: AT + 9,
        message: {
          id: "ignored-edit-id",
          chatId: CHAT,
          sender: { id: CHAT, mode: "pn" },
          fromMe: false,
          timestamp: AT + 99,
          live: true,
          isGroup: false,
          kind: "location",
          lat: 5.56,
          lng: -0.2,
        },
      },
    });
    await firstSession.emit({
      type: "message",
      message: textMessage({ id: "revoked", chatId: CHAT, text: "Delete", timestamp: AT + 10 }),
    });
    await firstSession.emit({
      type: "update",
      update: {
        kind: "revoke",
        ref: { id: "revoked", chatId: CHAT, fromMe: false },
        by: "moderator@s.whatsapp.net",
        at: AT + 11,
      },
    });
    await firstRuntime.stop();

    const expectedSnapshot = await firstBackend.data.snapshot(ACCOUNT);
    const expectedSource = await firstBackend.data.accepted(ACCOUNT, 0);
    const expectedPage = await firstRuntime.messages(CHAT);
    const expectedGroupPage = await firstRuntime.messages(ROOM);
    await firstBackend.close();

    const replacementBackend = libsqlBackend({
      url,
      accountId: ACCOUNT,
      media: memoryMediaStore(),
    });
    const replacementSession = createTestWhatsAppSession();
    const replacementRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend: replacementBackend,
      openSession: () => replacementSession.session,
    });
    const replacementClient = createRuntimeFrameClient(replacementRuntime);

    await replacementRuntime.start();
    expect(await firstSnapshot(replacementClient)).toEqual(expectedSnapshot);
    expect(await replacementClient.messages(CHAT)).toEqual(expectedPage);
    expect(await replacementClient.messages(ROOM)).toEqual(expectedGroupPage);
    expect(
      (await replacementClient.messages(CHAT)).messages.find(
        ({ messageId }) => messageId === "location-1",
      ),
    ).toEqual({
      accountId: ACCOUNT,
      chatId: CHAT,
      messageId: "location-1",
      sender: { id: CHAT, mode: "pn" },
      ref: { id: "location-1", chatId: CHAT, fromMe: false },
      fromMe: false,
      timestamp: AT + 1,
      receipts: [],
      reactions: [],
      kind: "location",
      lat: 5.6037,
      lng: -0.187,
      name: "Accra",
      address: "Greater Accra",
    });
    expect((await replacementClient.messages(CHAT)).messages.map(({ kind }) => kind)).toEqual([
      "revoked",
      "location",
      "unsupported",
      "poll",
      "contacts",
      "location",
      "text",
    ]);
    expect(
      (await replacementClient.messages(CHAT)).messages.find(
        ({ messageId }) => messageId === "updated",
      ),
    ).toMatchObject({
      messageId: "updated",
      ref: { id: "updated", chatId: CHAT, fromMe: false },
      timestamp: AT + 6,
      receipts: [{ subject: "aggregate", status: "read", at: AT + 7 }],
      reactions: [
        {
          subject: "alice@s.whatsapp.net",
          emoji: "👍",
          by: "alice@s.whatsapp.net",
          at: AT + 8,
        },
      ],
      editedAt: AT + 9,
      kind: "location",
      lat: 5.56,
      lng: -0.2,
    });
    expect((await replacementClient.messages(ROOM)).messages[0]).toMatchObject({
      messageId: "group-1",
      pushName: "Ada",
      context: { mentions: [CHAT] },
      flags: { ephemeral: true },
      ref: { id: "group-1", chatId: ROOM, fromMe: false, participant: "55555:7@lid" },
    });
    expect(await replacementBackend.data.accepted(ACCOUNT, 0)).toEqual(expectedSource);
    expect(await replacementBackend.credentials.read("registration")).toBe("durable");

    await replacementRuntime.stop();
    await replacementBackend.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new libSQL, file media, Runtime, and Client instances reconstruct image and voice bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-replacement-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const mediaDirectory = path.join(directory, "media");
  const imageBytes = Uint8Array.from([1, 3, 5, 7]);
  const voiceBytes = Uint8Array.from([2, 4, 6, 8]);

  try {
    const firstMedia = fileMediaStore({ directory: mediaDirectory });
    const firstBackend = libsqlBackend({ url, accountId: ACCOUNT, media: firstMedia });
    const firstSession = createTestWhatsAppSession();
    const firstRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend: firstBackend,
      openSession: () => firstSession.session,
    });
    await firstRuntime.start();
    await firstSession.emit({
      type: "message",
      message: mediaMessage("image", "image-1", imageBytes),
    });
    await firstSession.emit({
      type: "message",
      message: mediaMessage("audio", "voice-1", voiceBytes),
    });
    await firstSession.emit({
      type: "message",
      message: {
        ...mediaMessage("image", "failed-1", Uint8Array.from([])),
        media: {
          mimetype: "image/png",
          async download() {
            throw new Error("expired media handle");
          },
        },
      },
    });
    await firstRuntime.stop();

    const expectedSnapshot = await firstBackend.data.snapshot(ACCOUNT);
    const expectedPage = await firstRuntime.messages(CHAT);
    const expectedSource = await firstBackend.data.accepted(ACCOUNT, 0);
    await firstBackend.close();

    const replacementMedia = fileMediaStore({ directory: mediaDirectory });
    const replacementBackend = libsqlBackend({
      url,
      accountId: ACCOUNT,
      media: replacementMedia,
    });
    const replacementSession = createTestWhatsAppSession();
    const replacementRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend: replacementBackend,
      openSession: () => replacementSession.session,
    });
    const replacementClient = createRuntimeFrameClient(replacementRuntime);
    await replacementRuntime.start();

    expect(await firstSnapshot(replacementClient)).toEqual(expectedSnapshot);
    expect(await replacementClient.messages(CHAT)).toEqual(expectedPage);
    expect(await replacementBackend.data.accepted(ACCOUNT, 0)).toEqual(expectedSource);
    for (const message of expectedPage.messages) {
      assert.ok(message.kind === "image" || message.kind === "audio");
      if (message.messageId === "failed-1") {
        assert.deepEqual(message.media, {
          state: "failed",
          reason: "download_failed",
          mimetype: "image/png",
        });
        continue;
      }
      assert.equal(message.media.state, "stored");
      assert.deepEqual(
        await replacementMedia.read({ accountId: ACCOUNT, ref: message.media.ref }),
        message.kind === "image" ? imageBytes : voiceBytes,
      );
    }

    await replacementRuntime.stop();
    await replacementBackend.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent libSQL backends contend on database time without resetting fencing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-leases-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const first = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const second = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });

  try {
    const original = await first.leases.acquire(ACCOUNT, "first", 10_000);
    assert.equal(original.acquired, true);
    const blocked = await second.leases.acquire(ACCOUNT, "second", 10_000);
    assert.equal(blocked.acquired, false);

    expect(await first.leases.release(original.lease)).toBe(true);
    const afterRelease = await second.leases.acquire(ACCOUNT, "second", 10_000);
    assert.equal(afterRelease.acquired, true);
    expect(afterRelease.lease.fencingToken > original.lease.fencingToken).toBe(true);
    expect(await second.leases.release(afterRelease.lease)).toBe(true);

    const expiring = await first.leases.acquire(ACCOUNT, "expiring", 1);
    assert.equal(expiring.acquired, true);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, expiring.lease.expiresAt - Date.now() + 5)),
    );
    expect(await first.leases.renew(expiring.lease, 10_000)).toEqual({
      renewed: false,
      reason: "expired",
    });
    const afterExpiry = await second.leases.acquire(ACCOUNT, "replacement", 10_000);
    assert.equal(afterExpiry.acquired, true);
    expect(afterExpiry.lease.fencingToken > expiring.lease.fencingToken).toBe(true);
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("equivalent libSQL file URLs resolve a simultaneous first lease as one winner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-concurrent-"));
  const databasePath = path.join(directory, "whatsapp.db");
  const url = pathToFileURL(databasePath).href;
  const relativeUrl = `file:${path.relative(process.cwd(), databasePath)}`;
  const first = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const second = libsqlBackend({
    url: relativeUrl,
    accountId: ACCOUNT,
    media: memoryMediaStore(),
  });

  try {
    const attempts = await Promise.all([
      first.leases.acquire(ACCOUNT, "first", 10_000),
      second.leases.acquire(ACCOUNT, "second", 10_000),
    ]);
    expect(attempts.filter(({ acquired }) => acquired).length).toBe(1);
    expect(attempts.filter(({ acquired }) => !acquired).length).toBe(1);
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement claim fences an independent stale backend before its first write", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-stale-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const stale = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const replacement = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });

  try {
    await stale.data.claim(ACCOUNT, 1);
    await replacement.data.claim(ACCOUNT, 2);
    await assert.rejects(
      stale.data.accept(
        ACCOUNT,
        [
          {
            observedAt: AT,
            event: {
              type: "message",
              message: textMessage({ id: "stale", chatId: CHAT, text: "stale", timestamp: AT }),
            },
          },
        ],
        1,
      ),
      StaleAccountClaimError,
    );
    expect(await replacement.data.accepted(ACCOUNT, 0)).toEqual([]);
    expect((await replacement.data.snapshot(ACCOUNT)).revision).toBe(0);
  } finally {
    await stale.close();
    await replacement.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a patch stored before aliases were carried still resolves addresses", async () => {
  const LID = "55555@lid";
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-legacy-patch-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  try {
    // Let the real backend build the schema, then write the row a version
    // before this change would have written: a consolidation whose patch
    // carries the merged contact and the redundant delete, and no aliases.
    const created = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
    await created.data.claim(ACCOUNT, 1);
    await created.close();

    const legacy = createClient({ url });
    await legacy.execute({
      sql: `INSERT INTO wa_accepted_batches
        (account_id, seq, from_revision, revision, events_json, patch_json)
        VALUES (?, 1, 0, 1, ?, ?)`,
      args: [
        ACCOUNT,
        JSON.stringify([]),
        JSON.stringify({
          accountId: ACCOUNT,
          fromRevision: 0,
          revision: 1,
          upserts: [
            {
              type: "contact",
              contact: { accountId: ACCOUNT, contactId: LID, nativeIds: [LID, CHAT] },
            },
          ],
          deletes: [{ type: "contact", contactId: CHAT }],
        }),
      ],
    });
    legacy.close();

    const upgraded = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
    try {
      const batch = (await upgraded.data.accepted(ACCOUNT, 0))[0];
      // Derived from the patch's own contact upsert rather than recorded, so a
      // consumer reading from revision 0 across the upgrade still reaches the
      // same Address Resolution instead of a map missing its whole history.
      expect(batch?.patch.aliases).toEqual([
        { nativeId: LID, contactId: LID },
        { nativeId: CHAT, contactId: LID },
      ]);
    } finally {
      await upgraded.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrations preserve wa_auth and credential clear cannot reach mirror data or another account", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-credentials-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const legacy = createClient({ url });
  await legacy.execute(
    "CREATE TABLE wa_auth (account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account, key))",
  );
  await legacy.execute({
    sql: "INSERT INTO wa_auth (account, key, value) VALUES (?, ?, ?)",
    args: [ACCOUNT, "legacy", "preserved"],
  });
  legacy.close();

  const personal = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const work = libsqlBackend({ url, accountId: "work", media: memoryMediaStore() });
  const message = (accountId: string, id: string) =>
    personal.data.accept(
      accountId,
      [
        {
          observedAt: AT,
          event: {
            type: "message" as const,
            message: textMessage({ id, chatId: CHAT, text: id, timestamp: AT }),
          },
        },
      ],
      1,
    );

  try {
    expect(await personal.credentials.read("legacy")).toBe("preserved");
    await work.credentials.write({ registration: "work" });
    await message(ACCOUNT, "personal-message");
    await message("work", "work-message");

    await personal.credentials.clear();
    expect(await personal.credentials.read("legacy")).toBe(null);
    expect(await work.credentials.read("registration")).toBe("work");
    expect(
      (await personal.data.messages(ACCOUNT, CHAT)).messages.map(({ messageId }) => messageId),
    ).toEqual(["personal-message"]);
    expect(
      (await work.data.messages("work", CHAT)).messages.map(({ messageId }) => messageId),
    ).toEqual(["work-message"]);
  } finally {
    await personal.close();
    await work.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted source decodes pre-upgrade metadata-only media as an explicit failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-legacy-media-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const migrated = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });

  try {
    await migrated.data.snapshot(ACCOUNT);
    await migrated.close();

    const legacyMessage = (id: string) => ({
      id,
      chatId: CHAT,
      sender: { id: CHAT, mode: "pn" },
      fromMe: false,
      timestamp: AT,
      live: true,
      isGroup: false,
      kind: "image",
      media: { mimetype: "image/png", width: 32, height: 24 },
    });
    const events = [
      { observedAt: AT, event: { type: "message", message: legacyMessage("direct") } },
      {
        observedAt: AT + 1,
        event: {
          type: "conversation_sync",
          batch: {
            context: { source: "recent", projection: { mode: "upsert" } },
            chats: [],
            contacts: [],
            messages: [legacyMessage("sync")],
          },
        },
      },
      {
        observedAt: AT + 2,
        event: {
          type: "update",
          update: {
            kind: "edit",
            ref: { id: "edit", chatId: CHAT, fromMe: false },
            message: legacyMessage("edit"),
          },
        },
      },
    ];
    const legacy = createClient({ url });
    await legacy.execute({
      sql: `INSERT INTO wa_accepted_batches
        (account_id, seq, from_revision, revision, events_json, patch_json)
        VALUES (?, 1, 0, 0, ?, ?)`,
      args: [
        ACCOUNT,
        JSON.stringify(events),
        JSON.stringify({ accountId: ACCOUNT, fromRevision: 0, revision: 0, upserts: [] }),
      ],
    });
    legacy.close();

    const replacement = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
    try {
      const accepted = await replacement.data.accepted(ACCOUNT, 0);
      const direct = accepted[0]?.events[0]?.event;
      const sync = accepted[0]?.events[1]?.event;
      const edit = accepted[0]?.events[2]?.event;
      assert.ok(direct?.type === "message" && direct.message.kind === "image");
      assert.ok(sync?.type === "conversation_sync" && sync.batch.messages[0]?.kind === "image");
      assert.ok(edit?.type === "update" && edit.update.kind === "edit");
      assert.equal(edit.update.message.kind, "image");
      for (const media of [
        direct.message.media,
        sync.batch.messages[0].media,
        edit.update.message.media,
      ]) {
        assert.deepEqual(media, {
          state: "failed",
          reason: "download_failed",
          mimetype: "image/png",
          width: 32,
          height: 24,
        });
      }
    } finally {
      await replacement.close();
    }
  } finally {
    await migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-change current message JSON remains readable with additive defaults", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-legacy-message-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const migrated = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });

  try {
    await migrated.data.snapshot(ACCOUNT);
    await migrated.close();

    const legacy = createClient({ url });
    await legacy.execute({
      sql: `INSERT INTO wa_messages
        (account_id, chat_id, message_id, timestamp, data_json)
        VALUES (?, ?, ?, ?, ?)`,
      args: [
        ACCOUNT,
        CHAT,
        "legacy",
        AT,
        JSON.stringify({
          accountId: ACCOUNT,
          chatId: CHAT,
          messageId: "legacy",
          sender: { id: CHAT, mode: "pn" },
          fromMe: false,
          timestamp: AT,
          kind: "text",
          text: "Before additive fields",
        }),
      ],
    });
    await legacy.execute({
      sql: `INSERT INTO wa_messages
        (account_id, chat_id, message_id, timestamp, data_json)
        VALUES (?, ?, ?, ?, ?)`,
      args: [
        ACCOUNT,
        ROOM,
        "legacy-group",
        AT,
        JSON.stringify({
          accountId: ACCOUNT,
          chatId: ROOM,
          messageId: "legacy-group",
          sender: { id: CHAT, mode: "pn" },
          fromMe: false,
          timestamp: AT,
          kind: "text",
          text: "Before action refs",
        }),
      ],
    });
    legacy.close();

    const replacement = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
    try {
      expect((await replacement.data.messages(ACCOUNT, CHAT)).messages).toEqual([
        {
          accountId: ACCOUNT,
          chatId: CHAT,
          messageId: "legacy",
          sender: { id: CHAT, mode: "pn" },
          ref: { id: "legacy", chatId: CHAT, fromMe: false },
          fromMe: false,
          timestamp: AT,
          receipts: [],
          reactions: [],
          kind: "text",
          text: "Before additive fields",
        },
      ]);
      expect((await replacement.data.messages(ACCOUNT, ROOM)).messages[0]?.ref).toEqual({
        id: "legacy-group",
        chatId: ROOM,
        fromMe: false,
        participant: CHAT,
      });
    } finally {
      await replacement.close();
    }
  } finally {
    await migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed SQL record write rolls back source, projection, and revision together", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-rollback-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const media = memoryMediaStore();
  const backend = libsqlBackend({ url, accountId: ACCOUNT, media });
  const oracle = createClient({ url });

  try {
    await backend.data.accept(
      ACCOUNT,
      [
        {
          observedAt: AT,
          event: {
            type: "message",
            message: textMessage({ id: "committed", chatId: CHAT, text: "before", timestamp: AT }),
          },
        },
      ],
      1,
    );
    const beforeSnapshot = await backend.data.snapshot(ACCOUNT);
    const beforeSource = await backend.data.accepted(ACCOUNT, 0);
    const beforePage = await backend.data.messages(ACCOUNT, CHAT);

    await oracle.execute(`CREATE TRIGGER fail_record_write
      BEFORE INSERT ON wa_messages WHEN NEW.message_id = 'fail'
      BEGIN SELECT RAISE(ABORT, 'injected record failure'); END`);
    const bytes = Uint8Array.from([9, 8, 7, 6]);
    const orphan = await media.put({
      accountId: ACCOUNT,
      message: { id: "fail", chatId: CHAT, fromMe: false },
      kind: "image",
      bytes,
      mimetype: "image/png",
    });
    await assert.rejects(
      backend.data.accept(
        ACCOUNT,
        [
          {
            observedAt: AT + 1,
            event: {
              type: "contact",
              contact: { id: CHAT, nativeIds: [CHAT], displayName: "Must roll back" },
            },
          },
          {
            observedAt: AT + 1,
            event: {
              type: "message",
              message: {
                id: "fail",
                chatId: CHAT,
                sender: { id: CHAT, mode: "pn" },
                fromMe: false,
                timestamp: AT + 1,
                live: true,
                isGroup: false,
                kind: "image",
                media: { state: "stored", ...orphan, mimetype: "image/png" },
              },
            },
          },
        ],
        1,
      ),
      /injected record failure/,
    );

    expect(await backend.data.snapshot(ACCOUNT)).toEqual(beforeSnapshot);
    expect(await backend.data.accepted(ACCOUNT, 0)).toEqual(beforeSource);
    expect(await backend.data.messages(ACCOUNT, CHAT)).toEqual(beforePage);
    assert.deepEqual(await media.read({ accountId: ACCOUNT, ref: orphan.ref }), bytes);

    const state = await oracle.execute({
      sql: "SELECT revision, source_seq FROM wa_accounts WHERE account_id = ?",
      args: [ACCOUNT],
    });
    const counts = await oracle.execute({
      sql: `SELECT
        (SELECT COUNT(*) FROM wa_accepted_batches WHERE account_id = ?) AS batches,
        (SELECT COUNT(*) FROM wa_messages WHERE account_id = ?) AS messages,
        (SELECT COUNT(*) FROM wa_contacts WHERE account_id = ?) AS contacts`,
      args: [ACCOUNT, ACCOUNT, ACCOUNT],
    });
    expect([state.rows[0]?.revision, state.rows[0]?.source_seq]).toEqual([1, 1]);
    expect([counts.rows[0]?.batches, counts.rows[0]?.messages, counts.rows[0]?.contacts]).toEqual([
      1, 1, 0,
    ]);
  } finally {
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed SQL message UPDATE rolls back source, current state, and both counters", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-update-rollback-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const backend = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const oracle = createClient({ url });

  try {
    await backend.data.accept(
      ACCOUNT,
      [
        {
          observedAt: AT,
          event: {
            type: "message",
            message: textMessage({ id: "committed", chatId: CHAT, text: "before", timestamp: AT }),
          },
        },
      ],
      1,
    );
    const beforeSnapshot = await backend.data.snapshot(ACCOUNT);
    const beforeSource = await backend.data.accepted(ACCOUNT, 0);
    const beforePage = await backend.data.messages(ACCOUNT, CHAT);

    await oracle.execute(`CREATE TRIGGER fail_message_update
      BEFORE UPDATE ON wa_messages WHEN OLD.message_id = 'committed'
      BEGIN SELECT RAISE(ABORT, 'injected message update failure'); END`);
    await assert.rejects(
      backend.data.accept(
        ACCOUNT,
        [
          {
            observedAt: AT + 1,
            event: {
              type: "update",
              update: {
                kind: "receipt",
                ref: { id: "committed", chatId: CHAT, fromMe: false },
                status: "read",
                at: AT + 1,
              },
            },
          },
        ],
        1,
      ),
      /injected message update failure/,
    );

    expect(await backend.data.snapshot(ACCOUNT)).toEqual(beforeSnapshot);
    expect(await backend.data.accepted(ACCOUNT, 0)).toEqual(beforeSource);
    expect(await backend.data.messages(ACCOUNT, CHAT)).toEqual(beforePage);

    const state = await oracle.execute({
      sql: "SELECT revision, source_seq FROM wa_accounts WHERE account_id = ?",
      args: [ACCOUNT],
    });
    expect([state.rows[0]?.revision, state.rows[0]?.source_seq]).toEqual([1, 1]);
  } finally {
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second Runtime on an independent backend fails before opening WhatsApp", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-runtime-lease-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const firstBackend = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const secondBackend = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });
  const firstSession = createTestWhatsAppSession();
  const secondSession = createTestWhatsAppSession();
  let secondOpened = 0;
  const firstRuntime = createWhatsAppRuntime({
    accountId: ACCOUNT,
    backend: firstBackend,
    openSession: () => firstSession.session,
  });
  const secondRuntime = createWhatsAppRuntime({
    accountId: ACCOUNT,
    backend: secondBackend,
    openSession: () => {
      secondOpened++;
      return secondSession.session;
    },
  });

  try {
    await firstRuntime.start();
    await assert.rejects(secondRuntime.start(), AccountAlreadyClaimedError);
    expect(secondOpened).toBe(0);
    await firstRuntime.stop();
    await secondRuntime.start();
    expect(secondOpened).toBe(1);
    await secondRuntime.stop();
  } finally {
    await firstBackend.close();
    await secondBackend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("close waits for a read still holding its transaction open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-close-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const backend = libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() });

  try {
    // A read runs off the shared write queue once the file is in WAL, so it is
    // not covered by the queue close() drains. Returning while one is open
    // hands the caller a database it is still reading — this suite's own
    // factories delete the directory on the next line.
    await backend.data.snapshot(ACCOUNT);
    const order: string[] = [];
    const reading = backend.data.read(ACCOUNT, async (view) => {
      await view.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await view.snapshot();
      order.push("read");
      return second.revision;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const closing = backend.close().then(() => order.push("close"));

    expect(await reading).toBe(0);
    await closing;
    expect(order).toEqual(["read", "close"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("several backends can open one new database at the same time", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-open-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  // Opening is what creates the schema and moves the journal, and entering WAL
  // takes the whole file — an upgrade SQLite refuses immediately instead of
  // handing to the busy timeout. Opening outside the shared queue therefore
  // loses every client but one, which no test reached while each suite opened
  // its backends one at a time.
  const backends = Array.from({ length: 6 }, () =>
    libsqlBackend({ url, accountId: ACCOUNT, media: memoryMediaStore() }),
  );

  try {
    const opened = await Promise.all(backends.map((backend) => backend.data.snapshot(ACCOUNT)));
    expect(opened.map((snapshot) => snapshot.revision)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    await Promise.all(backends.map((backend) => backend.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
