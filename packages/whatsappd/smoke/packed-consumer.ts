import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reactPackageRoot = path.resolve(packageRoot, "../react");
const root = path.resolve(packageRoot, "../..");
const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-packed-"));
const registry = process.argv.includes("--registry");
const coreVersion = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
  .version as string;
const reactVersion = JSON.parse(await readFile(path.join(reactPackageRoot, "package.json"), "utf8"))
  .version as string;
assert.equal(reactVersion, coreVersion);

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
  let coreDependency = coreVersion;
  let reactDependency = reactVersion;
  if (!registry) {
    await execFile("pnpm", ["pack", "--pack-destination", consumer], { cwd: packageRoot });
    await execFile("pnpm", ["pack", "--pack-destination", consumer], { cwd: reactPackageRoot });
    const archives = await readdir(consumer);
    const archive = archives.find((file) => file.startsWith("whatsappd-") && file.endsWith(".tgz"));
    const reactArchive = archives.find(
      (file) => file.startsWith("whatsappd-react-") && file.endsWith(".tgz"),
    );
    assert.ok(archive, "pnpm pack did not produce an archive");
    assert.ok(reactArchive, "pnpm pack did not produce a React archive");
    coreDependency = `file:./${archive}`;
    reactDependency = `file:./${reactArchive}`;
  }

  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@whatsappd/react": reactDependency,
        "@libsql/client": "0.15.15",
        "@types/node": "^26.1.1",
        react: "19.2.8",
        typescript: "^6.0.3",
        whatsappd: coreDependency,
      },
    }),
  );
  await execFile(
    "pnpm",
    ["install", "--ignore-scripts", ...(registry ? ["--config.prefer-online=true"] : [])],
    { cwd: consumer },
  );

  const snippets = (await readdir(path.join(root, "apps/docs/snippets"))).filter((file) =>
    file.endsWith(".ts"),
  );
  await Promise.all(
    snippets.map((file) =>
      copyFile(path.join(root, "apps/docs/snippets", file), path.join(consumer, file)),
    ),
  );
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
        types: ["node"],
      },
      files: snippets,
    }),
  );
  await execFile("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumer });

  const packageJson = JSON.parse(
    await readFile(path.join(consumer, "node_modules/whatsappd/package.json"), "utf8"),
  ) as {
    readonly version: string;
    readonly bin?: unknown;
    readonly exports: Record<string, unknown>;
  };
  assert.equal(packageJson.bin, undefined);
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [
    ".",
    "./convex",
    "./package.json",
    "./testing",
  ]);
  const reactPackageJson = JSON.parse(
    await readFile(path.join(consumer, "node_modules/@whatsappd/react/package.json"), "utf8"),
  ) as { readonly exports: Record<string, unknown> };
  assert.deepEqual(Object.keys(reactPackageJson.exports).sort(), [
    ".",
    "./package.json",
    "./subscribe",
  ]);
  const reactDeclarations = await readFile(
    path.join(consumer, "node_modules/@whatsappd/react/dist/index.d.mts"),
    "utf8",
  );
  for (const rendererOwned of ["HTMLElement", "@opentui", "next/", "shadcn", "tailwind"]) {
    assert.equal(reactDeclarations.includes(rendererOwned), false);
  }
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
  // A previous packed proof missed this condition, so the file has to prove it is
  // looking at real declarations first.
  assert.ok(declarations.length > 0, "no packed declarations were read");
  // The root entry's own list, not the first one across every `.d.mts`. The
  // package has more than one entry point now, and `dist/convex.d.mts` sorts
  // ahead of `dist/index.d.mts` -- reading whichever came first would check the
  // Convex entry's exports and call them the package root's.
  const rootExports = (await readFile(path.join(dist, "index.d.mts"), "utf8")).match(
    /export \{([^]*?)\};/,
  );
  assert.ok(rootExports, "packed root export list was not found");
  const exported = new Set(
    [...rootExports[1].matchAll(/(?:^|,)\s*(?:type\s+)?([A-Za-z_$][\w$]*)/g)].map(
      ([, name]) => name,
    ),
  );
  for (const name of [
    "ClientAccountState",
    "ClientChatMessages",
    "ClientNamespace",
    "ClientOperationOptions",
    "ClientSendOptions",
    "ClientSubscribeOptions",
    "OperationIdempotencyConflictError",
    "OptimisticMessage",
    "TerminalWhatsAppOperation",
    "WhatsAppOperation",
    "WhatsAppClient",
    "createWhatsAppClient",
  ]) {
    assert.equal(exported.has(name), true, `${name} must be exported from the package root`);
  }
  for (const name of [
    "MirrorView",
    "WhatsAppClientConnectionState",
    "WhatsAppClientCore",
    "WhatsAppClientFrame",
    "WhatsAppDurableFrame",
    "WhatsAppLiveFrame",
    "WhatsAppPatch",
    "WhatsAppSnapshot",
    "createInProcessWhatsAppClient",
  ]) {
    assert.equal(exported.has(name), false, `${name} must not be exported from the package root`);
  }
  const friendlyClient = declarations.match(/interface WhatsAppClient \{([^]*?)\n\}/)?.[1];
  assert.ok(friendlyClient, "packed WhatsAppClient declaration was not found");
  assert.equal(/\bwatch\s*\(/.test(friendlyClient), false);
  for (const member of [
    "account",
    "chats",
    "contacts",
    "groups",
    "messages",
    "operations",
    "close",
  ]) {
    assert.match(friendlyClient, new RegExp(`\\b${member}\\b`));
  }
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
  // upgrade.
  const packedDist = await digests(dist);
  await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
  await execFile("pnpm", ["build"], { cwd: root });
  assert.deepEqual(
    packedDist,
    await digests(path.join(packageRoot, "dist")),
    "the installed dist/ is not this working tree's build",
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
    "fanout",
  ]) {
    assert.equal(
      exported.has(modulePrivate),
      false,
      `${modulePrivate} must not be exported from the package root`,
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
      import { createHash } from "node:crypto";
      import { createRequire } from "node:module";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import * as root from "whatsappd";
      import * as reactBindings from "@whatsappd/react";
      import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";

      const ACCOUNT = "packed";
      const CHAT = "packed-person@s.whatsapp.net";
      const ROOM = "packed-room@g.us";
      const AT = 1_700_000_000_000;
      const DATA = path.resolve("data");
      const version = createRequire(import.meta.url)("whatsappd/package.json").version;
      let writeExecutions;

      assert.equal(typeof root.createSession, "function");
      assert.equal(typeof createTestWhatsAppSession, "function");
      assert.equal(typeof root.memoryStore, "function");
      assert.equal(typeof root.createWhatsAppRuntime, "function");
      assert.equal(typeof root.createWhatsAppClient, "function");
      assert.equal(typeof reactBindings.createWhatsAppBindings, "function");
      assert.equal(typeof reactBindings.subscribeWhatsAppClient, "function");
      assert.equal("createInProcessWhatsAppClient" in root, false);
      assert.equal(typeof root.memoryBackend, "function");
      assert.equal(typeof root.libsqlBackend, "function");
      assert.equal(typeof root.fileMediaStore, "function");
      assert.equal(typeof root.memoryOperationStore, "function");
      assert.equal(typeof root.OperationIdempotencyConflictError, "function");
      for (const removed of ["createChannelAdapter", "bindTools"]) {
        assert.equal(removed in root, false);
      }
      for (const subpath of ["adapters/eve", "channel", "sidecar", "stores/libsql", "stores/memory", "tools"]) {
        await assert.rejects(import(\`whatsappd/\${subpath}\`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      }

      const backend = () => root.libsqlBackend({
        url: pathToFileURL(path.join(DATA, "whatsapp.db")).href,
        accountId: ACCOUNT,
        media: root.fileMediaStore({ directory: path.join(DATA, "media") }),
      });

      const page = (client, expected) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("packed Client page did not land")), 5_000);
        const off = client.messages.subscribe(() => {
          const view = client.messages.get(CHAT);
          if (view.older === "loading" || view.messages.length < expected) return;
          clearTimeout(timeout);
          off();
          resolve(view);
        });
        client.messages.older(CHAT);
      });

      const durable = (client) => {
        const value = {
          account: client.account.get(),
          chats: client.chats.list(),
          contacts: client.contacts.list(),
          groups: client.groups.list(),
          messages: client.messages.get(CHAT),
        };
        return {
          hash: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
          counts: {
            chats: value.chats.length,
            contacts: value.contacts.length,
            groups: value.groups.length,
            messages: value.messages.messages.length,
          },
          noLive: {
            connection: value.account.connection === undefined,
            identity: value.account.identity === undefined,
            presence: client.contacts.presence(CHAT) === undefined,
          },
        };
      };

      const cold = async () => {
        const store = backend();
        const runtime = root.createWhatsAppRuntime({
          accountId: ACCOUNT,
          backend: store,
          openSession: () => { throw new Error("cold reconstruction must not open a session"); },
        });
        const client = await root.createWhatsAppClient(runtime);
        try {
          await page(client, 25);
          await page(client, 30);
          const result = durable(client);
          const operation = (await store.operations.list(ACCOUNT)).find(
            (candidate) => candidate.idempotencyKey === "packed-outbound",
          );
          assert.equal(operation?.state.status, "succeeded");
          assert.equal(typeof operation.acknowledgedAt, "number");
          assert.ok(operation.input.type === "send" && "image" in operation.input.content);
          const media = await store.media.open({
            accountId: ACCOUNT,
            ref: operation.input.content.image.ref,
          });
          assert.ok(media);
          const mediaHash = createHash("sha256");
          for await (const chunk of media) mediaHash.update(chunk);
          assert.equal(
            mediaHash.digest("hex"),
            createHash("sha256").update("packed outbound").digest("hex"),
          );
          assert.deepEqual(result.counts, { chats: 2, contacts: 1, groups: 1, messages: 30 });
          assert.deepEqual(result.noLive, { connection: true, identity: true, presence: true });
          return {
            ...result,
            operation: {
              idempotencyKey: operation.idempotencyKey,
              status: operation.state.status,
              acknowledged: operation.acknowledgedAt !== undefined,
              revision: operation.revision,
            },
          };
        } finally {
          await client.close();
          await runtime.stop();
          await store.close();
        }
      };

      if (process.argv[2] === "write") {
        const store = backend();
        const driver = createTestWhatsAppSession();
        const runtime = root.createWhatsAppRuntime({
          accountId: ACCOUNT,
          backend: store,
          openSession: () => driver.session,
        });
        await runtime.start();
        const media = store.media;
        const stored = await media.write({
          accountId: ACCOUNT,
          owner: {
            type: "message",
            message: { id: "packed-media", chatId: CHAT, fromMe: false },
          },
          kind: "document",
          source: (async function* () { yield Uint8Array.from([1, 2, 3]); })(),
        });
        const opened = await media.open({ accountId: ACCOUNT, ref: stored.ref });
        assert.ok(opened);
        const chunks = [];
        for await (const chunk of opened) chunks.push(...chunk);
        assert.deepEqual(Uint8Array.from(chunks), Uint8Array.from([1, 2, 3]));
        await driver.emit({ type: "connection", status: { phase: "online" } });
        await driver.emit({
          type: "conversation_sync",
          batch: {
            context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
            chats: [
              { id: CHAT, lastMessageAt: AT + 29 },
              { id: ROOM, isGroup: true, subject: "Packed room", lastMessageAt: AT },
            ],
            contacts: [{ id: CHAT, nativeIds: [CHAT], displayName: "Packed contact" }],
            messages: Array.from({ length: 30 }, (_, index) => ({
              ...textMessage({
                id: "packed-" + String(index).padStart(2, "0"),
                chatId: CHAT,
                text: "message " + index,
                timestamp: AT + index,
              }),
              live: false,
            })),
          },
        });
        const client = await root.createWhatsAppClient(runtime);
        try {
          assert.equal(client.account.get().accountId, ACCOUNT);
          assert.equal(client.chats.list().length, 2);
          assert.equal(client.contacts.list().length, 1);
          assert.equal(client.groups.list().length, 1);
          assert.equal(client.messages.get(CHAT).messages.length, 0);
          await page(client, 25);
          const finalPage = await page(client, 30);
          assert.equal(finalPage.older, "exhausted");
          assert.equal(driver.commands.historyRequests.length, 0);
          await driver.emit({ type: "connection", status: { phase: "disconnected" } });
          const operation = await client.messages.send.image(CHAT, Buffer.from("packed outbound"), {
            idempotencyKey: "packed-outbound",
          });
          assert.equal(operation.idempotencyKey, "packed-outbound");
          assert.equal(operation.state.status, "queued");
          const repeated = await client.messages.send.image(CHAT, Buffer.from("packed outbound"), {
            idempotencyKey: "packed-outbound",
          });
          assert.equal(repeated.id, operation.id);
          assert.equal(driver.commands.sent.length, 0);
          assert.equal(client.messages.get(CHAT).outgoing.length, 1);
          writeExecutions = driver.commands.sent.length;
        } finally {
          await client.close();
          await runtime.stop();
          await store.close();
        }
      }
      if (process.argv[2] === "execute") {
        const store = backend();
        const driver = createTestWhatsAppSession();
        const runtime = root.createWhatsAppRuntime({
          accountId: ACCOUNT,
          backend: store,
          openSession: () => driver.session,
        });
        await runtime.start();
        const client = await root.createWhatsAppClient(runtime);
        try {
          const queued = (await store.operations.list(ACCOUNT)).find(
            (candidate) => candidate.idempotencyKey === "packed-outbound",
          );
          assert.equal(queued?.state.status, "queued");
          await driver.emit({ type: "connection", status: { phase: "online" } });
          assert.equal((await client.operations.wait(queued.id)).state.status, "succeeded");
          const repeated = await client.messages.send.image(CHAT, Buffer.from("packed outbound"), {
            idempotencyKey: "packed-outbound",
          });
          assert.equal(repeated.id, queued.id);
          assert.equal(driver.commands.sent.length, 1);
          await client.operations.acknowledge(queued.id);
          assert.equal(client.messages.get(CHAT).outgoing.length, 1);
          writeExecutions = driver.commands.sent.length;
        } finally {
          await client.close();
          await runtime.stop();
          await store.close();
        }
      }

      if (process.argv[2] === "write") {
        console.log(JSON.stringify({ pid: process.pid, version, writeExecutions }));
      } else {
        const result = await cold();
        console.log(JSON.stringify({ pid: process.pid, version, writeExecutions, ...result }));
      }
    `,
  );
  await mkdir(path.join(consumer, "data"));
  const childEnv = { PATH: process.env.PATH ?? "" };
  const submission = JSON.parse(
    (await execFile(process.execPath, ["verify.mjs", "write"], { cwd: consumer, env: childEnv }))
      .stdout,
  ) as {
    readonly pid: number;
    readonly version: string;
    readonly hash?: string;
    readonly counts?: Record<string, number>;
    readonly noLive?: Record<string, boolean>;
    readonly writeExecutions?: number;
    readonly operation: {
      readonly idempotencyKey: string;
      readonly status: string;
      readonly acknowledged: boolean;
      readonly revision: number;
    };
  };
  const first = JSON.parse(
    (await execFile(process.execPath, ["verify.mjs", "execute"], { cwd: consumer, env: childEnv }))
      .stdout,
  ) as Required<typeof submission>;
  const second = JSON.parse(
    (await execFile(process.execPath, ["verify.mjs", "read"], { cwd: consumer, env: childEnv }))
      .stdout,
  ) as typeof first;
  assert.notEqual(submission.pid, first.pid, "packed execution must replace submission process");
  assert.notEqual(first.pid, second.pid, "packed replacement must run in a new process");
  assert.equal(submission.version, packageJson.version);
  assert.equal(submission.writeExecutions, 0);
  assert.equal(first.version, packageJson.version);
  assert.equal(second.version, packageJson.version);
  assert.equal(first.hash, second.hash, "packed replacement reconstructed different durable state");
  assert.deepEqual(first.counts, second.counts);
  assert.deepEqual(second.noLive, { connection: true, identity: true, presence: true });
  assert.equal(first.writeExecutions, 1);
  assert.deepEqual(first.operation, second.operation);

  const issueAt = process.argv.indexOf("--issue");
  const issue = issueAt === -1 ? 107 : Number(process.argv[issueAt + 1]);
  assert.ok(Number.isSafeInteger(issue) && issue > 0, "--issue requires a positive integer");
  const receipt = {
    schemaVersion: 1,
    issue,
    tier: "P2",
    packedVersion: packageJson.version,
    firstProcessId: first.pid,
    secondProcessId: second.pid,
    submissionProcessId: submission.pid,
    durableStateHash: first.hash,
    counts: first.counts,
    noLiveStateReconstructed: second.noLive,
    operationProof: {
      ...second.operation,
      writeExecutions: first.writeExecutions,
      resumedAfterProcessReplacement: true,
      reconstructedAfterExecution: true,
    },
  };
  const receiptAt = process.argv.indexOf("--receipt");
  if (receiptAt !== -1) {
    const destination = process.argv[receiptAt + 1];
    assert.ok(destination, "--receipt requires a destination");
    const { stdout: gitHead } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
    await writeFile(
      path.resolve(root, destination),
      JSON.stringify({ ...receipt, gitHead: gitHead.trim() }, undefined, 2) + "\n",
      { flag: "wx" },
    );
  }
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  await rm(consumer, { recursive: true, force: true });
}
