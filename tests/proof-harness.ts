import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProofHarnessOptions {
  sourceDb: string;
  credentialDb: string;
  account: string;
  runRoot: string;
  receiptPath: string;
  live: boolean;
  signal?: AbortSignal;
}

export interface LiveSessionResult {
  reconnected: boolean;
  conversationSyncBatches: number;
}

export interface TableOracle {
  nameHash: string;
  count: number;
  stableIdHashes: string[];
  timestamps: Array<{
    columnHash: string;
    min: string | number | null;
    max: string | number | null;
  }>;
  revisions: Array<{ columnHash: string; min: number | null; max: number | null }>;
  manifestSha256: string;
}

export interface ProofReceipt {
  version: 1;
  runId: string;
  generatedAt: string;
  source: {
    sha256Before: string;
    sha256After: string;
    unchanged: boolean;
  };
  credentials: {
    sha256Before: string | null;
    sha256AfterSnapshot: string | null;
    sha256AfterRun: string | null;
    unchangedBySnapshot: boolean;
    copied: false;
  };
  snapshot: {
    sha256: string;
    restartVerified: boolean;
    isolationVerified: boolean;
  };
  stores: {
    dataStoreId: string;
    mediaStoreId: string;
    disposable: true;
  };
  oracle: {
    tables: TableOracle[];
    manifestSha256: string;
  };
  live: { requested: false } | ({ requested: true } & LiveSessionResult);
}

export type OpenLiveSession = (input: {
  credentialDb: string;
  account: string;
  signal: AbortSignal;
}) => Promise<LiveSessionResult>;

interface ProofHarnessDependencies {
  openLiveSession?: OpenLiveSession;
  onStaleLockObserved?: () => Promise<void>;
  liveAccountLockDb?: string;
}

export class LiveAccountClaimedError extends Error {
  constructor() {
    super("another live proof already owns this WhatsApp account");
    this.name = "LiveAccountClaimedError";
  }
}

