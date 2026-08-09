/**
 * Issue #18 receipt writer — transcribe a history-proof observation store into
 * a committed, sanitized P4 proof receipt.
 *
 *   node --experimental-strip-types tests/history-proof-receipt.ts <observations.db>
 *
 * The writer is a pure transcriber: every property the receipt asserts was
 * captured at source by the runner, at run time, inside the observation store —
 * the git head and tree state (a dirty run is refused), the run's own
 * transport log path (always recorded at debug level, so delivery-ack
 * stanzas are complete), identities (salted per run), notes (redacted at
 * entry), and per-request submission times. The writer re-derives nothing and
 * takes no operator judgment beyond naming the store.
 *
 * Receipts are per-run and append-only, named `issue18-p4.run<N>-<head7>.json`,
 * never overwritten — a rerun adds evidence instead of destroying the old
 * (ADR-0017: a receipt is evidence only for the head it names). The tier is
 * not an input: only P4 receipts exist. The embedded oracle fields are the
 * Database Oracle cross-check ADR-0017 calls SUPPORTING evidence; they claim
 * no rung of their own (P2 is product-durability work, issue #20).
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const [dbFile] = process.argv.slice(2);

/**
 * Redact anything shaped like a native address: any run of digits (allowing
 * common separators) totalling 7+ digits. Over-redaction of e.g. dates in
 * free-form notes is accepted — privacy beats note fidelity.
 */
export const redact = (text: string): string =>
  text.replace(/\+?\d[\d\s\-().]{4,28}\d/g, (m) =>
    m.replace(/\D/g, "").length >= 7 ? "<redacted>" : m,
  );

