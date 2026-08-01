import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./_expect.ts";
import {
  createInProcessWhatsAppClient,
  createWhatsAppRuntime,
  libsqlBackend,
  memoryMediaStore,
  AccountAlreadyClaimedError,
  StaleAccountClaimError,
  type WhatsAppClient,
  type WhatsAppSnapshot,
} from "../src/index.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";
import { dataStoreConformance } from "./data-store-conformance.ts";

const ACCOUNT = "personal";
const CHAT = "person@s.whatsapp.net";
const AT = 1_700_000_000_000;

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

async function firstSnapshot(client: WhatsAppClient): Promise<WhatsAppSnapshot> {
  const controller = new AbortController();
  const frames = client.watch({ signal: controller.signal })[Symbol.asyncIterator]();
  const first = await frames.next();
  controller.abort();
  await frames.return?.();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "snapshot");
  return first.value.snapshot;
}

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
    await firstRuntime.stop();

    const expectedSnapshot = await firstBackend.data.snapshot(ACCOUNT);
    const expectedSource = await firstBackend.data.accepted(ACCOUNT, 0);
    const expectedPage = await firstRuntime.messages(CHAT);
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
    const replacementClient = createInProcessWhatsAppClient(replacementRuntime);

    await replacementRuntime.start();
    expect(await firstSnapshot(replacementClient)).toEqual(expectedSnapshot);
    expect(await replacementClient.messages(CHAT)).toEqual(expectedPage);
    expect(await replacementBackend.data.accepted(ACCOUNT, 0)).toEqual(expectedSource);
    expect(await replacementBackend.credentials.read("registration")).toBe("durable");

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

test("a failed SQL record write rolls back source, projection, and revision together", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-libsql-rollback-"));
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

    await oracle.execute(`CREATE TRIGGER fail_record_write
      BEFORE INSERT ON wa_messages WHEN NEW.message_id = 'fail'
      BEGIN SELECT RAISE(ABORT, 'injected record failure'); END`);
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
              message: textMessage({ id: "fail", chatId: CHAT, text: "fail", timestamp: AT + 1 }),
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
