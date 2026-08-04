import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-packed-"));

const digests = async (directory: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(directory)).map(
        async (file) =>
          [
            file,
            createHash("sha256")
              .update(await readFile(path.join(directory, file)))
              .digest("hex"),
          ] as const,
      ),
    ),
  );

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
  // A positive control, before anything is asserted absent. Every check below
  // is a negative — `regex.test(declarations) === false` — and a `dist/` that
  // is empty, stale, or emitted no `.d.mts` at all satisfies every one of them
  // while observing nothing. That is the shape of the false green in
  // `docs/issue-71-postmortem.md` section 6, so the file has to prove it is
  // looking at real declarations first.
  assert.ok(declarations.length > 0, "no packed declarations were read");
  // Naming known-published symbols was not enough, which is the correction
  // #119 asked for: `createWhatsAppRuntime` and friends are in every recent
  // build, so they caught an *empty* `dist/` and not a *wrong* one — one built
  // from pre-#105 `7e1a730` passed this whole file. The published vocabulary
  // cannot separate those two commits either, because `src/index.ts` is
  // byte-identical across them and the artifact is not.
  //
  // So the control is the artifact rather than its vocabulary: rebuild from
  // this working tree's source and require the packed bytes to match. Green
  // only when the tarball is what this source builds; red for an older commit's
  // `dist/`, or for a stale file the build no longer emits.
  //
  // It fails red rather than passing when the rebuild does not happen: the
  // right-hand digests are read from a directory removed a line earlier, so a
  // build that wrote nothing throws `ENOENT` instead of leaving two equally
  // stale directories to compare equal.
  //
  // ponytail: rides on `vp pack` cleaning `dist/` and building byte-identically
  // from identical source, both true today. Losing idempotence turns this red
  // every run and announces itself; losing the clean is the quiet one, because
  // a stale file would then survive into both sides. Re-check on a `vp`
  // upgrade — C6 in `docs/client-stack-defect-ledger.md` owns that obligation.
  const packedDist = await digests(dist);
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await execFile("pnpm", ["build"], { cwd: root });
  assert.deepEqual(
    packedDist,
    await digests(path.join(root, "dist")),
    "the packed dist/ is not this working tree's build — `pnpm pack` archives whatever dist/ already holds",
  );
  for (const removed of [
    "SessionStore",
    "IncomingMessage",
    "ConversationSyncChat",
    "ConversationSyncContact",
    "HistoryBatch",
    "libsqlStore",
  ]) {
    assert.equal(new RegExp(`\\b${removed}\\b`).test(declarations), false);
  }
  // The runtime-to-client source is an internal Module, not a public Adapter:
  // its joint read, its account claim and its identity sample are how the
  // friendly client reaches the Data Store transaction without a Backend
  // parameter or a public `runtime.read()` (ADR-0030). None of it, and no part
  // of the client core this stack layer builds on it, is a published contract
  // yet. `RuntimeSession.identity` is deliberately not in this list: an
  // application supplies its own session, so that capability has to be
  // declarable.
  for (const modulePrivate of [
    "ClientRuntimeSource",
    "clientSourceFor",
    "ClientClaim",
    "currentClaim",
    "createWhatsAppClient",
    "WhatsAppClientCore",
    "ClientAccountState",
    "ClientChatMessages",
    "ClientNamespace",
    "fanout",
  ]) {
    assert.equal(
      new RegExp(`\\b${modulePrivate}\\b`).test(declarations),
      false,
      `${modulePrivate} must not reach the packed declarations`,
    );
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
      assert.equal(typeof root.createInProcessWhatsAppClient, "function");
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
      for (const removed of ["createChannelAdapter", "bindTools", "createWhatsAppClient"]) {
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
