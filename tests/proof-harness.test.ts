import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./_expect.ts";
import { LiveAccountClaimedError, runProofHarness, type OpenLiveSession } from "./proof-harness.ts";

const execFileAsync = promisify(execFile);

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

test("a second live proof fails before opening WhatsApp", async () => {
  const root = await mkdtemp(join(tmpdir(), "whatsappd-proof-"));
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  await execFileAsync("sqlite3", [
    sourceDb,
    "CREATE TABLE records (id TEXT PRIMARY KEY, created TEXT);",
  ]);

  let openCount = 0;
  let markOpened!: () => void;
  const opened = new Promise<void>((resolve) => (markOpened = resolve));
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const openLiveSession: OpenLiveSession = async () => {
    openCount++;
    markOpened();
    await held;
    return { reconnected: true, conversationSyncBatches: 0 };
  };

  const first = runProofHarness(
    {
      sourceDb,
      credentialDb,
      account: "proof",
      runRoot: join(root, "run-1"),
      receiptPath: join(root, "receipt-1.json"),
      live: true,
    },
    { openLiveSession },
  );
  await opened;

  let error: unknown;
  try {
    await runProofHarness(
      {
        sourceDb,
        credentialDb,
        account: "proof",
        runRoot: join(root, "run-2"),
        receiptPath: join(root, "receipt-2.json"),
        live: true,
      },
      { openLiveSession },
    );
  } catch (caught) {
    error = caught;
  }

  expect(error instanceof LiveAccountClaimedError).toBe(true);
  expect(openCount).toBe(1);

  finish();
  await first;
});

test("a snapshot-only run leaves disposable P2 evidence and a sanitized receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "whatsappd-proof-"));
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  const runRoot = join(root, "run");
  const receiptPath = join(root, "receipt.json");
  const privateBody = "meet me at the private place";
  const privateJid = "15551234567@s.whatsapp.net";
  const credential = "private-device-credential";

  await execFileAsync("sqlite3", [
    sourceDb,
    [
      "PRAGMA journal_mode = WAL;",
      "CREATE TABLE raw_event (",
      "id TEXT PRIMARY KEY, created TEXT, updated TEXT, revision INTEGER, payload TEXT, jid TEXT",
      ");",
      `INSERT INTO raw_event VALUES ('pbRecord0000001', '2026-07-28T10:00:00Z', '2026-07-28T10:01:00Z', 7, '${privateBody}', '${privateJid}');`,
    ].join(" "),
  ]);
  await execFileAsync("sqlite3", [
    credentialDb,
    `CREATE TABLE wa_auth (account TEXT, key TEXT, value TEXT); INSERT INTO wa_auth VALUES ('proof', 'creds', '${credential}');`,
  ]);
  const sourceBefore = await sha256(sourceDb);
  const credentialsBefore = await sha256(credentialDb);

  const receipt = await runProofHarness(
    {
      sourceDb,
      credentialDb,
      account: "proof",
      runRoot,
      receiptPath,
      live: false,
    },
    {
      openLiveSession: async () => {
        throw new Error("snapshot-only proof must not open WhatsApp");
      },
    },
  );
  const retainedReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as typeof receipt;
  const published = JSON.stringify(retainedReceipt);

  expect(receipt).toEqual(retainedReceipt);
  expect(receipt.source.unchanged).toBe(true);
  expect(receipt.credentials.unchanged).toBe(true);
  expect(receipt.snapshot.restartVerified).toBe(true);
  expect(receipt.snapshot.isolationVerified).toBe(true);
  expect(receipt.oracle.tables[0]?.count).toBe(1);
  expect(receipt.oracle.tables[0]?.stableIdHashes.length).toBe(1);
  expect(published).not.toContain(privateBody);
  expect(published).not.toContain(privateJid);
  expect(published).not.toContain("15551234567");
  expect(published).not.toContain(credential);
  expect(published).not.toContain(sourceDb);
  expect(published).not.toContain(credentialDb);

  await rm(runRoot, { recursive: true });
  expect(await sha256(sourceDb)).toBe(sourceBefore);
  expect(await sha256(credentialDb)).toBe(credentialsBefore);
});

test("the proof-harness command is hermetic unless live mode is explicitly confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "whatsappd-proof-"));
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  const receiptPath = join(root, "receipt.json");
  await execFileAsync("sqlite3", [
    sourceDb,
    "CREATE TABLE records (id TEXT PRIMARY KEY, created TEXT); INSERT INTO records VALUES ('pbRecord0000002', '2026-07-29T00:00:00Z');",
  ]);

  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    join(import.meta.dirname, "proof-harness.ts"),
    "--source",
    sourceDb,
    "--credentials",
    credentialDb,
    "--run-root",
    join(root, "run"),
    "--receipt",
    receiptPath,
  ]);
  const stdoutReceipt = JSON.parse(stdout) as { live: { requested: boolean } };
  expect(stdoutReceipt.live.requested).toBe(false);

  let error: unknown;
  try {
    await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "proof-harness.ts"),
      "--source",
      sourceDb,
      "--credentials",
      credentialDb,
      "--run-root",
      join(root, "live-run"),
      "--receipt",
      join(root, "live-receipt.json"),
      "--live",
    ]);
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("--confirm-live-account");
});

test("cancelling a live proof releases the machine-wide account lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "whatsappd-proof-"));
  const sourceDb = join(root, "source.db");
  const credentialDb = join(root, "credentials.db");
  await execFileAsync("sqlite3", [sourceDb, "CREATE TABLE records (id TEXT PRIMARY KEY);"]);
  const abort = new AbortController();
  let opened!: () => void;
  const didOpen = new Promise<void>((resolve) => (opened = resolve));

  let error: unknown;
  try {
    const proof = runProofHarness(
      {
        sourceDb,
        credentialDb,
        account: "proof",
        runRoot: join(root, "cancelled-run"),
        receiptPath: join(root, "cancelled-receipt.json"),
        live: true,
        signal: abort.signal,
      } as never,
      {
        openLiveSession: async (input) => {
          opened();
          const signal = (input as typeof input & { signal: AbortSignal }).signal;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { reconnected: false, conversationSyncBatches: 0 };
        },
      },
    );
    await didOpen;
    abort.abort(new Error("live proof cancelled"));
    await proof;
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("live proof cancelled");

  const resumed = await runProofHarness(
    {
      sourceDb,
      credentialDb,
      account: "proof",
      runRoot: join(root, "resumed-run"),
      receiptPath: join(root, "resumed-receipt.json"),
      live: true,
    },
    {
      openLiveSession: async () => ({ reconnected: true, conversationSyncBatches: 0 }),
    },
  );
  expect(resumed.live).toEqual({
    requested: true,
    reconnected: true,
    conversationSyncBatches: 0,
  });
});
