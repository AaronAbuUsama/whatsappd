import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./_expect.ts";
import {
  buildClientGuardProofReceipt,
  buildClientProofReceipt,
  buildPairingProofReceipt,
  scanClientProofReceipt,
  writeClientProofReceiptExclusive,
  type ClientGuardProofObservationStore,
  type ClientProofObservationStore,
  type PairingProofObservationStore,
} from "./client-proof-receipt.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  assert.deepEqual(
    scanClientProofReceipt(receipt, ["private-nonce", `peer${"@lid"}`, `group${"@g.us"}`]),
    {
      schemaUnknownFields: 0,
      schemaInvalidFields: 0,
      patternHits: 0,
      knownValueHits: 0,
      freeFormFields: 1,
      digestFields: 1,
      receiptByteLength: JSON.stringify(receipt).length,
      nonEmpty: true,
      floorPassed: true,
    },
  );
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
    knownValues: ["private nonce", `peer${"@lid"}`, `group${"@g.us"}`],
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
        credentialIdentityDigest: "c".repeat(64),
        credentialIdentityMatchesOriginal: true,
        sessionAttached: true,
        liveSocketResumed: false,
        durableReconstructedWhileNoLive: true,
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

function completePairingStore(): PairingProofObservationStore {
  return {
    runStart: {
      captureSite: "pairing-proof-run-start",
      gitHead: "38aab9cd0e17181ece2e0c6f3a8128208ef139e5",
      sourceTreeHash: "1".repeat(40),
      proofHarnessSha256: "2".repeat(64),
      treeClean: true,
      startedAt: "2026-08-07T00:00:00.000Z",
    },
    finalizedAt: "2026-08-07T00:01:00.000Z",
    knownValues: ["private nonce", `peer${"@lid"}`, `group${"@g.us"}`],
    summary: {
      interactive: false,
      freshLinkState: "needs_pairing",
      observationMs: 10_250,
      netSocketCount: 0,
      netControlCount: 1,
      deterministicOpenCalls: 0,
      syntheticChallengeObserverControl: {
        kind: "synthetic",
        challengeEventCount: 1,
      },
      linkMode: "resumed",
      resumeMs: 2_500,
      challengeEventCount: 0,
      challengeProduced: false,
      pairOperationCount: 0,
      secondSocketCount: 0,
      sessionStillOnline: true,
    },
  };
}

test("the pairing receipt is head-bound, complete, and schema-sanitized", () => {
  const store = completePairingStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };
  const receipt = buildPairingProofReceipt(store, current);
  const scan = scanClientProofReceipt(receipt, store.knownValues);
  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);

  assert.throws(
    () =>
      buildPairingProofReceipt(
        { ...store, runStart: { ...store.runStart, treeClean: false } },
        current,
      ),
    /dirty/,
  );
  assert.throws(
    () => buildPairingProofReceipt(store, { gitHead: "f".repeat(40), treeClean: true }),
    /does not match/,
  );
  assert.throws(
    () =>
      buildPairingProofReceipt(
        { ...store, summary: { ...store.summary!, pairOperationCount: 1 as 0 } },
        current,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      buildPairingProofReceipt(
        {
          ...store,
          summary: {
            ...store.summary!,
            syntheticChallengeObserverControl: {
              kind: "synthetic",
              challengeEventCount: 0,
            },
          },
        },
        current,
      ),
    /incomplete/,
  );
});

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
    () =>
      buildClientProofReceipt(
        {
          ...store,
          summary: {
            ...store.summary!,
            replacement: {
              ...store.summary!.replacement,
              // @ts-expect-error Deliberately malformed receipt fixture.
              credentialIdentityMatchesOriginal: false,
            },
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

test("the inbound-text capture site is derived from how the Client observed it", () => {
  const store = completeStore();
  const storedPageStore: ClientProofObservationStore = {
    ...store,
    summary: {
      ...store.summary!,
      inboundText: {
        ...store.summary!.inboundText,
        observedVia: "stored-page",
      },
    },
  };
  const receipt = buildClientProofReceipt(storedPageStore, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const inboundText = (
    receipt.matrix as Array<{
      readonly id: string;
      readonly captureSite: string;
    }>
  ).find(({ id }) => id === "inbound-text");

  assert.equal(inboundText?.captureSite, "client-stored-page");
});

test("the receipt writer uses exclusive creation and never overwrites evidence", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "client-proof-receipt-"));
  const file = path.join(directory, "receipt.json");
  writeClientProofReceiptExclusive(root, file, { first: true });
  assert.throws(
    () => writeClientProofReceiptExclusive(root, file, { first: false }),
    /refusing to overwrite existing receipt/,
  );
  assert.equal(readFileSync(file, "utf8"), '{\n  "first": true\n}\n');
});

function completeGuardStore(): ClientGuardProofObservationStore {
  return {
    runStart: {
      captureSite: "client-proof-guard-run-start",
      gitHead: "f07af9827087d07462dc47203fba198052d4cef0",
      sourceTreeHash: "1".repeat(40),
      treeClean: true,
      startedAt: "2026-08-07T07:00:00.000Z",
    },
    finalizedAt: "2026-08-07T07:00:01.000Z",
    knownValues: [
      "generated-target-held-in-memory",
      "generated-scan-canary-held-in-memory",
      "generated-control-held-in-memory",
    ],
    guard: {
      targetSha256: "c".repeat(64),
      targetLength: 28,
      refusalReason: "target_not_allowlisted",
      sessionSendInvocations: 0,
    },
  };
}

test("the guard receipt records a refusal before any recorded Session send without recording the target", () => {
  const store = completeGuardStore();
  const receipt = buildClientGuardProofReceipt(store, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const serialized = JSON.stringify(receipt);

  assert.deepEqual(receipt.matrix, [
    {
      id: "allowlist-unlisted-target-refused",
      verdict: "observed",
      captureSite: "recorded-session-command-log",
      evidence: store.guard,
    },
  ]);
  assert.equal(serialized.includes(store.knownValues[0]!), false);
  assert.deepEqual(scanClientProofReceipt(receipt, store.knownValues), {
    schemaUnknownFields: 0,
    schemaInvalidFields: 0,
    patternHits: 0,
    knownValueHits: 0,
    freeFormFields: 1,
    digestFields: 1,
    receiptByteLength: serialized.length,
    nonEmpty: true,
    floorPassed: true,
  });
});

test("the guard receipt refuses a send invocation, a different refusal, or dishonest provenance", () => {
  const store = completeGuardStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };

  assert.throws(
    () =>
      buildClientGuardProofReceipt(
        {
          ...store,
          guard: { ...store.guard!, sessionSendInvocations: 1 },
        },
        current,
      ),
    /guard observation is incomplete/,
  );
  assert.throws(
    () =>
      buildClientGuardProofReceipt(
        {
          ...store,
          guard: { ...store.guard!, refusalReason: "allowlist_file_absent" },
        },
        current,
      ),
    /guard observation is incomplete/,
  );
  assert.throws(
    () => buildClientGuardProofReceipt(store, { gitHead: "f".repeat(40), treeClean: true }),
    /current head does not match/,
  );
});
