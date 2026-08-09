import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileMediaStore, memoryMediaStore, type MediaStore } from "../src/index.ts";
import { test } from "../../../tooling/checks/test-harness.ts";

const unsafeAccount = "../../personal/account";
const unsafeMessage = {
  id: "../message/one",
  chatId: "../chat@s.whatsapp.net",
  fromMe: false,
} as const;

const sourceOf = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (let offset = 0; offset < bytes.byteLength; offset += 2)
      yield bytes.subarray(offset, offset + 2);
  },
});

const collect = async (source: AsyncIterable<Uint8Array> | null): Promise<Uint8Array | null> => {
  if (!source) return null;
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(Uint8Array.from(chunk));
  return Uint8Array.from(Buffer.concat(chunks));
};

const write = (store: MediaStore, bytes: Uint8Array, accountId = unsafeAccount) =>
  store.write({
    accountId,
    owner: { type: "message", message: unsafeMessage },
    kind: "document",
    source: sourceOf(bytes),
    mimetype: "application/octet-stream",
  });

async function expectOwnedAndIsolated(store: MediaStore): Promise<void> {
  const callerBytes = Uint8Array.from([1, 2, 3, 4]);
  const writing = write(store, callerBytes);
  const stored = await writing;

  const firstRead = await collect(await store.open({ accountId: unsafeAccount, ref: stored.ref }));
  assert.deepEqual(firstRead, Uint8Array.from([1, 2, 3, 4]));
  assert.ok(firstRead);
  firstRead[1] = 88;
  assert.deepEqual(
    await collect(await store.open({ accountId: unsafeAccount, ref: stored.ref })),
    Uint8Array.from([1, 2, 3, 4]),
  );
  assert.equal(await store.open({ accountId: "another-account", ref: stored.ref }), null);

  const repeated = await write(store, Uint8Array.from([1, 2, 3, 4]));
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
    const stored = await write(first, Uint8Array.from([5, 6, 7]));

    const replacement = fileMediaStore({ directory });
    assert.deepEqual(
      await collect(await replacement.open({ accountId: unsafeAccount, ref: stored.ref })),
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
      const metadata = await stat(path.join(namespace, entry));
      assert.equal(metadata.mode & 0o777, metadata.isDirectory() ? 0o700 : 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file media removes unpublished state when its source fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-failure-"));
  let closed = false;
  try {
    await assert.rejects(
      fileMediaStore({ directory }).write({
        accountId: unsafeAccount,
        owner: { type: "message", message: unsafeMessage },
        kind: "document",
        source: (async function* () {
          try {
            yield Uint8Array.from([1, 2, 3]);
            throw new Error("source failed");
          } finally {
            closed = true;
          }
        })(),
      }),
      /source failed/,
    );
    assert.equal(closed, true);
    const entries = await readdir(path.join(directory, ".whatsappd-media"), { recursive: true });
    assert.equal(
      entries.some((entry) => entry.endsWith(".tmp") || entry.endsWith(".bin")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file media preserves immutable bytes when publication durability is uncertain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-publication-failure-"));
  const originalOpen = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    return {
      write: (...writeArgs: Parameters<typeof handle.write>) => handle.write(...writeArgs),
      async sync() {
        if (String(args[0]).endsWith(".bin")) throw new Error("canonical sync failed");
        await handle.sync();
      },
      close: () => handle.close(),
    } as Awaited<ReturnType<typeof originalOpen>>;
  }) as typeof originalOpen;
  syncBuiltinESMExports();

  const store = fileMediaStore({ directory });
  const bytes = Uint8Array.from([1, 2, 3]);
  const expected = await write(memoryMediaStore(), bytes, "personal");
  try {
    await assert.rejects(write(store, bytes, "personal"), /canonical sync failed/);
    assert.deepEqual(
      await collect(await store.open({ accountId: "personal", ref: expected.ref })),
      bytes,
    );
    const entries = await readdir(path.join(directory, ".whatsappd-media"), { recursive: true });
    assert.equal(
      entries.some((entry) => entry.endsWith(".tmp")),
      false,
    );
    assert.equal(entries.filter((entry) => entry.endsWith(".bin")).length, 1);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
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
      write: (...writeArgs: Parameters<typeof handle.write>) => handle.write(...writeArgs),
      async sync() {
        synced.push(String(args[0]));
        await handle.sync();
      },
      close: () => handle.close(),
    } as Awaited<ReturnType<typeof originalOpen>>;
  }) as typeof originalOpen;
  syncBuiltinESMExports();

  try {
    await write(fileMediaStore({ directory }), Uint8Array.from([1, 2, 3]), "personal");
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

test("file media writes and opens incrementally", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-streaming-"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const first = Uint8Array.from({ length: 128 * 1024 }, () => 1);
  const second = Uint8Array.from({ length: 128 * 1024 }, () => 2);
  const store = fileMediaStore({ directory });
  try {
    const writing = store.write({
      accountId: "personal",
      owner: { type: "message", message: unsafeMessage },
      kind: "document",
      source: (async function* () {
        yield first;
        firstWritten();
        await blocked;
        yield second;
      })(),
    });
    await written;

    const namespace = path.join(directory, ".whatsappd-media");
    const inProgress = await readdir(namespace, { recursive: true });
    const temporary = inProgress.find((entry) => entry.endsWith(".tmp"));
    assert.ok(temporary);
    assert.equal((await stat(path.join(namespace, temporary))).size, first.byteLength);
    assert.equal(
      inProgress.some((entry) => entry.endsWith(".bin")),
      false,
    );

    release();
    const stored = await writing;
    const opened = await store.open({ accountId: "personal", ref: stored.ref });
    assert.ok(opened);
    const iterator = opened[Symbol.asyncIterator]();
    const firstRead = await iterator.next();
    assert.equal(firstRead.done, false);
    assert.ok(firstRead.value.byteLength < stored.byteLength);
    const chunks = [Uint8Array.from(firstRead.value)];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      chunks.push(Uint8Array.from(next.value));
    }
    assert.deepEqual(
      Uint8Array.from(Buffer.concat(chunks)),
      Uint8Array.from(Buffer.concat([first, second])),
    );
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent file media writes converge on one complete canonical object", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-media-race-"));
  try {
    const bytes = Uint8Array.from({ length: 64 * 1024 }, (_, index) => index % 251);
    const stores = Array.from({ length: 8 }, () => fileMediaStore({ directory }));
    const results = await Promise.all(stores.map((store) => write(store, bytes, "personal")));
    assert.equal(new Set(results.map(({ ref }) => ref)).size, 1);
    assert.deepEqual(
      await collect(
        await fileMediaStore({ directory }).open({ accountId: "personal", ref: results[0]!.ref }),
      ),
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
