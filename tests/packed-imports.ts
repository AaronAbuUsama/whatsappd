import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertPackedProofReceiptSanitized } from "./packed-proof-receipt.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-packed-"));
const README_FENCE_MARKER = "<!-- packed-client-typecheck -->";

const EXPECTED_ROOT_EXPORTS = [
  "AcceptedWhatsAppBatch",
  "AccountAlreadyClaimedError",
  "AccountAlreadyLinkedError",
  "AccountLease",
  "AccountLeaseStore",
  "AccountNotHeldError",
  "AccountNotLinkedError",
  "AccountRecord",
  "AuthStrategy",
  "Awaitable",
  "BinaryInput",
  "ChatRecord",
  "ClientAccountState",
  "ClientChatMessages",
  "ClientNamespace",
  "ClientOperationOptions",
  "ClientPairInput",
  "ClientSendOptions",
  "ContactRecord",
  "ContactUpdate",
  "ConversationSyncBatch",
  "ConversationSyncContext",
  "ConversationSyncSource",
  "CredentialStore",
  "Disposition",
  "DurableInboundMessage",
  "DurableMedia",
  "DurableMediaInput",
  "DurableOutbound",
  "DurableUpdate",
  "FaultReason",
  "FileMediaStoreOptions",
  "GroupMetadata",
  "GroupParticipant",
  "GroupParticipantAction",
  "GroupRecord",
  "GroupUpdate",
  "HistoryChat",
  "HistoryContact",
  "InboundMessage",
  "LibsqlBackend",
  "LibsqlBackendOptions",
  "MediaHandle",
  "MediaMeta",
  "MediaOutbound",
  "MediaStore",
  "MessageContext",
  "MessageFlags",
  "MessageHandlerContext",
  "MessageReaction",
  "MessageReceipt",
  "MessageRecord",
  "MessageRef",
  "MetricEvent",
  "MetricsHook",
  "MirrorAlias",
  "MirrorRecord",
  "ObservedInstant",
  "OperationClock",
  "OperationIdempotencyConflictError",
  "Outbound",
  "PairingError",
  "PairingOperation",
  "PairingState",
  "PresenceKind",
  "PresenceUpdate",
  "ReceiptStatus",
  "RuntimeSession",
  "SendOptions",
  "SerializedOperationError",
  "SessionConfig",
  "StaleAccountClaimError",
  "Status",
  "StoredMessageCursor",
  "StoredMessagePage",
  "StoredMessagePageOptions",
  "SyncState",
  "Unsubscribe",
  "UnsupportedDurableEventError",
  "Update",
  "WaIdentity",
  "WhatsAppAddress",
  "WhatsAppBackend",
  "WhatsAppClient",
  "WhatsAppClientConnectionState",
  "WhatsAppDataEvent",
  "WhatsAppDataStore",
  "WhatsAppDurableEvent",
  "WhatsAppFault",
  "WhatsAppLinkState",
  "WhatsAppOperation",
  "WhatsAppOperationInput",
  "WhatsAppOperationState",
  "WhatsAppOperationStore",
  "WhatsAppRuntime",
  "WhatsAppRuntimeConfig",
  "WhatsAppSession",
  "WhatsAppSessionHandlers",
  "assertE164",
  "classifyDisconnect",
  "createSession",
  "createWhatsAppClient",
  "createWhatsAppRuntime",
  "dispositionFor",
  "fileMediaStore",
  "fileStore",
  "isOnline",
  "isRetryable",
  "isTerminal",
  "libsqlBackend",
  "memoryBackend",
  "memoryDataStore",
  "memoryLeaseStore",
  "memoryMediaStore",
  "memoryOperationStore",
  "memoryStore",
  "pairingAuth",
  "qrAuth",
  "refOf",
] as const;

const filesUnder = async (entry: string): Promise<readonly string[]> => {
  const info = await stat(entry);
  if (info.isFile()) return [entry];
  assert.ok(info.isDirectory(), `${entry} must be a file or directory`);
  return (
    await Promise.all((await readdir(entry)).map((child) => filesUnder(path.join(entry, child))))
  ).flat();
};