async function canonicalPath(file: string): Promise<string> {
  const absolute = resolve(file);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStats, rightStats] = await Promise.all([stat(left), stat(right)]);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function databaseBundleSha256(file: string): Promise<string | null> {
  const hash = createHash("sha256");
  let found = false;
  for (const suffix of ["", "-wal"]) {
    try {
      const bytes = await readFile(`${file}${suffix}`);
      if (suffix === "-wal" && bytes.length <= 32) continue;
      hash.update(suffix);
      hash.update(bytes);
      found = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found ? hash.digest("hex") : null;
}

async function sqlite(
  file: string,
  statement: string,
  options: { readonly?: boolean; json?: boolean; timeout?: number } = {},
): Promise<string> {
  const args = [
    ...(options.timeout ? ["-cmd", `.timeout ${options.timeout}`] : []),
    ...(options.readonly ? ["-readonly"] : []),
    ...(options.json ? ["-json"] : []),
    file,
    statement,
  ];
  const { stdout } = await execFileAsync("sqlite3", args, { maxBuffer: 128 * 1024 * 1024 });
  return stdout;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseRows(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim() === "" ? [] : (JSON.parse(stdout) as Array<Record<string, unknown>>);
}

function safeStableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    !value.includes("@") &&
    !/^\+?[\d\s():.-]{7,}$/.test(value)
  );
}

async function buildOracle(snapshotDb: string, account: string): Promise<ProofReceipt["oracle"]> {
  const tableRows = parseRows(
    await sqlite(
      snapshotDb,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
      { readonly: true, json: true },
    ),
  );
  const tables: TableOracle[] = [];

  for (const row of tableRows) {
    const name = String(row.name);
    const columns = parseRows(
      await sqlite(snapshotDb, `PRAGMA table_info(${identifier(name)})`, {
        readonly: true,
        json: true,
      }),
    ).map((column) => String(column.name));
    const idColumn = columns.find((column) => column.toLowerCase() === "id");
    const timestampColumns = columns.filter((column) =>
      /^(created|updated|timestamp|ts|observed_at|observedat)$/i.test(column),
    );
    const revisionColumns = columns.filter((column) =>
      /^(revision|from_revision|to_revision|fromrevision|torevision)$/i.test(column),
    );
    const accountColumn = columns.find((column) => /^account(?:_?id)?$/i.test(column));
    const accountScope = accountColumn
      ? ` WHERE ${identifier(accountColumn)} = ${sqlString(account)}`
      : "";
    const countRow = parseRows(
      await sqlite(snapshotDb, `SELECT COUNT(*) AS count FROM ${identifier(name)}${accountScope}`, {
        readonly: true,
        json: true,
      }),
    )[0];
    const stableIdHashes = idColumn
      ? parseRows(
          await sqlite(
            snapshotDb,
            `SELECT ${identifier(idColumn)} AS id FROM ${identifier(name)}${accountScope} ORDER BY ${identifier(idColumn)}`,
            { readonly: true, json: true },
          ),
        )
          .map((id) => id.id)
          .filter(safeStableId)
          .map((id) => sha256(`whatsappd-proof-id\0${id}`))
      : [];
    const timestamps = await Promise.all(
      timestampColumns.map(async (column) => {
        const range = parseRows(
          await sqlite(
            snapshotDb,
            `SELECT MIN(${identifier(column)}) AS min, MAX(${identifier(column)}) AS max FROM ${identifier(name)}${accountScope}`,
            { readonly: true, json: true },
          ),
        )[0];
        return {
          columnHash: sha256(`whatsappd-proof-column\0${column}`),
          min: (range?.min as string | number | null | undefined) ?? null,
          max: (range?.max as string | number | null | undefined) ?? null,
        };
      }),
    );
    const revisions = await Promise.all(
      revisionColumns.map(async (column) => {
        const range = parseRows(
          await sqlite(
            snapshotDb,
            `SELECT MIN(${identifier(column)}) AS min, MAX(${identifier(column)}) AS max FROM ${identifier(name)}${accountScope}`,
            { readonly: true, json: true },
          ),
        )[0];
        return {
          columnHash: sha256(`whatsappd-proof-column\0${column}`),
          min: typeof range?.min === "number" ? range.min : null,
          max: typeof range?.max === "number" ? range.max : null,
        };
      }),
    );
    const table = {
      nameHash: sha256(`whatsappd-proof-table\0${name}`),
      count: Number(countRow?.count ?? 0),
      stableIdHashes,
      timestamps,
      revisions,
    };
    tables.push({ ...table, manifestSha256: sha256(JSON.stringify(table)) });
  }

  return { tables, manifestSha256: sha256(JSON.stringify(tables)) };
}

async function snapshotDatabase(sourceDb: string, snapshotDb: string): Promise<void> {
  const quoted = `"${snapshotDb.replaceAll('"', '\\"')}"`;
  await sqlite(sourceDb, `.backup ${quoted}`, { readonly: true });
  await sqlite(snapshotDb, "PRAGMA journal_mode = DELETE");
}

async function acquireLiveAccountLock(
  lockDb: string,
  onStaleLockObserved?: () => Promise<void>,
): Promise<() => Promise<void>> {
  const id = createHash("sha256").update("whatsappd-proof-live-account").digest("hex").slice(0, 32);
  const owner = randomUUID();
  const execute = (statement: string, json = false): Promise<string> =>
    sqlite(lockDb, statement, { json, timeout: 5_000 });
  await execute(
    "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS live_account_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);",
  );

  while (true) {
    await execute(
      `INSERT OR IGNORE INTO live_account_locks VALUES (${sqlString(id)}, ${sqlString(owner)}, ${process.pid});`,
    );
    const claimed = parseRows(
      await execute(`SELECT owner, pid FROM live_account_locks WHERE id = ${sqlString(id)};`, true),
    )[0];
    if (claimed?.owner === owner) {
      return async () => {
        await execute(
          `DELETE FROM live_account_locks WHERE id = ${sqlString(id)} AND owner = ${sqlString(owner)};`,
        );
      };
    }

    const claimedPid = Number(claimed?.pid);
    const claimedOwner = typeof claimed?.owner === "string" ? claimed.owner : "";
    try {
      if (Number.isSafeInteger(claimedPid) && claimedPid > 0) process.kill(claimedPid, 0);
      if (Number.isSafeInteger(claimedPid) && claimedPid > 0) {
        throw new LiveAccountClaimedError();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await onStaleLockObserved?.();
    await execute(
      `UPDATE live_account_locks SET owner = ${sqlString(owner)}, pid = ${process.pid} WHERE id = ${sqlString(id)} AND owner = ${sqlString(claimedOwner)};`,
    );
  }
}

export async function runProofHarness(
  options: ProofHarnessOptions,
  dependencies: ProofHarnessDependencies = {},
): Promise<ProofReceipt> {
  const sourceDb = await canonicalPath(options.sourceDb);
  const credentialDb = await canonicalPath(options.credentialDb);
  if (sourceDb === credentialDb || (await sameFile(sourceDb, credentialDb))) {
    throw new Error("source and credential databases must be different files");
  }
  const runRoot = await canonicalPath(options.runRoot);
  const receiptPath = await canonicalPath(options.receiptPath);
  const dataDir = join(runRoot, "data");
  const mediaDir = join(runRoot, "media");
  const snapshotDb = join(dataDir, "corpus.db");
  const protectedPaths = [
    { name: "source database", path: sourceDb },
    { name: "credential database", path: credentialDb },
    { name: "run root", path: runRoot },
    { name: "data store", path: dataDir },
    { name: "media store", path: mediaDir },
    { name: "snapshot database", path: snapshotDb },
  ];
  for (const protectedPath of protectedPaths) {
    if (receiptPath === protectedPath.path || (await sameFile(receiptPath, protectedPath.path))) {
      throw new Error(`receipt path must be separate from ${protectedPath.name}`);
    }
  }
  if (isWithin(runRoot, receiptPath)) {
    throw new Error("receipt path must be separate from run root");
  }

  await mkdir(dirname(credentialDb), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, "", { flag: "wx" });
  const receiptTemp = join(dirname(receiptPath), `.${basename(receiptPath)}.${randomUUID()}.tmp`);
  let published = false;
  let release = async (): Promise<void> => {};
  const cancellation = new AbortController();
  const cancel = (reason: unknown): void => {
    if (!cancellation.signal.aborted) cancellation.abort(reason);
  };
  const onInterrupt = (): void => cancel(new Error("live proof cancelled"));
  const onExternalAbort = (): void => cancel(options.signal?.reason);
  if (options.live) {
    process.once("SIGINT", onInterrupt);
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    if (options.live) {
      release = await acquireLiveAccountLock(
        dependencies.liveAccountLockDb ?? join(tmpdir(), "whatsappd-live-account-locks.db"),
        dependencies.onStaleLockObserved,
      );
    }
    const sourceBefore = await databaseBundleSha256(sourceDb);
    if (sourceBefore === null) throw new Error("source database does not exist");
    const credentialsBefore = await databaseBundleSha256(credentialDb);

    await mkdir(dirname(runRoot), { recursive: true });
    await mkdir(runRoot);
    await mkdir(dataDir);
    await mkdir(mediaDir);
    await snapshotDatabase(sourceDb, snapshotDb);

    const oracleBeforeRestart = await buildOracle(snapshotDb, options.account);
    await sqlite(
      snapshotDb,
      "CREATE TABLE __whatsappd_proof_isolation (value INTEGER); INSERT INTO __whatsappd_proof_isolation VALUES (1); DROP TABLE __whatsappd_proof_isolation;",
    );
    const oracle = await buildOracle(snapshotDb, options.account);
    const sourceAfterSnapshot = await databaseBundleSha256(sourceDb);
    const credentialsAfterSnapshot = await databaseBundleSha256(credentialDb);
    const restartVerified = oracleBeforeRestart.manifestSha256 === oracle.manifestSha256;
    const isolationVerified =
      sourceAfterSnapshot === sourceBefore && credentialsAfterSnapshot === credentialsBefore;
    if (!restartVerified || !isolationVerified) {
      throw new Error("snapshot restart or isolation verification failed");
    }

    const openLiveSession = dependencies.openLiveSession ?? openLiveWhatsApp;
    const liveResult = options.live
      ? await openLiveSession({
          credentialDb,
          account: options.account,
          signal: cancellation.signal,
        })
      : undefined;
    const sourceAfterRun = await databaseBundleSha256(sourceDb);
    const credentialsAfterRun = await databaseBundleSha256(credentialDb);
    const receipt: ProofReceipt = {
      version: 1,
      runId: randomUUID(),
      generatedAt: new Date().toISOString(),
      source: {
        sha256Before: sourceBefore,
        sha256After: sourceAfterRun!,
        unchanged: sourceBefore === sourceAfterRun,
      },
      credentials: {
        sha256Before: credentialsBefore,
        sha256AfterSnapshot: credentialsAfterSnapshot,
        sha256AfterRun: credentialsAfterRun,
        unchangedBySnapshot: credentialsBefore === credentialsAfterSnapshot,
        copied: false,
      },
      snapshot: {
        sha256: (await databaseBundleSha256(snapshotDb))!,
        restartVerified,
        isolationVerified,
      },
      stores: {
        dataStoreId: sha256(`whatsappd-proof-data\0${runRoot}`),
        mediaStoreId: sha256(`whatsappd-proof-media\0${runRoot}`),
        disposable: true,
      },
      oracle,
      live: liveResult ? { requested: true, ...liveResult } : { requested: false },
    };
    await writeFile(receiptTemp, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(receiptTemp, receiptPath);
    published = true;
    return receipt;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    options.signal?.removeEventListener("abort", onExternalAbort);
    try {
      await release();
    } finally {
      await rm(receiptTemp, { force: true });
      if (!published) await rm(receiptPath, { force: true });
    }
  }
}

async function openLiveWhatsApp(input: {
  credentialDb: string;
  account: string;
  signal: AbortSignal;
}): Promise<LiveSessionResult> {
  const [{ createSession }, { qrAuth }, { libsqlStore }, pinoModule, qrcodeModule] =
    await Promise.all([
      import("../src/session.ts"),
      import("../src/ports.ts"),
      import("../src/stores/libsql.ts"),
      import("pino"),
      import("qrcode-terminal"),
    ]);
  const pino = pinoModule.default;
  const qrcode = qrcodeModule.default;

  const connectOnce = async (): Promise<{ paired: boolean; conversationSyncBatches: number }> => {
    input.signal.throwIfAborted();
    const session = createSession({
      store: libsqlStore({ url: `file:${input.credentialDb}`, account: input.account }),
      auth: qrAuth(),
      logger: pino({ level: process.env.LOG_LEVEL ?? "silent" }),
    });
    let paired = false;
    let conversationSyncBatches = 0;
    let result: { paired: boolean; conversationSyncBatches: number } | undefined;
    const unsubscribe = session.subscribe({
      conversationSync() {
        conversationSyncBatches++;
      },
      connection(event) {
        if (event.phase === "pairing") {
          paired = true;
          if (event.pairing.step === "challenge_live" && event.pairing.qr) {
            console.error("Human action required: scan this QR in WhatsApp > Linked devices.");
            qrcode.generate(event.pairing.qr, { small: true }, (rendered) =>
              console.error(rendered),
            );
          }
        }
        if (event.phase === "online") {
          result = { paired, conversationSyncBatches };
          void session.stop();
        }
        if (event.phase === "logged_out" || event.phase === "suspended") {
          throw new Error(`live WhatsApp proof stopped: ${event.phase}`);
        }
      },
    });
    const stopOnAbort = (): void => {
      void session.stop();
    };
    input.signal.addEventListener("abort", stopOnAbort, { once: true });

    try {
      await session.start();
      input.signal.throwIfAborted();
      if (!result) throw new Error("live WhatsApp proof ended before reconnect");
      return result;
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      throw error;
    } finally {
      unsubscribe();
      input.signal.removeEventListener("abort", stopOnAbort);
    }
  };

  const first = await connectOnce();
  if (!first.paired) {
    return { reconnected: true, conversationSyncBatches: first.conversationSyncBatches };
  }
  const reconnect = await connectOnce();
  if (reconnect.paired) throw new Error("database-backed credentials did not survive pairing");
  return { reconnected: true, conversationSyncBatches: reconnect.conversationSyncBatches };
}

function cliValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<void> {
  const sourceDb = cliValue(args, "--source");
  const credentialDb = cliValue(args, "--credentials");
  if (!sourceDb || !credentialDb) {
    throw new Error("usage: proof-harness --source <PocketBase data.db> --credentials <auth.db>");
  }
  const live = args.includes("--live");
  if (live && !args.includes("--confirm-live-account")) {
    throw new Error("--live requires --confirm-live-account");
  }
  const id = randomUUID();
  const receipt = await runProofHarness({
    sourceDb,
    credentialDb,
    account: cliValue(args, "--account") ?? "proof",
    runRoot: cliValue(args, "--run-root") ?? join(".proof-private", "runs", id),
    receiptPath: cliValue(args, "--receipt") ?? join(".proof-receipts", `${id}.json`),
    live,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
