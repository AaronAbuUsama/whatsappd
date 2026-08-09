import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./_expect.ts";
import { conformsToStore } from "./store-conformance.ts";
import { memoryStore } from "../src/stores/memory.ts";
import { fileStore } from "../src/stores/file.ts";
import { libsqlStore } from "../src/stores/libsql.ts";

// Every store must satisfy the same spec — that's what makes them swappable.
conformsToStore("memory", () => memoryStore());
conformsToStore("file", () => fileStore(mkdtempSync(join(tmpdir(), "wa-file-"))));
conformsToStore("libsql", () => libsqlStore({ url: ":memory:" }));

// file-specific: the store directory is not guaranteed to survive the process
// that created it. A cleanup job or an operator can remove it under a live
// store, and the next credential save must recreate it rather than ENOENT.
test("[file] a write recreates a store directory that disappeared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-file-gone-"));
  const store = fileStore(dir);

  await store.write({ creds: "before" });
  rmSync(dir, { recursive: true, force: true });

  await store.write({ creds: "after" });
  expect(await store.read("creds")).toBe("after");
});

test("[file] clear removes credentials without deleting its caller's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-file-owned-"));
  const unrelated = join(dir, "application-data.txt");
  writeFileSync(unrelated, "keep me");
  const store = fileStore(dir);

  await store.write({ creds: "secret", "pre-key:1": "key" });
  await store.clear();

  expect(readFileSync(unrelated, "utf8")).toBe("keep me");
  expect(await store.read("creds")).toBe(null);
});

test("[file] clear removes migrated and untouched legacy credentials across restarts", async () => {
  const legacyNames = [
    "creds.json",
    "pre-key_1.json",
    "session_peer.json",
    "sender-key_peer.json",
    "sender-key-memory_peer.json",
    "app-state-sync-key_1.json",
    "app-state-sync-version_1.json",
    "lid-mapping_peer.json",
    "device-list_peer.json",
    "tctoken_peer.json",
    "identity-key_peer.json",
  ];

  for (const migrateCreds of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "wa-file-legacy-"));
    const unrelated = join(dir, "application-data.json");
    for (const name of legacyNames) writeFileSync(join(dir, name), "old secret");
    writeFileSync(unrelated, "keep me");

    if (migrateCreds) expect(await fileStore(dir).read("creds")).toBe("old secret");
    await fileStore(dir).clear();

    expect(await fileStore(dir).read("creds")).toBe(null);
    for (const name of legacyNames) expect(() => readFileSync(join(dir, name), "utf8")).toThrow();
    expect(readFileSync(unrelated, "utf8")).toBe("keep me");
  }
});

test("[file] distinct credential keys cannot collide on one filename", async () => {
  const store = fileStore(mkdtempSync(join(tmpdir(), "wa-file-keys-")));

  await store.write({ "a/b": "slash", "a:b": "colon" });

  expect(await store.read("a/b")).toBe("slash");
  expect(await store.read("a:b")).toBe("colon");
});

test("[file] a storage error is not reported as a missing credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-file-error-"));
  const notDirectory = join(root, "not-a-directory");
  writeFileSync(notDirectory, "occupied");

  await assert.rejects(fileStore(notDirectory).read("creds"), { code: "ENOTDIR" });
});

test("[file] credential storage is private to the current operating-system user", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-file-mode-"));
  const store = fileStore(dir);
  await store.write({ creds: "secret" });

  const namespace = readdirSync(dir, { withFileTypes: true }).find((entry) => entry.isDirectory());
  assert.ok(namespace);
  expect(statSync(join(dir, namespace.name)).mode & 0o777).toBe(0o700);
  for (const file of readdirSync(join(dir, namespace.name)))
    expect(statSync(join(dir, namespace.name, file)).mode & 0o777).toBe(0o600);
});

// libsql-specific: one database, many accounts, fully isolated row-spaces.
test("[libsql] accounts are namespaced within a single database", async () => {
  const url = `file:${join(mkdtempSync(join(tmpdir(), "wa-libsql-")), "shared.db")}`;
  const a = libsqlStore({ url, account: "971000000001" });
  const b = libsqlStore({ url, account: "971000000002" });

  await a.write({ creds: "A-creds" });
  await b.write({ creds: "B-creds" });

  expect(await a.read("creds")).toBe("A-creds");
  expect(await b.read("creds")).toBe("B-creds");

  // Wiping one account leaves the other intact.
  await a.clear();
  expect(await a.read("creds")).toBe(null);
  expect(await b.read("creds")).toBe("B-creds");
});

// libsql-specific: the table name is validated, never interpolated blindly.
test("[libsql] rejects an unsafe table name", () => {
  let threw = false;
  try {
    libsqlStore({ url: ":memory:", table: "wa; DROP TABLE x" });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});