const assertNoRetiredConversationHandle = async (
  artifacts: readonly string[],
  packedDeclarations: string,
): Promise<void> => {
  const conversationType = new RegExp(["WhatsApp", "Conversation"].join(""));
  const chatsOpen = new RegExp(["chats", String.raw`\s*\.\s*`, "open", String.raw`\s*\(`].join(""));
  const canaryType = ["WhatsApp", "Conversation"].join("");
  const canaryOpen = ["chats", ".open("].join("");
  assert.equal(conversationType.test(canaryType), true, "conversation type scanner is blind");
  assert.equal(chatsOpen.test(canaryOpen), true, "chat-open scanner is blind");
  assert.ok(artifacts.length > 0, "no repository artifacts were scanned");

  for (const artifact of artifacts) {
    const source = await readFile(artifact, "utf8");
    assert.equal(
      conversationType.test(source),
      false,
      `${path.relative(root, artifact)} reintroduced the retired conversation type`,
    );
    assert.equal(
      chatsOpen.test(source),
      false,
      `${path.relative(root, artifact)} reintroduced the retired chat-open handle`,
    );
  }
  assert.equal(
    conversationType.test(packedDeclarations),
    false,
    "packed declarations reintroduced the retired conversation type",
  );
  assert.equal(
    chatsOpen.test(packedDeclarations),
    false,
    "packed declarations reintroduced the retired chat-open handle",
  );
};

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

const readmeClientSource = async (): Promise<string> => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const marker = readme.indexOf(README_FENCE_MARKER);
  assert.notEqual(marker, -1, "README is missing the packed Client fence marker");
  const opening = readme.indexOf("```ts\n", marker);
  assert.notEqual(opening, -1, "README Client example has no TypeScript fence");
  const sourceStart = opening + "```ts\n".length;
  const closing = readme.indexOf("\n```", sourceStart);
  assert.notEqual(closing, -1, "README Client example has no closing fence");
  const source = `${readme.slice(sourceStart, closing)}\n`;
  assert.match(source, /\bconst c: WhatsAppClient = client;/);
  return source;
};

const runtimeJSDocSource = async (): Promise<string> => {
  const runtimeSource = await readFile(path.join(root, "src/runtime/runtime.ts"), "utf8");
  const declaration = runtimeSource.indexOf("export function createWhatsAppRuntime");
  assert.notEqual(declaration, -1, "createWhatsAppRuntime declaration is missing");
  const commentStart = runtimeSource.lastIndexOf("/**", declaration);
  assert.notEqual(commentStart, -1, "createWhatsAppRuntime has no public JSDoc");
  const comment = runtimeSource.slice(commentStart, declaration);
  const example = comment.indexOf("* @example");
  assert.notEqual(example, -1, "createWhatsAppRuntime JSDoc has no example");
  const opening = comment.indexOf("* ```ts\n", example);
  assert.notEqual(opening, -1, "createWhatsAppRuntime example has no TypeScript fence");
  const sourceStart = opening + "* ```ts\n".length;
  const closing = comment.indexOf("\n * ```", sourceStart);
  assert.notEqual(closing, -1, "createWhatsAppRuntime example has no closing fence");
  const source = comment
    .slice(sourceStart, closing)
    .split("\n")
    .map((line) => line.replace(/^ \* ?/u, ""))
    .join("\n");
  assert.match(source, /\bawait createWhatsAppClient\(runtime\);/u);
  return `import {
  createSession,
  createWhatsAppClient,
  createWhatsAppRuntime,
  memoryBackend,
  qrAuth,
} from "whatsappd";

${source}
`;
};

