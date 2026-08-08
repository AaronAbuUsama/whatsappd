/**
 * Issue #112 Run B — correct a written receipt that claimed more than the run
 * observed.
 *
 *   pnpm proof:run-b:correct <receipt> <observation-store> <reason>
 *
 * Receipts are `wx` and append-only, and that rule exists so a run cannot
 * quietly improve its own record. It does not oblige the repository to keep a
 * claim it has since established is false — an over-claiming receipt is
 * indistinguishable from a true one, and the next gate consumes it as fact.
 *
 * This adds no observation. It re-derives the matrix from the run's own
 * observation store, refuses a store that does not hash to the one the receipt
 * was written from, refuses any change that raises a verdict or drops a row,
 * and records the digest of the bytes it replaced.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  correctRunBReceipt,
  type RunBCorrectionReason,
  type RunBObservationStore,
} from "./run-b-receipt.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const [receipt, source, reason] = process.argv.slice(2);
if (!receipt || !source || !reason)
  throw new Error("usage: run-b-correct-receipt <receipt> <observation-store> <reason>");

const store = JSON.parse(readFileSync(path.resolve(root, source), "utf8")) as RunBObservationStore;
const corrected = correctRunBReceipt(root, receipt, store, reason as RunBCorrectionReason);

process.stdout.write(
  `${JSON.stringify({
    stage: "corrected",
    receipt: path.relative(root, corrected.file),
    reason,
    ...corrected.counts,
    schemaUnknownFields: corrected.scan.schemaUnknownFields,
    schemaInvalidFields: corrected.scan.schemaInvalidFields,
    patternHits: corrected.scan.patternHits,
    knownValueHits: corrected.scan.knownValueHits,
    floorPassed: corrected.scan.floorPassed,
  })}\n`,
);
