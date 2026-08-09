import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileMediaStore, memoryMediaStore, type MediaStore } from "../src/index.ts";
import { test } from "./_expect.ts";

const unsafeAccount = "../../personal/account";
const unsafeMessage = {
  id: "../message/one",
  chatId: "../chat@s.whatsapp.net",
  fromMe: false,
} as const;

const put = (store: MediaStore, bytes: Uint8Array, accountId = unsafeAccount) =>
  store.put({
    accountId,
    owner: { type: "message", message: unsafeMessage },
    kind: "document",
    bytes,
    mimetype: "application/octet-stream",
  });

async function expectOwnedAndIsolated(store: MediaStore): Promise<void> {
  const callerBytes = Uint8Array.from([1, 2, 3, 4]);
  const writing = put(store, callerBytes);
  callerBytes[0] = 99;
  const stored = await writing;

  const firstRead = await store.read({ accountId: unsafeAccount, ref: stored.ref });
  assert.deepEqual(firstRead, Uint8Array.from([1, 2, 3, 4]));
  assert.ok(firstRead);
  firstRead[1] = 88;
  assert.deepEqual(
    await store.read({ accountId: unsafeAccount, ref: stored.ref }),
    Uint8Array.from([1, 2, 3, 4]),
  );
  assert.equal(await store.read({ accountId: "another-account", ref: stored.ref }), null);

  const repeated = await put(store, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual(repeated, stored);
}

test("memory media owns mutable bytes, isolates accounts, and reuses immutable refs", async () => {
  await expectOwnedAndIsolated(memoryMediaStore());
});

test("file media survives a new store, keeps private opaque paths, and owns bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-"));
  try {
    const first = fileMediaStore({ directory });
    await expectOwnedAndIsolated(first);
    const stored = await put(first, Uint8Array.from([5, 6, 7]));

    const replacement = fileMediaStore({ directory });
    assert.deepEqual(
      await replacement.read({ accountId: unsafeAccount, ref: stored.ref }),
      Uint8Array.from([5, 6, 7]),
    );
    for (const unsafe of [unsafeAccount, unsafeMessage.chatId, unsafeMessage.id])
      assert.equal(stored.ref.includes(unsafe), false);

    const namespace = path.join(directory, ".whatsappd-media");
    const entries = await readdir(namespace, { recursive: true });
    assert.ok(entries.length > 0);
    assert.equal((await stat(namespace)).mode & 0o777, 0o700);
    assert.equal(
      entries.some((entry) => entry.includes("..") || entry.endsWith(".tmp")),
      false,
    );
    for (const entry of entries) {
      for (const unsafe of [unsafeAccount, unsafeMessage.chatId, unsafeMessage.id])
        assert.equal(entry.includes(unsafe), false);
      const mode = (await stat(path.join(namespace, entry))).mode & 0o777;
      assert.equal(mode, entry.endsWith(".bin") ? 0o600 : 0o700);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file media syncs created directories and the canonical publication before returning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-sync-"));
  const originalOpen = fs.promises.open;
  const synced: string[] = [];
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    return {
      async sync() {
        synced.push(String(args[0]));
        await handle.sync();
      },
      close: () => handle.close(),
    } as Awaited<ReturnType<typeof originalOpen>>;
  }) as typeof originalOpen;
  syncBuiltinESMExports();

  try {
    await put(fileMediaStore({ directory }), Uint8Array.from([1, 2, 3]), "personal");
    const namespace = path.join(directory, ".whatsappd-media");
    const entries = await readdir(namespace, { recursive: true });
    const object = entries.find((entry) => entry.endsWith(".bin"));
    assert.ok(object);
    const accountDirectory = path.dirname(path.join(namespace, object));

    assert.ok(synced.includes(directory));
    assert.ok(synced.includes(namespace));
    assert.ok(synced.includes(accountDirectory));
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent file media puts converge on one complete canonical object", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-race-"));
  try {
    const bytes = Uint8Array.from({ length: 64 * 1024 }, (_, index) => index % 251);
    const stores = Array.from({ length: 8 }, () => fileMediaStore({ directory }));
    const results = await Promise.all(stores.map((store) => put(store, bytes, "personal")));
    assert.equal(new Set(results.map(({ ref }) => ref)).size, 1);
    assert.deepEqual(
      await fileMediaStore({ directory }).read({ accountId: "personal", ref: results[0]!.ref }),
      bytes,
    );

    const entries = await readdir(path.join(directory, ".whatsappd-media"), { recursive: true });
    assert.equal(entries.filter((entry) => entry.endsWith(".bin")).length, 1);
    assert.equal(
      entries.some((entry) => entry.endsWith(".tmp")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