interface PackedScenarioReceipt {
  readonly pid: number;
  readonly mode: "write" | "read";
  readonly durableDigest: string;
  readonly durableDigests: Readonly<Record<string, string>>;
  readonly accountDurable: {
    readonly accountId: string;
    readonly lastConnectedAt?: number;
    readonly lastDisconnectedAt?: number;
  };
  readonly pageMessageCount: number;
  readonly mediaDigest: string;
  readonly connectionPresent: boolean;
  readonly identityPresent: boolean;
  readonly presenceRestored: boolean;
  readonly liveConnectionPresent: boolean;
  readonly liveIdentityPresent: boolean;
  readonly livePresenceObserved: boolean;
  readonly closeOrder: readonly ("client" | "runtime" | "backend")[];
  readonly envKeys: readonly string[];
}

const assertExplicitEnvironment = (
  receipt: PackedScenarioReceipt,
  allowedEnvironment: Readonly<Record<string, string>>,
): void => {
  const allowedKeys = new Set([...Object.keys(allowedEnvironment), "__CF_USER_TEXT_ENCODING"]);
  assert.deepEqual(
    receipt.envKeys.filter((key) => !allowedKeys.has(key)),
    [],
    "the packed child received a parent environment key outside the explicit allowlist",
  );
};

const runPackedScenario = async (
  mode: PackedScenarioReceipt["mode"],
  directory: string,
  salt: string,
): Promise<PackedScenarioReceipt> => {
  const allowedEnvironment = {
    ...(process.env.HOME && { HOME: process.env.HOME }),
    ...(process.env.PATH && { PATH: process.env.PATH }),
    ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
    PACKED_SCENARIO_DIRECTORY: directory,
    PACKED_SCENARIO_MODE: mode,
    PACKED_SCENARIO_SALT: salt,
  };
  const { stdout, stderr } = await execFile(process.execPath, ["packed-consumer-scenario.mjs"], {
    cwd: consumer,
    env: allowedEnvironment,
  });
  assert.equal(stderr, "", `packed ${mode} child wrote diagnostics`);
  const receipt = JSON.parse(stdout) as PackedScenarioReceipt;
  assert.throws(
    () =>
      assertExplicitEnvironment(
        { ...receipt, envKeys: [...receipt.envKeys, "PACKED_PARENT_CANARY"] },
        allowedEnvironment,
      ),
    /outside the explicit allowlist/,
  );
  assertExplicitEnvironment(receipt, allowedEnvironment);
  return receipt;
};

const assertPackedReconstruction = (
  first: PackedScenarioReceipt,
  second: PackedScenarioReceipt,
): void => {
  assert.notEqual(first.pid, second.pid, "packed reconstruction reused one OS process");
  assert.deepEqual(
    first.accountDurable,
    second.accountDurable,
    "the replacement reconstructed different durable account state",
  );
  assert.deepEqual(
    first.durableDigests,
    second.durableDigests,
    "the replacement reconstructed different durable namespace state",
  );
  assert.equal(
    first.durableDigest,
    second.durableDigest,
    "the replacement reconstructed a different durable digest",
  );
  assert.equal(first.pageMessageCount, second.pageMessageCount);
  assert.equal(first.mediaDigest, second.mediaDigest);
  assert.equal(first.liveConnectionPresent, true, "the live Client never observed a connection");
  assert.equal(first.liveIdentityPresent, true, "the live Client never observed an identity");
  assert.equal(first.livePresenceObserved, true, "the live Client never observed presence");
  assert.deepEqual(
    first.closeOrder,
    ["client", "runtime", "backend"],
    "the write child did not close in application-owned order",
  );
  assert.deepEqual(
    second.closeOrder,
    ["client", "runtime", "backend"],
    "the replacement did not close in application-owned order",
  );
  assert.equal(second.connectionPresent, false, "the replacement reconstructed a connection");
  assert.equal(second.identityPresent, false, "the replacement reconstructed an identity");
  assert.equal(second.presenceRestored, false, "the replacement reconstructed presence");
};

