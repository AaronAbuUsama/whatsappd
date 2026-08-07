import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "./_expect.ts";
import {
  buildClientProofReceipt,
  scanClientProofReceipt,
  writeClientProofReceiptExclusive,
  type ClientProofObservationStore,
} from "./client-proof-receipt.ts";

test("the Client proof receipt scanner reports a schema-known non-vacuous artifact", () => {
  const receipt = {
    schemaVersion: 1,
    issue: 127,
    scope: "Issue 127 live Client read path",
    tier: "P4",
    provenance: {
      captureSite: "client-proof-run-start",
      gitHead: "38aab9cd0e17181ece2e0c6f3a8128208ef139e5",
      sourceTreeHash: "1111111111111111111111111111111111111111",
      treeClean: true,
      startedAt: "2026-08-07T00:00:00.000Z",
      finalizedAt: "2026-08-07T00:01:00.000Z",
      command: "pnpm proof:client < /dev/null",
    },
    matrix: [
      {
        id: "inbound-text",
        verdict: "observed",
        captureSite: "client-live-upsert",
        evidence: {
          nonceSha256: "2".repeat(64),
        },
      },
    ],
  };

  assert.deepEqual(scanClientProofReceipt(receipt, ["private-nonce", "peer@lid", "group@g.us"]), {
    schemaUnknownFields: 0,
    schemaInvalidFields: 0,
    patternHits: 0,
    knownValueHits: 0,
    freeFormFields: 1,
    digestFields: 1,
    receiptByteLength: JSON.stringify(receipt).length,
    nonEmpty: true,
    floorPassed: true,
  });
});

test("the scanner refuses unknown fields and scans patterns only in free-form fields", () => {
  const receipt = {
    schemaVersion: 1,
    issue: 127,
    scope: "123456789012@s.whatsapp.net",
    tier: "P4",
    unexpected: "not-schema-owned",
    matrix: [
      {
        id: "inbound-text",
        verdict: "observed",
        captureSite: "client-live-upsert",
        evidence: { nonceSha256: "1".repeat(64) },
      },
    ],
  };

  const scan = scanClientProofReceipt(receipt, []);
  assert.equal(scan.schemaUnknownFields, 1);
  assert.equal(scan.patternHits, 2);
  assert.equal(scan.digestFields, 1, "the SHA-256 digest is typed, not pattern-scanned");
});

test("the scanner detects held-in-memory known values and cannot pass an empty artifact", () => {
  const knownValue = "shape-the-patterns-do-not-anticipate";
  const knownValueScan = scanClientProofReceipt(
    { schemaVersion: 1, issue: 127, scope: knownValue, tier: "P4" },
    [knownValue],
  );
  assert.equal(knownValueScan.knownValueHits, 1);

  const emptyScan = scanClientProofReceipt({}, []);
  assert.equal(emptyScan.nonEmpty, false);
  assert.equal(emptyScan.floorPassed, false);
});

function completeStore(): ClientProofObservationStore {
  return {
    runStart: {
      captureSite: "client-proof-run-start",
      gitHead: "38aab9cd0e17181ece2e0c6f3a8128208ef139e5",
      sourceTreeHash: "1".repeat(40),
      treeClean: true,
      startedAt: "2026-08-07T00:00:00.000Z",
    },
    finalizedAt: "2026-08-07T00:01:00.000Z",
    knownValues: ["private nonce", "peer@lid", "group@g.us"],
    summary: {
      finalized: true,
      interactive: false,
      composition: [
        "fileMediaStore",
        "libsqlBackend",
        "createWhatsAppRuntime",
        "createWhatsAppClient",
      ],
      subjectImports: ["package-root", "runtime-client-public-factory"],
      linkMode: "resumed",
      challengeEventCount: 0,
      qrDisplayed: false,
      stdoutContainedChallenge: false,
      subjectPid: 10,
      peerPid: 11,
      documentPeerPid: 12,
      replacementPid: 13,
      subjectIdentityHash: "2".repeat(64),
      peerIdentityHash: "3".repeat(64),
      peer: {
        mode: "second-account-own-process",
        linkMode: "resumed",
        challengeEventCount: 0,
        qrDisplayed: false,
      },
      inboundText: {
        observedVia: "live-upsert",
        nonceSha256: "4".repeat(64),
        nonceLength: 32,
        chatsList: true,
        messagesGet: true,
      },
      inboundDocument: {
        kind: "document",
        mediaState: "stored",
        byteLength: 256,
        byteLengthMatches: true,
        sentSha256: "5".repeat(64),
        storedSha256: "5".repeat(64),
        equal: true,
      },
      pageSeed: { sentThisRun: 0, retainedBeforeWalk: 38 },
      paging: {
        pageCount: 2,
        terminalOlder: "exhausted",
        repeatedAcrossBoundary: 0,
        skippedAcrossBoundary: 0,
        retainedCount: 38,
        orderedIdDigest: "6".repeat(64),
        oracleOrderedIdDigest: "6".repeat(64),
      },
      replacement: {
        distinctPid: true,
        durableDigestEqual: true,
        durableDigest: {
          chats: "7".repeat(64),
          contacts: "8".repeat(64),
          groups: "9".repeat(64),
          orderedIds: "a".repeat(64),
          media: "b".repeat(64),
        },
        connectionPresent: false,
        identityPresent: false,
        presenceAddressCount: 130,
        presenceObservationsRestored: 0,
        lastConnectedAtPresent: true,
        lastDisconnectedAtPresent: true,
      },
    },
  };
}

test("the receipt writer refuses dishonest provenance and missing observations", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };

  assert.throws(
    () =>
      buildClientProofReceipt(
        { ...store, runStart: { ...store.runStart, treeClean: false } },
        current,
      ),
    /run or current worktree is dirty/,
  );
  assert.throws(
    () => buildClientProofReceipt(store, { gitHead: "f".repeat(40), treeClean: true }),
    /current head does not match/,
  );
  assert.throws(
    () => buildClientProofReceipt({ ...store, finalizedAt: undefined }, current),
    /run is not finalized/,
  );
  assert.throws(
    () =>
      buildClientProofReceipt(
        {
          ...store,
          summary: { ...store.summary!, replacementPid: store.summary!.peerPid },
        },
        current,
      ),
    /proof processes are not distinct/,
  );
  assert.throws(
    () =>
      buildClientProofReceipt(
        {
          ...store,
          summary: {
            ...store.summary!,
            paging: { ...store.summary!.paging, pageCount: 1 },
          },
        },
        current,
      ),
    /required observations are missing/,
  );
  assert.throws(
    () => buildClientProofReceipt({ ...store, knownValues: ["only-one"] }, current),
    /known-value negative control is incomplete/,
  );
});

test("the receipt writer transcribes a complete observation store into a clean matrix", () => {
  const store = completeStore();
  const receipt = buildClientProofReceipt(store, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const scan = scanClientProofReceipt(receipt, store.knownValues);
  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);
  assert.deepEqual(
    (receipt.matrix as Array<{ verdict: string }>).map(({ verdict }) => verdict),
    Array(10).fill("observed"),
  );
});

test("the receipt writer uses exclusive creation and never overwrites evidence", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "client-proof-receipt-"));
  const file = path.join(directory, "receipt.json");
  writeClientProofReceiptExclusive(file, { first: true });
  assert.throws(
    () => writeClientProofReceiptExclusive(file, { first: false }),
    /refusing to overwrite existing receipt/,
  );
  assert.equal(readFileSync(file, "utf8"), '{\n  "first": true\n}\n');
});
