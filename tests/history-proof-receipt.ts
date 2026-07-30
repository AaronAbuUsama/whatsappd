/**
 * Issue #18 receipt writer — condense a history-proof observation store into
 * a committed, sanitized proof receipt.
 *
 *   node --experimental-strip-types tests/history-proof-receipt.ts <tier> <observations.db> [run.log]
 *
 * tier is p2 or p4.
 *
 * P4 additionally parses the same run's transport debug log (LOG_LEVEL=debug
 * output) for `peer_msg` delivery receipts matching each submitted request id,
 * so the receipt itself carries the delivered evidence its claim rests on.
 *
 * P2 exercises the disposable snapshot's durability boundary: integrity check
 * plus identical oracle digests across a close/reopen of the store (the
 * issue16-p2 shape).
 *
 * Every emitted field is sanitized: hashed identities, counts, timestamps,
 * digests — never message contents or native addresses (long digit runs in
 * free-form notes are redacted defensively). gitHead is read at write time;
 * per ADR-0017 a receipt is evidence only for the head it names.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const [tier, dbFile, runLog] = process.argv.slice(2);

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
  if ((tier !== "p2" && tier !== "p4") || !dbFile) {
    console.error("usage: history-proof-receipt.ts <p2|p4> <observations.db> [run.log]");
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
  const log = runLog ? readFileSync(runLog, "utf8") : undefined;
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
      ...(log ? { deliveryAcksAt: deliveryAcksFor(log, String(r.request_id)) } : {}),
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

  // P2 boundary: the disposable snapshot must survive a close/reopen with an
  // intact integrity check and identical oracle digests.
  const reopened = new DatabaseSync(dbFile, { readOnly: true });
  const quickCheck = String(
    (reopened.prepare("PRAGMA quick_check;").get() as Record<string, unknown>)["quick_check"] ??
      "failed",
  );
  const after = oracle(reopened);
  reopened.close();
  const snapshotRestarted = quickCheck === "ok" && JSON.stringify(before) === JSON.stringify(after);
  if (!snapshotRestarted) throw new Error("snapshot restart proof failed");

  const receipt = {
    nonce: randomUUID(),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
    tier: tier.toUpperCase(),
    observationDbSha256: createHash("sha256").update(readFileSync(dbFile)).digest("hex"),
    ...before,
    snapshotRestarted,
    ...(log
      ? { deliveryAckSource: "peer_msg receipt stanzas in the same run's transport debug log" }
      : {}),
    requests: perRequest,
    operatorNotes: notes,
  };

  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `issue18-${tier}.json`);
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(out);
  console.log(JSON.stringify(receipt, null, 2));
}
