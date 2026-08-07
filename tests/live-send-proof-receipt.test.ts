import assert from "node:assert/strict";
import {
  buildLiveSendProofReceipt,
  scanLiveSendProofReceipt,
  type LiveSendProofObservationStore,
} from "./live-send-proof-receipt.ts";
import { test } from "./_expect.ts";

const digest = "a".repeat(64);
const hash = "b".repeat(40);

const store = {
  runStart: {
    captureSite: "live-send-proof-run-start",
    gitHead: hash,
    sourceTreeHash: hash,
    treeClean: true,
    startedAt: "2026-08-07T12:00:00.000Z",
  },
  finalizedAt: "2026-08-07T12:01:00.000Z",
  summary: {
    subjectLinkMode: "resumed",
    peerLinkMode: "resumed",
    bodySha256: digest,
    bodyLength: 54,
    replayLabelSha256: digest,
    replayLabelLength: 26,
    operationIdSha256: digest,
    operationIdLength: 36,
    statusTimeline: ["queued", "claimed", "executing", "succeeded"],
    operationCountForKey: 1,
    replayReturnedSameOperation: true,
    messageRefPresent: true,
    messageRefIdSha256: digest,
    messageRefIdLength: 22,
    messageRefFromMe: true,
    subjectMatchingMessages: 1,
    subjectMessageRefMatches: true,
    peerMatchingMessages: 1,
    peerInboxBeforeSend: 0,
    peerInboxAfterSend: 1,
    peerInboxAfterReplay: 1,
    replaySentNothingFurther: true,
    refusedTargetSha256: digest,
    refusedTargetLength: 34,
    refusalReason: "target_not_allowlisted",
    peerInboxBeforeRefusal: 1,
    peerInboxAfterRefusal: 1,
    peerInboxUnchanged: true,
  },
  knownValues: ["known-canary"],
} satisfies LiveSendProofObservationStore;

test("the live-send receipt is schema-owned, non-vacuous and free of known values", () => {
  const { receipt, scan } = buildLiveSendProofReceipt(store);
  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);

  const unknown = { ...receipt, unexpected: "not-schema-owned" };
  assert.equal(scanLiveSendProofReceipt(unknown, store.knownValues).schemaUnknownFields, 1);

  const leaked = { ...receipt, scope: store.knownValues[0] };
  assert.equal(scanLiveSendProofReceipt(leaked, store.knownValues).knownValueHits, 1);
});