export interface ProofRunStart {
  readonly captureSite: string;
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface ProofReceiptScan {
  readonly patternHits: number;
  readonly knownValueHits: number;
  readonly receiptByteLength: number;
  readonly nonEmpty: boolean;
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function captureProofRunStart(
  cwd: string,
  captureSite: string,
  source = "HEAD:src",
): ProofRunStart {
  return {
    captureSite,
    gitHead: git(cwd, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(cwd, ["rev-parse", source]),
    treeClean: git(cwd, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

function privatePatternHits(value: string): number {
  if (/^[a-f0-9]{40,64}$/u.test(value) || !Number.isNaN(Date.parse(value))) return 0;
  let hits = 0;
  if (/\d{7,}/u.test(value.replace(/[\s\-().+]/gu, ""))) hits++;
  if (/@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)/u.test(value)) hits++;
  if (!/^[a-z][A-Za-z0-9-]{0,63}$/u.test(value) && /[A-Za-z0-9+/_-]{32,}={0,2}/u.test(value)) {
    hits++;
  }
  if (/(?:[A-Za-z0-9+/_-]+={0,2},){2,}[A-Za-z0-9+/_-]+={0,2}/u.test(value)) hits++;
  if (value.includes(".proof-private")) hits++;
  return hits;
}

export function scanProofReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ProofReceiptScan {
  const serialized = JSON.stringify(receipt);
  const patternHits = stringLeaves(receipt).reduce(
    (count, value) => count + privatePatternHits(value),
    0,
  );
  return {
    patternHits,
    knownValueHits: knownValues.filter((value) => value && serialized.includes(value)).length,
    receiptByteLength: Buffer.byteLength(serialized),
    nonEmpty: serialized !== "{}" && serialized !== "null",
  };
}

export function writeProofReceipt(options: {
  readonly cwd: string;
  readonly prefix: string;
  readonly runStart: ProofRunStart;
  readonly finalizedAt: string | undefined;
  readonly knownValues: readonly string[];
  readonly receipt: Record<string, unknown>;
}): { readonly file: string; readonly scan: ProofReceiptScan } {
  const { cwd, prefix, runStart, finalizedAt, knownValues } = options;
  if (
    !runStart.treeClean ||
    git(cwd, ["status", "--porcelain"]).length !== 0 ||
    runStart.gitHead !== git(cwd, ["rev-parse", "HEAD"])
  ) {
    throw new Error("refusing receipt: the run is dirty or no longer matches HEAD");
  }
  if (!finalizedAt) throw new Error("refusing receipt: the run is not finalized");
  if (
    knownValues.length < 3 ||
    knownValues.some((value) => value.length === 0) ||
    new Set(knownValues).size !== knownValues.length
  ) {
    throw new Error("refusing receipt: known-value negative control is incomplete");
  }

  const firstScan = scanProofReceipt(options.receipt, knownValues);
  const receipt = {
    ...options.receipt,
    sanitization: {
      captureSite: "shared-history-proof-receipt-writer",
      patternHits: firstScan.patternHits,
      knownValueHits: firstScan.knownValueHits,
      knownValueControlCount: knownValues.length,
      nonEmpty: firstScan.nonEmpty,
    },
  };
  const scan = scanProofReceipt(receipt, knownValues);
  if (scan.patternHits !== 0 || scan.knownValueHits !== 0 || !scan.nonEmpty) {
    throw new Error(`refusing unsanitized receipt: ${JSON.stringify(scan)}`);
  }

  const outDir = path.join(cwd, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber = 1 + readdirSync(outDir).filter((name) => name.startsWith(prefix)).length;
  const file = path.join(outDir, `${prefix}${runNumber}-${runStart.gitHead.slice(0, 7)}.json`);
  const formatted = execFileSync(
    path.join(cwd, "node_modules", ".bin", "vp"),
    ["fmt", "--stdin-filepath=.proof-receipts/receipt.json"],
    { cwd, input: `${JSON.stringify(receipt, null, 2)}\n`, encoding: "utf8" },
  );
  try {
    writeFileSync(file, formatted, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite existing receipt ${file}`);
    }
    throw error;
  }
  return { file, scan };
}

interface Oracle {
  recordCount: number;
  batchCount: number;
  requestCount: number;
  distinctMessageIds: number;
  orderedIdDigest: string;
  timestampBounds: { min: string | null; max: string | null };
}

function oracle(db: DatabaseSync): Oracle {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const counts = one<{ batches: number; messages: number; requests: number; distinctIds: number }>(
    `SELECT (SELECT COUNT(*) FROM batch) AS batches,
            (SELECT COUNT(*) FROM message) AS messages,
            (SELECT COUNT(*) FROM request) AS requests,
            (SELECT COUNT(DISTINCT msg_hash) FROM message) AS distinctIds`,
  );
  const bounds = one<{ min: number | null; max: number | null }>(
    "SELECT MIN(timestamp) AS min, MAX(timestamp) AS max FROM message WHERE timestamp > 0",
  );
  const orderedIds = db
    .prepare("SELECT msg_hash FROM message ORDER BY timestamp, msg_hash")
    .all()
    .map((r) => (r as { msg_hash: string }).msg_hash)
    .join("\n");
  return {
    recordCount: counts.messages,
    batchCount: counts.batches,
    requestCount: counts.requests,
    distinctMessageIds: counts.distinctIds,
    orderedIdDigest: createHash("sha256").update(orderedIds).digest("hex"),
    timestampBounds: {
      min: bounds.min == null ? null : new Date(bounds.min).toISOString(),
      max: bounds.max == null ? null : new Date(bounds.max).toISOString(),
    },
  };
}

/**
 * Pull `peer_msg` delivery-receipt timestamps for a request id out of the
 * runner's own transport log (pino JSON lines). Only a stanza whose own attrs
 * carry the id is credited — neighboring stanzas or free-text mentions never
 * count.
 */
export function deliveryAcksFor(log: string, requestId: string): string[] {
  const acks: string[] = [];
  for (const line of log.split("\n")) {
    if (!line.includes('"receipt"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const stack: unknown[] = [entry];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const attrs = o.attrs as Record<string, unknown> | undefined;
      if (
        o.tag === "receipt" &&
        attrs?.type === "peer_msg" &&
        attrs.id === requestId &&
        typeof attrs.t === "string"
      ) {
        acks.push(new Date(Number(attrs.t) * 1000).toISOString());
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
    }
  }
  return acks;
}

// Only run when executed directly, so the helpers stay unit-testable.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!dbFile) {
    console.error("usage: history-proof-receipt.ts <observations.db>");
    process.exit(1);
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });

  // Run provenance was captured at source by the runner; transcribe it.
  const runs = db.prepare("SELECT * FROM run").all() as Array<Record<string, unknown>>;
  if (runs.length !== 1) {
    throw new Error(`observation store must carry exactly one run row, found ${runs.length}`);
  }
  const run = runs[0]!;
  if (run.dirty) {
    throw new Error(
      "run executed on a dirty tree — its head does not name the exercised code, so no receipt can honestly carry it (ADR-0017)",
    );
  }
  if (run.finalized_at == null) {
    throw new Error(
      "run is not finalized — the harness may still be connected, and a receipt written now would record later-arriving outcomes as absent",
    );
  }
  if (run.lease_token == null) {
    throw new Error("run carries no lease token — observations are not bound to an account holder");
  }
  const gitHead = String(run.git_head);
  const log = readFileSync(String(run.log_path), "utf8");
  if (!log.includes('"tag":"receipt"') && !log.includes('"tag": "receipt"')) {
    throw new Error(
      "the run's transport log contains no receipt stanzas — refusing to assert delivery-ack evidence",
    );
  }

  const before = oracle(db);
  const requests = db.prepare("SELECT * FROM request ORDER BY submitted_at").all() as Array<
    Record<string, unknown>
  >;
  // An issue-18 P4 receipt asserts on-demand request behavior; a run that
  // submitted none has nothing to receipt.
  if (requests.length === 0) {
    throw new Error("run contains no history requests — nothing to receipt");
  }
  // The log is the run's own (path from the run table), but belt-and-braces:
  // every submitted request must appear in it.
  for (const r of requests) {
    if (!log.includes(String(r.request_id))) {
      throw new Error(
        `run log does not mention request ${String(r.request_id)} — store/log mismatch; refusing to assert delivery-ack evidence`,
      );
    }
  }
  const correlatedStmt = db.prepare(
    `SELECT COUNT(DISTINCT b.seq) AS batches, COUNT(m.msg_hash) AS messages
       FROM batch b LEFT JOIN message m ON m.batch_seq = b.seq
      WHERE b.request_session_id = ?`,
  );
  const perRequest = requests.map((r) => {
    const correlated = correlatedStmt.get(String(r.request_id)) as {
      batches: number;
      messages: number;
    };
    return {
      requestId: r.request_id,
      chatHash: r.chat_hash,
      anchorMsgHash: r.anchor_msg_hash,
      anchorTimestamp: r.anchor_timestamp,
      count: r.count,
      submittedAt: r.submitted_at,
      deliveryAcksAt: deliveryAcksFor(log, String(r.request_id)),
      correlatedBatches: correlated.batches,
      correlatedMessages: correlated.messages,
    };
  });
  const notes = (
    db.prepare("SELECT at, text FROM note ORDER BY at").all() as Array<{
      at: number;
      text: string;
    }>
  ).map((n) => ({ at: n.at, text: redact(n.text) }));
  db.close();

  // Oracle integrity: the capture store must survive a close/reopen with an
  // intact integrity check and identical digests. Supporting evidence only —
  // this is not, and must never be labeled, a product-durability (P2) proof.
  const reopened = new DatabaseSync(dbFile, { readOnly: true });
  const quickCheckValue = (
    reopened.prepare("PRAGMA quick_check;").get() as Record<string, unknown>
  )["quick_check"];
  const quickCheck = typeof quickCheckValue === "string" ? quickCheckValue : "failed";
  const after = oracle(reopened);
  reopened.close();
  const snapshotRestarted = quickCheck === "ok" && JSON.stringify(before) === JSON.stringify(after);
  if (!snapshotRestarted) throw new Error("snapshot restart proof failed");

  const receipt = {
    nonce: randomUUID(),
    gitHead,
    tier: "P4",
    runId: run.run_id,
    leaseToken: run.lease_token,
    runFinalizedAt: new Date(Number(run.finalized_at)).toISOString(),
    observationDbSha256: createHash("sha256").update(readFileSync(dbFile)).digest("hex"),
    ...before,
    snapshotRestarted,
    deliveryAckSource:
      "peer_msg receipt stanzas in the run's own transport log (path bound in the observation store at run start, recorded at debug level)",
    requests: perRequest,
    operatorNotes: notes,
  };

  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber = 1 + readdirSync(outDir).filter((f) => f.startsWith("issue18-p4.run")).length;
  const out = path.join(outDir, `issue18-p4.run${runNumber}-${gitHead.slice(0, 7)}.json`);
  try {
    // "wx": exclusive create — two concurrent writers cannot silently
    // truncate each other; append-only holds under races too.
    writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite existing receipt ${out}`);
    }
    throw err;
  }
  console.log(out);
  console.log(JSON.stringify(receipt, null, 2));
}
