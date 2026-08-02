import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-packed-"));

try {
  await execFile("pnpm", ["pack", "--pack-destination", consumer], { cwd: root });
  const archive = (await readdir(consumer)).find((file) => file.endsWith(".tgz"));
  assert.ok(archive, "pnpm pack did not produce an archive");

  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        whatsappd: `file:./${archive}`,
      },
    }),
  );
  await execFile("pnpm", ["install", "--ignore-scripts"], { cwd: consumer });

  const packageJson = JSON.parse(
    await readFile(path.join(consumer, "node_modules/whatsappd/package.json"), "utf8"),
  ) as { readonly bin?: unknown; readonly exports: Record<string, unknown> };
  assert.equal(packageJson.bin, undefined);
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./package.json", "./testing"]);
  const dist = path.join(consumer, "node_modules/whatsappd/dist");
  const declarations = (
    await Promise.all(
      (
        await readdir(dist)
      )
        .filter((file) => file.endsWith(".d.mts"))
        .map((file) => readFile(path.join(dist, file), "utf8")),
    )
  ).join("\n");
  for (const removed of [
    "SessionStore",
    "IncomingMessage",
    "ConversationSyncChat",
    "ConversationSyncContact",
    "HistoryBatch",
    "libsqlStore",
    "RuntimeClientFeed",
    "WhatsAppClientFrame",
  ]) {
    assert.equal(new RegExp(`\\b${removed}\\b`).test(declarations), false);
  }
  for (const retiredVocabulary of [
    /\bcallbacks?\b/i,
    /\b(?:event|inbound|contacts?|presence|groups?|connection|own)\W+streams?\b/i,
    /\bstream-only\b/i,
  ]) {
    assert.equal(retiredVocabulary.test(declarations), false);
  }

  await writeFile(
    path.join(consumer, "verify.mjs"),
    `
      import assert from "node:assert/strict";
      import * as root from "whatsappd";
      import { createTestWhatsAppSession } from "whatsappd/testing";

      assert.equal(typeof root.createSession, "function");
      assert.equal(typeof createTestWhatsAppSession, "function");
      assert.equal(typeof root.memoryStore, "function");
      assert.equal(typeof root.createWhatsAppRuntime, "function");
      assert.equal(typeof root.createWhatsAppClient, "function");
      assert.equal("createInProcessWhatsAppClient" in root, false);
      assert.equal(typeof root.memoryBackend, "function");
      assert.equal(typeof root.libsqlBackend, "function");
      assert.equal(typeof root.fileMediaStore, "function");
      const media = root.fileMediaStore({ directory: "./media" });
      const stored = await media.put({
        accountId: "personal",
        message: { id: "packed", chatId: "person@s.whatsapp.net", fromMe: false },
        kind: "document",
        bytes: Uint8Array.from([1, 2, 3]),
      });
      assert.deepEqual(
        await media.read({ accountId: "personal", ref: stored.ref }),
        Uint8Array.from([1, 2, 3]),
      );
      const backend = root.libsqlBackend({
        url: "file:./not-opened.db",
        accountId: "personal",
        media: root.memoryMediaStore(),
      });
      assert.equal(typeof backend.close, "function");
      await backend.close();
      for (const removed of ["createChannelAdapter", "bindTools"]) {
        assert.equal(removed in root, false);
      }
      for (const subpath of ["adapters/eve", "channel", "sidecar", "stores/libsql", "stores/memory", "tools"]) {
        await assert.rejects(import(\`whatsappd/\${subpath}\`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      }
    `,
  );
  await execFile(process.execPath, ["verify.mjs"], { cwd: consumer });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
