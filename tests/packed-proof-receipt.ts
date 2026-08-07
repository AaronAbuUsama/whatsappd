import assert from "node:assert/strict";
import {
  receiptField as field,
  scanSchemaDrivenReceipt,
  type ReceiptFieldSchema,
  type ReceiptScanReport,
} from "./proof-receipt-scan.ts";

const PACKED_RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schema", field("enum", ["whatsappd-packed-consumer-proof/v1"])],
  ["/tier", field("enum", ["P6"])],
  ["/gitHead", field("git_sha")],
  ["/observedAt", field("iso8601")],
  ["/command", field("free_form")],
  ["/packedConsumer/typecheckDiagnostics", field("count")],
  ["/packedConsumer/source", field("free_form")],
  ["/packedConsumer/packageResolvedThroughNodeModules", field("boolean")],
  ["/reconstruction/firstPid", field("count")],
  ["/reconstruction/secondPid", field("count")],
  ["/reconstruction/distinctPids", field("boolean")],
  ["/reconstruction/durableDigest", field("digest")],
  ["/reconstruction/durableDigestEqual", field("boolean")],
  ["/reconstruction/pageMessageCount", field("count")],
  ["/reconstruction/mediaDigest", field("digest")],
  ["/reconstruction/connectionPresent", field("boolean")],
  ["/reconstruction/identityPresent", field("boolean")],
  ["/reconstruction/presenceRestored", field("boolean")],
  ["/reconstruction/explicitEnvironmentAllowlist", field("boolean")],
  ["/reconstruction/closeOrder/*", field("enum", ["client", "runtime", "backend"])],
]);

export const PACKED_SCENARIO_KNOWN_VALUES = [
  "Packed consumer",
  "Packed room",
  "packed.bin",
] as const;

export function scanPackedProofReceipt(
  receipt: unknown,
  knownValues: readonly string[] = PACKED_SCENARIO_KNOWN_VALUES,
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, PACKED_RECEIPT_SCHEMA);
}

export function assertPackedProofReceiptSanitized(receipt: unknown): ReceiptScanReport {
  const report = scanPackedProofReceipt(receipt);
  assert.ok(PACKED_SCENARIO_KNOWN_VALUES.length > 0, "no packed known-value controls configured");
  assert.equal(report.schemaUnknownFields, 0, "packed receipt has fields outside its schema");
  assert.equal(report.schemaInvalidFields, 0, "packed receipt has schema-invalid fields");
  assert.equal(report.patternHits, 0, "packed receipt free-form fields contain a leak pattern");
  assert.equal(report.knownValueHits, 0, "packed receipt contains a held scenario value");
  assert.equal(report.floorPassed, true, "packed receipt sanitization floor did not pass");
  return report;
}
