import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { qrAuth } from "../src/ports.ts";
import { createSession } from "../src/session.ts";
import { libsqlStore } from "../src/stores/libsql.ts";

const execFileAsync = promisify(execFile);

export interface LiveSessionResult {
  paired: boolean;
}

export type OpenLiveSession = (input: {
  credentialDb: string;
  account: string;
  pairingAllowed: boolean;
  signal: AbortSignal;
}) => Promise<LiveSessionResult>;

interface ProofDependencies {
  root: string;
  openLiveSession: OpenLiveSession;
}

interface PrivateConfig {
  sourceDb: string;
  credentialDb: string;
  account: string;
}

interface ProofReceipt {
  nonce: string;
  gitHead: string;
  tier: "P2" | "P4";
  sourceChecksumBefore: string;
  sourceChecksumAfter: string;
  snapshotChecksum: string;
  recordCount: number;
  orderedIdDigest: string;
  timestampBounds: { min: string | null; max: string | null };
  revisionBounds: { min: number | null; max: number | null } | null;
  snapshotRestarted: boolean;
  reconnected?: boolean;
}

export class PrivateProofInUseError extends Error {
  constructor() {
    super("another private P4 proof is already running");
    this.name = "PrivateProofInUseError";
  }
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(file: string): Promise<string> {
  return hash(await readFile(file));
}

async function sqlite(file: string, statement: string, readonly = false): Promise<string> {
  const { stdout } = await execFileAsync(
    "sqlite3",
    [...(readonly ? ["-readonly"] : []), file, statement],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  return stdout;
}

async function databaseHash(file: string): Promise<string> {
  return hash(await sqlite(file, ".dump", true));
}

async function gitHead(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

async function assertCleanExecutedTree(root: string, expectedHead?: string): Promise<string> {
  const before = await gitHead(root);
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).proof-receipts/**"],
    { cwd: root },
  );
  const after = await gitHead(root);
  if (before !== after || (expectedHead && before !== expectedHead)) {
    throw new Error("private proof requires the same git head");
  }
  if (stdout !== "") throw new Error("private proof requires a clean tracked worktree");
  return before;
}

async function readConfig(root: string): Promise<PrivateConfig> {
  const config = JSON.parse(
    await readFile(join(root, ".proof-private", "config.json"), "utf8"),
  ) as Partial<PrivateConfig>;
  if (
    typeof config.sourceDb !== "string" ||
    typeof config.credentialDb !== "string" ||
    typeof config.account !== "string" ||
    config.account === "" ||
    !isAbsolute(config.sourceDb) ||
    !isAbsolute(config.credentialDb)
  ) {
    throw new Error("private proof config requires absolute sourceDb, credentialDb, and account");
  }
  config.sourceDb = resolve(config.sourceDb);
  config.credentialDb = resolve(config.credentialDb);
  if (config.sourceDb === config.credentialDb) {
    throw new Error("sourceDb and credentialDb must be different exact paths");
  }
  return config as PrivateConfig;
}

async function oracle(
  snapshotDb: string,
): Promise<
  Pick<ProofReceipt, "recordCount" | "orderedIdDigest" | "timestampBounds" | "revisionBounds">
> {
  const ids = await sqlite(snapshotDb, "SELECT id FROM raw_event ORDER BY id;", true);
  const [count, minTimestamp, maxTimestamp] = (
    await sqlite(
      snapshotDb,
      "SELECT COUNT(*), COALESCE(MIN(ts), ''), COALESCE(MAX(ts), '') FROM raw_event;",
      true,
    )
  )
    .trim()
    .split("|");
  const hasRevision =
    (
      await sqlite(
        snapshotDb,
        "SELECT COUNT(*) FROM pragma_table_info('raw_event') WHERE name = 'revision';",
        true,
      )
    ).trim() === "1";
  const revision = hasRevision
    ? (
        await sqlite(
          snapshotDb,
          "SELECT COALESCE(MIN(revision), ''), COALESCE(MAX(revision), '') FROM raw_event;",
          true,
        )
      )
        .trim()
        .split("|")
    : undefined;
  return {
    recordCount: Number(count),
    orderedIdDigest: hash(ids),
    timestampBounds: { min: minTimestamp || null, max: maxTimestamp || null },
    revisionBounds: revision
      ? {
          min: revision[0] === "" ? null : Number(revision[0]),
          max: revision[1] === "" ? null : Number(revision[1]),
        }
      : null,
  };
}

async function prepareProof(
  root: string,
  tier: "P2" | "P4",
  proofHead: string,
): Promise<{ config: PrivateConfig; receipt: ProofReceipt }> {
  const privateDir = join(root, ".proof-private");
  const receiptDir = join(root, ".proof-receipts");
  const runDir = join(privateDir, "run");
  const snapshotDb = join(runDir, "corpus.db");
  const config = await readConfig(root);
  await mkdir(receiptDir, { recursive: true });
  await rm(join(receiptDir, `issue16-${tier.toLowerCase()}.json`), { force: true });
  const sourceChecksumBefore = await databaseHash(config.sourceDb);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  await sqlite(config.sourceDb, `.backup "${snapshotDb.replaceAll('"', '\\"')}"`, true);
  await sqlite(snapshotDb, "PRAGMA journal_mode = DELETE;");
  const beforeRestart = await oracle(snapshotDb);
  const quickCheck = (await sqlite(snapshotDb, "PRAGMA quick_check;", true)).trim();
  const afterRestart = await oracle(snapshotDb);
  const sourceChecksumAfter = await databaseHash(config.sourceDb);
  const snapshotRestarted =
    quickCheck === "ok" && JSON.stringify(beforeRestart) === JSON.stringify(afterRestart);
  if (!snapshotRestarted || sourceChecksumAfter !== sourceChecksumBefore) {
    throw new Error("P2 snapshot restart or source checksum proof failed");
  }
  const receipt: ProofReceipt = {
    nonce: randomUUID(),
    gitHead: proofHead,
    tier,
    sourceChecksumBefore,
    sourceChecksumAfter,
    snapshotChecksum: await fileHash(snapshotDb),
    ...afterRestart,
    snapshotRestarted,
  };
  return { config, receipt };
}

export async function runPrivateProof(
  tier: "p2" | "p4",
  confirmed: boolean,
  dependencies: ProofDependencies,
): Promise<ProofReceipt> {
  const proofHead = await assertCleanExecutedTree(dependencies.root);
  if (tier === "p2") {
    const { receipt } = await prepareProof(dependencies.root, "P2", proofHead);
    await assertCleanExecutedTree(dependencies.root, proofHead);
    await writeFile(
      join(dependencies.root, ".proof-receipts", "issue16-p2.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return receipt;
  }
  if (!confirmed) throw new Error("P4 requires --confirm-live-account");
  const privateDir = join(dependencies.root, ".proof-private");
  const lock = join(privateDir, "p4.lock");
  await mkdir(privateDir, { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PrivateProofInUseError();
    }
    throw error;
  }

  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new Error("private P4 proof cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  // ponytail: crash-stale locks are manual cleanup; add reclamation only if operators need it.
  try {
    const { config, receipt } = await prepareProof(dependencies.root, "P4", proofHead);
    cancellation.signal.throwIfAborted();
    await assertCleanExecutedTree(dependencies.root, proofHead);
    cancellation.signal.throwIfAborted();
    await dependencies.openLiveSession({
      credentialDb: config.credentialDb,
      account: config.account,
      pairingAllowed: true,
      signal: cancellation.signal,
    });
    cancellation.signal.throwIfAborted();
    await assertCleanExecutedTree(dependencies.root, proofHead);
    cancellation.signal.throwIfAborted();
    const reconnect = await dependencies.openLiveSession({
      credentialDb: config.credentialDb,
      account: config.account,
      pairingAllowed: false,
      signal: cancellation.signal,
    });
    cancellation.signal.throwIfAborted();
    receipt.sourceChecksumAfter = await databaseHash(config.sourceDb);
    cancellation.signal.throwIfAborted();
    if (reconnect.paired || receipt.sourceChecksumAfter !== receipt.sourceChecksumBefore) {
      throw new Error("P4 reconnect or source checksum proof failed");
    }
    cancellation.signal.throwIfAborted();
    await assertCleanExecutedTree(dependencies.root, proofHead);
    cancellation.signal.throwIfAborted();
    receipt.reconnected = true;
    const receiptPath = join(dependencies.root, ".proof-receipts", "issue16-p4.json");
    const pendingReceipt = join(privateDir, "p4-receipt.pending.json");
    try {
      await writeFile(pendingReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
      cancellation.signal.throwIfAborted();
      await rename(pendingReceipt, receiptPath);
      cancellation.signal.throwIfAborted();
    } catch (error) {
      if (cancellation.signal.aborted) await rm(receiptPath, { force: true });
      throw error;
    } finally {
      await rm(pendingReceipt, { force: true });
    }
    return receipt;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await rm(lock, { recursive: true });
  }
}

export function runPrivateProofCommand(
  args: string[],
  dependencies: ProofDependencies,
): Promise<ProofReceipt> {
  if (args.length === 1 && args[0] === "p2") {
    return runPrivateProof("p2", false, dependencies);
  }
  if (args.length === 2 && args[0] === "p4" && args[1] === "--confirm-live-account") {
    return runPrivateProof("p4", true, dependencies);
  }
  if (args[0] === "p4") {
    throw new Error("live proof requires: pnpm proof:p4 --confirm-live-account");
  }
  throw new Error("use exactly: pnpm proof:p2");
}

async function openLiveWhatsApp(input: {
  credentialDb: string;
  account: string;
  pairingAllowed: boolean;
  signal: AbortSignal;
}): Promise<LiveSessionResult> {
  input.signal.throwIfAborted();
  const session = createSession({
    store: libsqlStore({ url: `file:${input.credentialDb}`, account: input.account }),
    auth: qrAuth(),
    logger: pino({ level: process.env.LOG_LEVEL ?? "silent" }),
  });
  let teardown: Promise<void> | undefined;
  const stopSession = (): Promise<void> => (teardown ??= session.stop());
  let paired = false;
  let online = false;
  const unsubscribe = session.subscribe({
    connection(event) {
      if (event.phase === "pairing") {
        paired = true;
        if (!input.pairingAllowed) {
          void stopSession();
          throw new Error("P4 reconnect requested pairing");
        }
        if (event.pairing.step === "challenge_live" && event.pairing.qr) {
          console.error("Human action required: scan this QR in WhatsApp > Linked devices.");
          qrcode.generate(event.pairing.qr, { small: true });
        }
      }
      if (event.phase === "online") {
        online = true;
        void stopSession();
      }
      if (event.phase === "logged_out" || event.phase === "suspended") {
        throw new Error(`live WhatsApp proof stopped: ${event.phase}`);
      }
    },
  });
  const stop = (): void => {
    void stopSession();
  };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    input.signal.throwIfAborted();
    await session.start();
    input.signal.throwIfAborted();
    if (!online) throw new Error("live WhatsApp proof ended before reaching online");
    return { paired };
  } finally {
    input.signal.removeEventListener("abort", stop);
    unsubscribe();
    await stopSession();
  }
}

async function main(): Promise<void> {
  const receipt = await runPrivateProofCommand(process.argv.slice(2), {
    root: fileURLToPath(new URL("..", import.meta.url)),
    openLiveSession: openLiveWhatsApp,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
