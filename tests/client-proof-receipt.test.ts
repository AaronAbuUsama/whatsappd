import assert from "node:assert/strict";
import { test } from "./_expect.ts";
import {
  buildClientGuardProofReceipt,
  buildClientProofReceipt,
  type ClientGuardProofObservationStore,
  type ClientProofObservationStore,
} from "./client-proof-receipt.ts";
import { scanProofReceipt } from "./history-proof-receipt.ts";

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
      subjectAddressHash: "2".repeat(64),
      peerAddressHash: "3".repeat(64),
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
        addressPresent: false,
        presenceAddressCount: 130,
        presenceObservationsRestored: 0,
        lastConnectedAtPresent: true,
        lastDisconnectedAtPresent: true,
      },
    },
  };
}

test("the shared receipt scan catches native addresses and held private values", () => {
  const known = "shape-the-patterns-do-not-anticipate";
  const scan = scanProofReceipt(
    {
      digest: "1".repeat(64),
      leakedAddress: "123456789012@s.whatsapp.net",
      leakedPath: ".proof-private/android",
      opaqueSecret: "Q".repeat(80),
      known,
    },
    [known],
  );
  assert.equal(scan.patternHits >= 3, true);
  assert.equal(scan.knownValueHits, 1);
  assert.equal(scan.nonEmpty, true);
  assert.equal(scanProofReceipt({}, []).nonEmpty, false);
});

test("the Client receipt refuses incomplete proof observations", () => {
  const store = completeStore();
  assert.throws(
    () => buildClientProofReceipt({ ...store, finalizedAt: undefined }),
    /run is not finalized/,
  );
  assert.throws(
    () =>
      buildClientProofReceipt({
        ...store,
        summary: { ...store.summary!, replacementPid: store.summary!.peerPid },
      }),
    /proof processes are not distinct/,
  );
  assert.throws(
    () =>
      buildClientProofReceipt({
        ...store,
        summary: {
          ...store.summary!,
          paging: { ...store.summary!.paging, pageCount: 1 },
        },
      }),
    /required observations are missing/,
  );
});

test("the Client receipt transcribes the complete observed matrix without private values", () => {
  const store = completeStore();
  const receipt = buildClientProofReceipt(store);
  const scan = scanProofReceipt(receipt, store.knownValues);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.deepEqual(
    (receipt.matrix as Array<{ verdict: string }>).map(({ verdict }) => verdict),
    Array(10).fill("observed"),
  );
});

test("the inbound-text capture site records the Client observation path", () => {
  const store = completeStore();
  const receipt = buildClientProofReceipt({
    ...store,
    summary: {
      ...store.summary!,
      inboundText: { ...store.summary!.inboundText, observedVia: "stored-page" },
    },
  });
  const inboundText = (
    receipt.matrix as Array<{ readonly id: string; readonly captureSite: string }>
  ).find(({ id }) => id === "inbound-text");
  assert.equal(inboundText?.captureSite, "client-stored-page");
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
      "generated-canary-held-in-memory",
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

test("the guard receipt records refusal before any Session send", () => {
  const store = completeGuardStore();
  const receipt = buildClientGuardProofReceipt(store);
  assert.deepEqual(receipt.matrix, [
    {
      id: "allowlist-unlisted-target-refused",
      verdict: "observed",
      captureSite: "recorded-session-command-log",
      evidence: store.guard,
    },
  ]);
  assert.equal(scanProofReceipt(receipt, store.knownValues).knownValueHits, 0);
});

test("the guard receipt refuses a send invocation or a different refusal", () => {
  const store = completeGuardStore();
  assert.throws(
    () =>
      buildClientGuardProofReceipt({
        ...store,
        guard: { ...store.guard!, sessionSendInvocations: 1 },
      }),
    /guard observation is incomplete/,
  );
  assert.throws(
    () =>
      buildClientGuardProofReceipt({
        ...store,
        guard: { ...store.guard!, refusalReason: "allowlist_file_absent" },
      }),
    /guard observation is incomplete/,
  );
});
