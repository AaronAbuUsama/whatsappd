/**
 * Issue #18 receipt writer — condense a history-proof observation store into
 * a committed, sanitized P4 proof receipt.
 *
 *   node --experimental-strip-types tests/history-proof-receipt.ts <observations.db> <run.log>
 *
 * The tier is not an input: this writer only ever emits P4 receipts, named
 * `issue18-p4.run<N>-<gitHead7>.json`, one per live run, never overwriting —
 * a rerun adds evidence instead of destroying the old (ADR-0017: a receipt is
 * evidence only for the head it names).
 *
 * The run's transport debug log (LOG_LEVEL=debug output) is REQUIRED: the
 * writer embeds each request's `peer_msg` delivery receipts parsed from it,
 * so the receipt carries the delivered/undelivered evidence its claims rest
 * on. An empty ack list for a request is itself evidence (e.g. the
 * phone-offline scenario).
 *
 * The embedded oracle fields (store SHA-256, counts, ordered-id digest,
 * timestamp bounds, close/reopen `snapshotRestarted`) are the Database Oracle
 * cross-check that ADR-0017 and issue #18 call SUPPORTING evidence; they
 * claim no proof rung of their own. P2 is a product-durability rung and is
 * not claimable until a durable product store exists (issue #20).
 *
 * Every emitted field is sanitized: hashed identities, counts, timestamps,
 * digests — never message contents or native addresses (long digit runs in
 * free-form notes are redacted defensively).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const [dbFile, runLog] = process.argv.slice(2);

const redact = (text: string): string => text.replace(/\+?\d{7,15}/g, "<redacted>");

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
 * Pull `peer_msg` delivery receipts for a request id out of the run's debug
 * transport log. The stanza shape is a receipt node whose attrs carry the
 * request message id and a server timestamp (`"t": "<epoch-seconds>"`).
 */
export function deliveryAcksFor(log: string, requestId: string): string[] {
  const acks: string[] = [];
  const stanzas = log.split(/"tag": "receipt"/).slice(1);
  for (const stanza of stanzas) {
    const head = stanza.slice(0, 400);
    if (!head.includes('"type": "peer_msg"') || !head.includes(`"id": "${requestId}"`)) continue;
    const t = /"t": "(\d+)"/.exec(head)?.[1];
    if (t) acks.push(new Date(Number(t) * 1000).toISOString());
  }
  return acks;
}

// Only run when executed directly, so deliveryAcksFor stays unit-testable.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!dbFile || !runLog) {
    console.error("usage: history-proof-receipt.ts <observations.db> <run.log>");
    process.exit(1);
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const before = oracle(db);
  const requests = db.prepare("SELECT * FROM request ORDER BY submitted_at").all() as Array<
    Record<string, unknown>
  >;
  const correlatedStmt = db.prepare(
    `SELECT COUNT(DISTINCT b.seq) AS batches, COUNT(m.msg_hash) AS messages
       FROM batch b LEFT JOIN message m ON m.batch_seq = b.seq
      WHERE b.request_session_id = ?`,
  );
  const log = readFileSync(runLog, "utf8");
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
  const quickCheck = String(
    (reopened.prepare("PRAGMA quick_check;").get() as Record<string, unknown>)["quick_check"] ??
      "failed",
  );
  const after = oracle(reopened);
  reopened.close();
  const snapshotRestarted = quickCheck === "ok" && JSON.stringify(before) === JSON.stringify(after);
  if (!snapshotRestarted) throw new Error("snapshot restart proof failed");

  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  const receipt = {
    nonce: randomUUID(),
    gitHead,
    tier: "P4",
    observationDbSha256: createHash("sha256").update(readFileSync(dbFile)).digest("hex"),
    ...before,
    snapshotRestarted,
    deliveryAckSource: "peer_msg receipt stanzas in the same run's transport debug log",
    requests: perRequest,
    operatorNotes: notes,
  };

  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber = 1 + readdirSync(outDir).filter((f) => f.startsWith("issue18-p4.run")).length;
  const out = path.join(outDir, `issue18-p4.run${runNumber}-${gitHead.slice(0, 7)}.json`);
  if (existsSync(out)) throw new Error(`refusing to overwrite existing receipt ${out}`);
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(out);
  console.log(JSON.stringify(receipt, null, 2));
}
