/**
 * Issue #112 Run B — transcribe a finalized observation store into a receipt.
 *
 *   pnpm proof:run-b:receipt .proof-private/issue112-run-b-<head7>-<ms>.json
 *
 * Split from the run because phase 2 executes under a filesystem sandbox that
 * deliberately cannot reach the formatter, and because the observation store
 * holds the run's known-value controls — real account material that must stay
 * under `.proof-private/`. The runner captures; this transcribes; the writer
 * re-reads the head at source and refuses a mismatch or a dirty tree.
 *
 * This adds no observation of its own. Every number in the receipt was measured
 * by the run.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeRunBReceipt, type RunBObservationStore } from "./run-b-receipt.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const source = process.argv[2];
if (!source) throw new Error("name the finalized observation store to transcribe");

const store = JSON.parse(readFileSync(path.resolve(root, source), "utf8")) as RunBObservationStore;
const receipt = writeRunBReceipt(root, store);

process.stdout.write(
  `${JSON.stringify({
    stage: "receipt",
    receipt: path.relative(root, receipt.file),
    mode: store.mode,
    verdicts: store.rows.map(({ id, verdict }) => ({ id, verdict })),
    schemaUnknownFields: receipt.scan.schemaUnknownFields,
    schemaInvalidFields: receipt.scan.schemaInvalidFields,
    patternHits: receipt.scan.patternHits,
    knownValueHits: receipt.scan.knownValueHits,
    floorPassed: receipt.scan.floorPassed,
  })}\n`,
);
