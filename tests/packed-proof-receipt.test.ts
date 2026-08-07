import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./_expect.ts";
import {
  PACKED_SCENARIO_KNOWN_VALUES,
  assertPackedProofReceiptSanitized,
  scanPackedProofReceipt,
} from "./packed-proof-receipt.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const committedReceipt = JSON.parse(
  readFileSync(path.join(root, ".proof-receipts/issue107-p6.run1-906e1b2.json"), "utf8"),
) as Record<string, unknown>;

test("the committed P6 receipt is schema-known, sanitary, and non-vacuous", () => {
  assert.deepEqual(assertPackedProofReceiptSanitized(committedReceipt), {
    schemaUnknownFields: 0,
    schemaInvalidFields: 0,
    patternHits: 0,
    knownValueHits: 0,
    freeFormFields: 2,
    digestFields: 2,
    receiptByteLength: JSON.stringify(committedReceipt).length,
    nonEmpty: true,
    floorPassed: true,
  });
});

test("the P6 scanner refuses unknown fields and scans only free-form fields", () => {
  const receipt = structuredClone(committedReceipt);
  receipt.unexpected = "not-schema-owned";
  receipt.command = ".proof-private/packed-proof.log";
  receipt.observedAt = "2026-02-30T00:00:00Z";

  const scan = scanPackedProofReceipt(receipt, []);
  assert.equal(scan.schemaUnknownFields, 1);
  assert.equal(scan.schemaInvalidFields, 1);
  assert.equal(scan.patternHits, 1);
  assert.equal(scan.digestFields, 2, "typed SHA-256 fields are not pattern-scanned");
});

test("the P6 scanner detects held values and cannot pass an empty artifact", () => {
  const knownValue = PACKED_SCENARIO_KNOWN_VALUES[0];
  assert.equal(
    scanPackedProofReceipt({ ...committedReceipt, command: `pnpm proof:pack ${knownValue}` }, [
      knownValue,
    ]).knownValueHits,
    1,
  );

  const emptyScan = scanPackedProofReceipt({}, []);
  assert.equal(emptyScan.nonEmpty, false);
  assert.equal(emptyScan.floorPassed, false);
});
