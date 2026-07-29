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
        "@libsql/client": "0.15.15",
        whatsappd: `file:./${archive}`,
      },
    }),
  );
  await execFile("pnpm", ["install", "--ignore-scripts"], { cwd: consumer });

  const packageJson = JSON.parse(
    await readFile(path.join(consumer, "node_modules/whatsappd/package.json"), "utf8"),
  ) as { readonly bin?: unknown; readonly exports: Record<string, unknown> };
  assert.equal(packageJson.bin, undefined);
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [
    ".",
    "./package.json",
    "./stores/libsql",
    "./stores/memory",
    "./testing",
  ]);
  const declarations = await readFile(
    path.join(consumer, "node_modules/whatsappd/dist/index.d.mts"),
    "utf8",
  );
  for (const removed of [
    "SessionStore",
    "IncomingMessage",
    "ConversationSyncChat",
    "ConversationSyncContact",
    "HistoryBatch",
  ]) {
    assert.equal(new RegExp(`\\b${removed}\\b`).test(declarations), false);
  }

  await writeFile(
    path.join(consumer, "verify.mjs"),
    `
      import assert from "node:assert/strict";
      import * as root from "whatsappd";
      import { createTestWhatsAppSession } from "whatsappd/testing";
      import { memoryStore } from "whatsappd/stores/memory";
      import { libsqlStore } from "whatsappd/stores/libsql";

      assert.equal(typeof root.createSession, "function");
      assert.equal(typeof createTestWhatsAppSession, "function");
      assert.equal(typeof memoryStore, "function");
      assert.equal(typeof libsqlStore, "function");
      for (const removed of ["createChannelAdapter", "bindTools"]) {
        assert.equal(removed in root, false);
      }
      for (const subpath of ["adapters/eve", "channel", "sidecar", "tools"]) {
        await assert.rejects(import(\`whatsappd/\${subpath}\`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      }
    `,
  );
  await execFile(process.execPath, ["verify.mjs"], { cwd: consumer });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
