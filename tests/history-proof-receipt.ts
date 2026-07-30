/**
 * Issue #18 receipt writer — condense a history-proof observation store into
 * a committed, sanitized proof receipt.
 *
 *   node --experimental-strip-types tests/history-proof-receipt.ts <tier> <observations.db>
 *
 * tier is p2 or p4. The receipt carries only hashed identities, counts,
 * timestamps, and digests — never message contents or native addresses.
 * gitHead is read from the repository at write time; per ADR-0017 a receipt
 * is evidence only for the head it names.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const [tier, dbFile] = process.argv.slice(2);
if ((tier !== "p2" && tier !== "p4") || !dbFile) {
  console.error("usage: history-proof-receipt.ts <p2|p4> <observations.db>");
  process.exit(1);
}

const db = new DatabaseSync(dbFile, { readOnly: true });
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
const requests = db.prepare("SELECT * FROM request ORDER BY submitted_at").all() as Array<
  Record<string, unknown>
>;
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
    correlatedBatches: correlated.batches,
    correlatedMessages: correlated.messages,
  };
});
const notes = db.prepare("SELECT at, text FROM note ORDER BY at").all();

const receipt = {
  nonce: randomUUID(),
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
  tier: tier.toUpperCase(),
  observationDbSha256: createHash("sha256").update(readFileSync(dbFile)).digest("hex"),
  recordCount: counts.messages,
  batchCount: counts.batches,
  requestCount: counts.requests,
  distinctMessageIds: counts.distinctIds,
  orderedIdDigest: createHash("sha256").update(orderedIds).digest("hex"),
  timestampBounds: {
    min: bounds.min == null ? null : new Date(bounds.min).toISOString(),
    max: bounds.max == null ? null : new Date(bounds.max).toISOString(),
  },
  requests: perRequest,
  operatorNotes: notes,
};

const outDir = path.join(root, ".proof-receipts");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `issue18-${tier}.json`);
writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(out);
console.log(JSON.stringify(receipt, null, 2));