try {
  const packedReceiptScan = assertPackedProofReceiptSanitized(
    JSON.parse(
      await readFile(path.join(root, ".proof-receipts/issue107-p6.run1-906e1b2.json"), "utf8"),
    ),
  );
  await execFile("pnpm", ["pack", "--pack-destination", consumer], { cwd: root });
  const archive = (await readdir(consumer)).find((file) => file.endsWith(".tgz"));
  assert.ok(archive, "pnpm pack did not produce an archive");
  const { stdout: tarList } = await execFile("tar", ["tzf", path.join(consumer, archive)]);
  const packedFiles = tarList
    .trim()
    .split("\n")
    .map((file) => file.replace(/^package\//u, ""))
    .sort();
  const intendedRootFiles = ["CHANGELOG.md", "LICENSE", "README.md", "package.json"];
  for (const file of packedFiles)
    assert.ok(
      file.startsWith("dist/") || intendedRootFiles.includes(file),
      `unexpected packed file: ${file}`,
    );
  for (const file of intendedRootFiles)
    assert.ok(packedFiles.includes(file), `required packed file is missing: ${file}`);
  assert.ok(
    packedFiles.some((file) => file.startsWith("dist/")),
    "the tarball contains no dist artifacts",
  );

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
  const installedPackage = await realpath(path.join(consumer, "node_modules/whatsappd"));
  assert.equal(
    installedPackage.startsWith(`${root}${path.sep}`),
    false,
    "the fresh consumer resolved whatsappd from the workspace instead of its packed node_modules",
  );

  const readmeSource = await readmeClientSource();
  await writeFile(path.join(consumer, "readme-client.ts"), readmeSource);
  await writeFile(path.join(consumer, "runtime-javadoc.ts"), await runtimeJSDocSource());
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      files: ["readme-client.ts", "runtime-javadoc.ts"],
    }),
  );
  const compiler = path.join(root, "node_modules/.bin/tsgo");
  const invalidReadmeSource = readmeSource.replace(
    "const c: WhatsAppClient = client;",
    "const c: WhatsAppClient = 1;",
  );
  assert.notEqual(
    invalidReadmeSource,
    readmeSource,
    "README typecheck control did not alter source",
  );
  await writeFile(path.join(consumer, "readme-client.ts"), invalidReadmeSource);
  await assert.rejects(
    execFile(compiler, ["--noEmit", "--project", "tsconfig.json"], { cwd: consumer }),
    (error: unknown) => {
      const diagnostics =
        error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
      return /TS2322/u.test(diagnostics);
    },
    "the consumer typecheck did not reject an invalid README-derived assignment",
  );
  await writeFile(path.join(consumer, "readme-client.ts"), readmeSource);
  const typecheck = await execFile(compiler, ["--noEmit", "--project", "tsconfig.json"], {
    cwd: consumer,
  });
  assert.equal(typecheck.stdout, "", "the README consumer typecheck wrote diagnostics");
  assert.equal(typecheck.stderr, "", "the README consumer typecheck wrote diagnostics");
  await writeFile(
    path.join(consumer, "challenge-access.ts"),
    `import { memoryBackend } from "whatsappd";
memoryBackend().pairingChallenges.consume("account", "challenge");
`,
  );
  await writeFile(
    path.join(consumer, "challenge-access-tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      files: ["challenge-access.ts"],
    }),
  );
  await assert.rejects(
    execFile(compiler, ["--noEmit", "--project", "challenge-access-tsconfig.json"], {
      cwd: consumer,
    }),
    (error: unknown) => {
      const diagnostics =
        error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
      return /TS2339/u.test(diagnostics) && /pairingChallenges/u.test(diagnostics);
    },
    "the packed Backend still exposes its raw pairing challenge store",
  );

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
  const rootDeclarations = await readFile(path.join(dist, "index.d.mts"), "utf8");
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

  const rootSource = ts.createSourceFile(
    "index.d.mts",
    rootDeclarations,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rootExportClauses = rootSource.statements.filter(
    (statement): statement is ts.ExportDeclaration =>
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause),
  );
  assert.equal(rootExportClauses.length, 1, "the generated root must have one export clause");
  const rootExportClause = rootExportClauses[0];
  assert.ok(rootExportClause?.exportClause && ts.isNamedExports(rootExportClause.exportClause));
  const rootExportNames = rootExportClause.exportClause.elements.map(
    (element) => element.name.text,
  );
  assert.deepEqual(
    rootExportNames.sort(),
    [...EXPECTED_ROOT_EXPORTS],
    "the generated root export clause drifted from the reviewed public surface",
  );
  const rootExportNameSet = new Set(rootExportNames);
  for (const privatePairingExport of [
    "ConsumedPairingChallenge",
    "PairingChallenge",
    "PairingChallengeStore",
    "memoryPairingChallengeStore",
  ])
    assert.equal(
      rootExportNameSet.has(privatePairingExport),
      false,
      `${privatePairingExport} must not be exported from the package root`,
    );
  for (const requiredPublicClientExport of [
    "createWhatsAppClient",
    "ClientAccountState",
    "ClientChatMessages",
    "ClientNamespace",
  ])
    assert.equal(
      rootExportNameSet.has(requiredPublicClientExport),
      true,
      `${requiredPublicClientExport} must be exported from the package root`,
    );

  const declarationSource = ts.createSourceFile(
    "packed.d.mts",
    declarations,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaredNames = new Set<string>();
  for (const statement of declarationSource.statements) {
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      if (statement.name) declaredNames.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) declaredNames.add(declaration.name.text);
    }
  }
  const clientDeclarations = declarationSource.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "WhatsAppClient",
  );
  assert.equal(
    clientDeclarations.length,
    1,
    "the packed declarations must contain exactly one WhatsAppClient interface",
  );
  const clientDeclaration = clientDeclarations[0];
  assert.ok(clientDeclaration);
  const clientMembers = clientDeclaration.members.map((member) => {
    assert.ok(member.name && ts.isIdentifier(member.name), "Client members must be named");
    return member.name.text;
  });
  assert.deepEqual(
    clientMembers.sort(),
    ["account", "chats", "close", "contacts", "groups", "messages", "operations"],
    "WhatsAppClient must expose the friendly namespaces, operation accessor, and close",
  );
  assert.equal(clientMembers.includes("watch"), false);
  for (const rawContract of [
    "WhatsAppDurableFrame",
    "WhatsAppLiveFrame",
    "WhatsAppClientFrame",
    "WhatsAppPatch",
    "WhatsAppSnapshot",
    "MirrorView",
    "StoredMessageCursor",
  ]) {
    for (const member of clientDeclaration.members)
      assert.equal(
        new RegExp(`\\b${rawContract}\\b`).test(member.getText(declarationSource)),
        false,
        `WhatsAppClient.${member.name?.getText(declarationSource)} must not expose ${rawContract}`,
      );
  }

  for (const removedDeclaration of [
    "createInProcessWhatsAppClient",
    "WhatsAppClientFrame",
    "WhatsAppDurableFrame",
    "WhatsAppLiveFrame",
    "WhatsAppPatch",
    "WhatsAppSnapshot",
    "MirrorView",
  ]) {
    assert.equal(
      declaredNames.has(removedDeclaration),
      false,
      `${removedDeclaration} must not reach the packed declarations`,
    );
  }

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
  // parameter or a public `runtime.read()` (ADR-0030). None of that source is a
  // published contract. `RuntimeSession.identity` is deliberately not in this
  // list: an application supplies its own session, so that capability has to
  // be declarable.
  for (const modulePrivate of [
    "ClientRuntimeSource",
    "clientSourceFor",
    "ClientClaim",
    "currentClaim",
    "WhatsAppClientCore",
    "fanout",
  ]) {
    assert.equal(
      declaredNames.has(modulePrivate),
      false,
      `${modulePrivate} must not reach the packed declarations`,
    );
  }
  await assertNoRetiredConversationHandle(
    (
      await Promise.all(
        ["src", "tests", ".changeset", ".proof-receipts", "README.md", "CHANGELOG.md"].map(
          (entry) => filesUnder(path.join(root, entry)),
        ),
      )
    ).flat(),
    declarations,
  );
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
      import {
        createSession,
        createWhatsAppClient,
        createWhatsAppRuntime,
        fileMediaStore,
        fileStore,
        libsqlBackend,
        memoryBackend,
        memoryStore,
        pairingAuth,
        qrAuth,
      } from "whatsappd";
      import {
        createTestWhatsAppRuntime,
        createTestWhatsAppSession,
      } from "whatsappd/testing";

      assert.equal(typeof createSession, "function");
      assert.equal(typeof createTestWhatsAppRuntime, "function");
      assert.equal(typeof createTestWhatsAppSession, "function");
      assert.equal(typeof fileStore, "function");
      assert.equal(typeof memoryStore, "function");
      assert.equal(typeof pairingAuth, "function");
      assert.equal(typeof qrAuth, "function");
      assert.equal(typeof createWhatsAppRuntime, "function");
      assert.equal(typeof createWhatsAppClient, "function");
      assert.equal(typeof memoryBackend, "function");
      assert.equal(typeof libsqlBackend, "function");
      assert.equal(typeof fileMediaStore, "function");
      const media = fileMediaStore({ directory: "./media" });
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
      const backend = libsqlBackend({
        url: "file:./not-opened.db",
        accountId: "personal",
        media: root.memoryMediaStore(),
      });
      assert.equal(typeof backend.close, "function");
      await backend.close();
      for (const removed of [
        "createChannelAdapter",
        "bindTools",
        "createInProcessWhatsAppClient",
        "memoryPairingChallengeStore",
      ]) {
        assert.equal(removed in root, false);
      }
      for (const subpath of ["adapters/eve", "channel", "sidecar", "stores/libsql", "stores/memory", "tools"]) {
        await assert.rejects(import(\`whatsappd/\${subpath}\`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      }
    `,
  );
  await execFile(process.execPath, ["verify.mjs"], { cwd: consumer });

  await writeFile(
    path.join(consumer, "packed-consumer-scenario.mjs"),
    await readFile(path.join(root, "tests/packed-consumer-scenario.mjs")),
  );
  const scenarioDirectory = path.join(consumer, "scenario-state");
  const scenarioSalt = randomBytes(16).toString("hex");
  const first = await runPackedScenario("write", scenarioDirectory, scenarioSalt);
  const second = await runPackedScenario("read", scenarioDirectory, scenarioSalt);
  assertPackedReconstruction(first, second);
  assert.throws(
    () => assertPackedReconstruction(first, { ...second, pid: first.pid }),
    /reused one OS process/,
  );
  assert.throws(
    () =>
      assertPackedReconstruction(first, {
        ...second,
        durableDigest: first.durableDigest.replace(/^./u, (head) => (head === "0" ? "1" : "0")),
      }),
    /different durable digest/,
  );
  assert.throws(
    () => assertPackedReconstruction(first, { ...second, connectionPresent: true }),
    /reconstructed a connection/,
  );
  process.stdout.write(
    `${JSON.stringify({
      packedConsumer: {
        typecheckDiagnostics: 0,
        source: "README.md#packed-client-typecheck",
        packageResolvedThroughNodeModules: true,
      },
      reconstruction: {
        firstPid: first.pid,
        secondPid: second.pid,
        distinctPids: true,
        durableDigest: second.durableDigest,
        durableDigestEqual: true,
        pageMessageCount: second.pageMessageCount,
        mediaDigest: second.mediaDigest,
        connectionPresent: second.connectionPresent,
        identityPresent: second.identityPresent,
        presenceRestored: second.presenceRestored,
        explicitEnvironmentAllowlist: true,
        closeOrder: second.closeOrder,
        liveStatePositiveControls: {
          connectionPresent: first.liveConnectionPresent,
          identityPresent: first.liveIdentityPresent,
          presenceObserved: first.livePresenceObserved,
        },
      },
      receiptSanitization: packedReceiptScan,
    })}\n`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
