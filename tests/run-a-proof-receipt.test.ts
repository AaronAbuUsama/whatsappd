import assert from "node:assert/strict";
import {
  assertRunAReceiptSanitizationDescribesFinalObject,
  buildRunAProofReceipt,
  scanRunAProofReceipt,
  type RunAProofObservationStore,
} from "./run-a-proof-receipt.ts";
import { test } from "./_expect.ts";

const sha = (character: string): string => character.repeat(40);
const digest = (character: string): string => character.repeat(64);

function completeStore(): RunAProofObservationStore {
  return {
    runStart: {
      captureSite: "run-a-proof-run-start",
      gitHead: sha("a"),
      sourceTreeHash: sha("b"),
      treeClean: true,
      startedAt: "2026-08-08T10:00:00.000Z",
    },
    finalizedAt: "2026-08-08T10:02:00.000Z",
    knownValues: ["private nonce", "private peer address", "private group address"],
    rows: [
      {
        id: "resume-unattended",
        verdict: "observed",
        captureSite: "subject-runtime-events",
        evidence: {
          linkMode: "resumed",
          challengeEventCount: 0,
          challengeProduced: false,
          interactive: false,
          subjectPid: 10,
        },
      },
      {
        id: "inbound-text",
        verdict: "observed",
        captureSite: "client-live-upsert",
        evidence: {
          observedVia: "live-upsert",
          nonceSha256: digest("1"),
          nonceLength: 32,
          chatsList: true,
          messagesGet: true,
          peerPid: 11,
          peerLinkMode: "resumed",
        },
      },
      {
        id: "inbound-document",
        verdict: "observed",
        captureSite: "client-message-record",
        evidence: {
          kind: "document",
          mediaState: "stored",
          byteLength: 256,
          byteLengthMatches: true,
          peerPid: 12,
          peerLinkMode: "resumed",
        },
      },
      {
        id: "attachment-bytes",
        verdict: "observed",
        captureSite: "client-media-read",
        evidence: {
          sentSha256: digest("2"),
          storedSha256: digest("2"),
          equal: true,
        },
      },
      {
        id: "outbound-durable-send",
        verdict: "observed",
        captureSite: "android-client-operation-and-authoritative-echo",
        evidence: {
          targetKind: "allowlisted-group",
          bodySha256: digest("3"),
          bodyLength: 48,
          idempotencyKeySha256: digest("4"),
          idempotencyKeyLength: 32,
          operationIdSha256: digest("5"),
          operationIdLength: 36,
          statusTimeline: ["queued", "claimed", "executing", "succeeded"],
          terminalStatus: "succeeded",
          messageRefIdSha256: digest("6"),
          messageRefIdLength: 22,
          messageRefFromMe: true,
          messageRefChatMatchesTarget: true,
          authoritativeEchoCount: 1,
          sessionSendInvocationsBefore: 0,
          sessionSendInvocationsAfter: 1,
        },
      },
      {
        id: "saved-state",
        verdict: "observed",
        captureSite: "subject-client-runtime-backend-close",
        evidence: {
          closeOrder: ["client", "runtime", "backend"],
          durableDigest: {
            chats: digest("7"),
            contacts: digest("8"),
            groups: digest("9"),
            orderedIds: digest("a"),
            media: digest("b"),
          },
        },
      },
      {
        id: "process-replacement",
        verdict: "observed",
        captureSite: "replacement-child-result",
        evidence: {
          replacementPid: 13,
          distinctPid: true,
          durableDigestEqual: true,
          credentialIdentityMatchesOriginal: true,
          sessionAttached: true,
          liveSocketResumed: false,
          durableReconstructedWhileNoLive: true,
          connectionPresent: false,
          identityPresent: false,
          presenceObservationsRestored: 0,
          lastConnectedAtPresent: true,
          lastDisconnectedAtPresent: true,
        },
      },
    ],
  };
}

test("Run A receipt is complete, head-bound, sanitized, and omits byte length", () => {
  const store = completeStore();
  const receipt = buildRunAProofReceipt(store, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const scan = scanRunAProofReceipt(receipt, store.knownValues);

  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);
  assert.deepEqual(
    (receipt.matrix as Array<{ readonly verdict: string }>).map(({ verdict }) => verdict),
    Array(7).fill("observed"),
  );
  assert.equal(
    Object.hasOwn(receipt.sanitization as object, "receiptByteLength"),
    false,
    "Run A deliberately omits the self-referential byte-length metric",
  );
  assertRunAReceiptSanitizationDescribesFinalObject(receipt, store.knownValues);
});

test("Run A receipt refuses dishonest provenance, incomplete rows, and reused pids", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };

  assert.throws(
    () =>
      buildRunAProofReceipt(
        { ...store, runStart: { ...store.runStart, treeClean: false } },
        current,
      ),
    /dirty/,
  );
  assert.throws(() => buildRunAProofReceipt(store, { gitHead: sha("f"), treeClean: true }), /head/);
  assert.throws(
    () => buildRunAProofReceipt({ ...store, finalizedAt: undefined }, current),
    /finalized/,
  );
  assert.throws(
    () => buildRunAProofReceipt({ ...store, rows: store.rows.slice(0, -1) }, current),
    /matrix row/,
  );
  assert.throws(
    () =>
      buildRunAProofReceipt(
        {
          ...store,
          rows: store.rows.map((row) =>
            row.id === "process-replacement"
              ? {
                  ...row,
                  evidence: { ...row.evidence, replacementPid: 12 },
                }
              : row,
          ),
        },
        current,
      ),
    /distinct/,
  );
});

test("Run A can honestly finalize downstream absence after the one send landed", () => {
  const store = completeStore();
  const partial = {
    ...store,
    rows: store.rows.map((row) =>
      row.id === "saved-state" || row.id === "process-replacement"
        ? {
            id: row.id,
            verdict: "not_observed" as const,
            captureSite: "run-stage-verdict" as const,
            evidence: { stage: "subject-close" as const },
          }
        : row,
    ),
  };
  const receipt = buildRunAProofReceipt(partial, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });

  assert.deepEqual(
    (receipt.matrix as Array<{ readonly verdict: string }>).map(({ verdict }) => verdict),
    ["observed", "observed", "observed", "observed", "observed", "not_observed", "not_observed"],
  );
});

test("the final-object assertion rejects a pre-embedding byte-length metric", () => {
  const store = completeStore();
  const receipt = buildRunAProofReceipt(store, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const beforeEmbedding = scanRunAProofReceipt(
    Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "sanitization")),
    store.knownValues,
  );
  const mutated = {
    ...receipt,
    sanitization: {
      ...(receipt.sanitization as object),
      receiptByteLength: beforeEmbedding.receiptByteLength,
    },
  };

  assert.throws(
    () => assertRunAReceiptSanitizationDescribesFinalObject(mutated, store.knownValues),
    /receiptByteLength.*final serialized receipt/,
  );
});

test("all embedded metrics other than byte length are invariant when sanitization is added", () => {
  const store = completeStore();
  const receipt = buildRunAProofReceipt(store, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const withoutSanitization = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "sanitization"),
  );
  const before = scanRunAProofReceipt(withoutSanitization, store.knownValues);
  const after = scanRunAProofReceipt(receipt, store.knownValues);
  const invariantKeys = [
    "schemaUnknownFields",
    "schemaInvalidFields",
    "patternHits",
    "knownValueHits",
    "freeFormFields",
    "digestFields",
    "nonEmpty",
    "floorPassed",
  ] as const;

  for (const key of invariantKeys) assert.equal(after[key], before[key], key);
  assert.notEqual(after.receiptByteLength, before.receiptByteLength);
});
