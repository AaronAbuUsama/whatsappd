import assert from "node:assert/strict";
import {
  assertRunBSanitizationDescribesFinalObject,
  buildRunBReceipt,
  finalizeRunBFailure,
  gatingRows,
  scanRunBReceipt,
  type RunBObservationStore,
} from "./run-b-receipt.ts";
import { test } from "./_expect.ts";

const sha = (character: string): string => character.repeat(40);
const digest = (character: string): string => character.repeat(64);

function completeStore(): RunBObservationStore {
  const phaseOne = {
    phaseOneRunIdSha256: digest("0"),
    phaseOneGitHead: sha("a"),
    phaseOneSourceTreeHash: sha("b"),
    phaseOneLinkedAt: "2026-08-08T14:44:49.566Z",
    handoffFinalized: true,
  };
  return {
    runStart: {
      captureSite: "run-b-receipt-run-start",
      gitHead: sha("a"),
      sourceTreeHash: sha("b"),
      treeClean: true,
      startedAt: "2026-08-08T15:00:00.000Z",
    },
    mode: "verify",
    finalizedAt: "2026-08-08T15:02:00.000Z",
    knownValues: ["throwaway account id", "throwaway directory", "throwaway salt"],
    rows: [
      {
        id: "challenge-consumed-exactly-once",
        verdict: "observed",
        captureSite: "phase-one-handoff",
        evidence: {
          ...phaseOne,
          challengeValueLength: 277,
          challengeValueRetained: false,
          laterConsumeNullsRetained: true,
          onceOnlyEvidence: "handoff-finalized-after-assertions",
        },
      },
      {
        id: "challenge-never-in-ordinary-state",
        verdict: "observed",
        captureSite: "leak-scanner-self-test",
        evidence: {
          ...phaseOne,
          positiveControlRetained: true,
          leakScanEvidence: "handoff-finalized-after-assertions",
          scannerScannedEntries: 5,
          scannerScannedBytes: 4096,
          scannerCleanCorpusHits: 0,
          scannerPlantedControlDetected: true,
          scannerControlKind: "synthetic-value-over-live-corpus",
        },
      },
      {
        id: "pair-links-through-one-session",
        verdict: "observed",
        captureSite: "phase-one-handoff",
        evidence: { ...phaseOne, sessionFactoryOpenCalls: 1, reconnectCount: 2 },
      },
      {
        id: "unlink-clears-only-target-credentials",
        verdict: "observed",
        captureSite: "throwaway-credentials-oracle",
        evidence: {
          unlinkOperationCount: 1,
          unlinkTerminalStatus: "succeeded",
          authRowCount: 0,
          credentialsCleared: true,
          logoutOrderingRetained: false,
        },
      },
      {
        id: "unlink-preserves-durable-chats-and-media",
        verdict: "observed",
        captureSite: "cold-process-client",
        evidence: {
          comparisonBasis: "phase-one-counts",
          phaseOneCounts: { chats: 63, contacts: 79, groups: 21 },
          afterCounts: { chats: 68, contacts: 83, groups: 22, messages: 1323 },
          countShortfall: { chats: 0, contacts: 0, groups: 0 },
          countAdditions: { chats: 5, contacts: 4, groups: 1 },
          durableIdDigest: { chats: digest("1"), contacts: digest("2"), groups: digest("3") },
          coldIdMissingCount: { chats: 0, contacts: 0, groups: 0 },
          mediaFileCount: 25,
          mediaDigest: digest("4"),
          coldMediaDigest: digest("4"),
          mediaDigestEqual: true,
        },
      },
      {
        id: "runtime-survives-unlink-and-accepts-repair",
        verdict: "observed",
        captureSite: "cold-process-client",
        evidence: {
          repairPairOperationCount: 1,
          repairTerminalStatus: "outcome_unknown",
          repairReachedSucceeded: false,
          credentialsStillClearedAfterRepair: true,
          coldRuntimeClosed: false,
          coldBackendReadable: true,
          coldLinkStatus: "needs_pairing",
          coldSessionFactoryOpenCalls: 0,
          coldPid: 4242,
          distinctFromPhaseOnePid: true,
          outstandingLifecycleOperations: 0,
        },
      },
      {
        id: "durable-profiles-untouched-by-run-b",
        verdict: "observed",
        captureSite: "run-b-sandbox-probe",
        evidence: {
          permissionModelEnabled: true,
          deniedProfileReadAttempts: 2,
          deniedProfileReadDenials: 2,
          durableProfileHandlesOpened: 0,
          durableProfileResumeRevalidatedHere: false,
        },
      },
      {
        id: "bonus-first-link-history-sync",
        verdict: "observed",
        captureSite: "phase-one-handoff",
        evidence: {
          ...phaseOne,
          observationKind: "native-first-link-history-sync",
          conversationSyncBatches: 3,
          conversationSyncChats: 67,
          gatesNothing: true,
        },
      },
    ],
  };
}

test("Run B receipt is complete, head-bound and mechanically sanitized", () => {
  const store = completeStore();
  const receipt = buildRunBReceipt(store, { gitHead: store.runStart.gitHead, treeClean: true });
  const scan = scanRunBReceipt(receipt, store.knownValues);

  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);
  assertRunBSanitizationDescribesFinalObject(receipt, store.knownValues);
});

test("the receipt records the challenge length and never the value or a hash of it", () => {
  const store = completeStore();
  const receipt = buildRunBReceipt(store, { gitHead: store.runStart.gitHead, treeClean: true });
  const serialized = JSON.stringify(receipt);
  const once = (receipt.matrix as Array<{ id: string; evidence: Record<string, unknown> }>).find(
    ({ id }) => id === "challenge-consumed-exactly-once",
  )!;

  assert.equal(once.evidence.challengeValueLength, 277);
  assert.equal(once.evidence.challengeValueRetained, false);
  // No field anywhere may name the challenge value, in any form.
  assert.equal(serialized.includes('challengeValue"'), false);
  assert.equal(serialized.includes("challengeValueSha256"), false);
  assert.equal(serialized.includes("challengeValueDigest"), false);
});

test("Run B receipt refuses dishonest provenance and a stale carried-forward row", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };

  assert.throws(
    () =>
      buildRunBReceipt({ ...store, runStart: { ...store.runStart, treeClean: false } }, current),
    /dirty/,
  );
  assert.throws(() => buildRunBReceipt(store, { gitHead: sha("f"), treeClean: true }), /head/);
  assert.throws(() => buildRunBReceipt({ ...store, finalizedAt: undefined }, current), /finalized/);
  assert.throws(
    () => buildRunBReceipt({ ...store, rows: store.rows.slice(0, -1) }, current),
    /exactly 8 source rows/,
  );
  assert.throws(
    () => buildRunBReceipt({ ...store, knownValues: ["only-one"] }, current),
    /known-value/,
  );
  // A phase-1 row carried across a source-tree change no longer describes the
  // head this receipt names.
  assert.throws(
    () =>
      buildRunBReceipt(
        {
          ...store,
          rows: store.rows.map((row) =>
            row.id === "pair-links-through-one-session"
              ? { ...row, evidence: { ...row.evidence, phaseOneSourceTreeHash: sha("c") } }
              : row,
          ),
        },
        current,
      ),
    /different source tree/,
  );
});

test("Run B receipt refuses an incomplete observation on each gating row", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };
  const mutate = (id: string, evidence: Record<string, unknown>): RunBObservationStore => ({
    ...store,
    rows: store.rows.map((row) =>
      row.id === id ? { ...row, evidence: { ...row.evidence, ...evidence } } : row,
    ),
  });

  assert.throws(
    () =>
      buildRunBReceipt(
        mutate("durable-profiles-untouched-by-run-b", { deniedProfileReadDenials: 1 }),
        current,
      ),
    /sandbox/,
  );
  assert.throws(
    () =>
      buildRunBReceipt(
        mutate("unlink-clears-only-target-credentials", { authRowCount: 1 }),
        current,
      ),
    /credential/,
  );
  // A tolerance in the loss direction is not a tolerance: a lost row is a
  // refusal, while additions are merely reported.
  assert.throws(
    () =>
      buildRunBReceipt(
        mutate("unlink-preserves-durable-chats-and-media", {
          coldIdMissingCount: { chats: 1, contacts: 0, groups: 0 },
        }),
        current,
      ),
    /without loss/,
  );
  assert.throws(
    () =>
      buildRunBReceipt(
        mutate("unlink-preserves-durable-chats-and-media", { mediaDigestEqual: false }),
        current,
      ),
    /without loss/,
  );
  assert.throws(
    () =>
      buildRunBReceipt(
        mutate("runtime-survives-unlink-and-accepts-repair", { repairReachedSucceeded: true }),
        current,
      ),
    /repair-and-survive/,
  );
  assert.throws(
    () =>
      buildRunBReceipt(mutate("bonus-first-link-history-sync", { gatesNothing: false }), current),
    /gates nothing/,
  );
});

test("an addition is reported rather than refused", () => {
  const store = completeStore();
  const receipt = buildRunBReceipt(store, { gitHead: store.runStart.gitHead, treeClean: true });
  const preserved = (
    receipt.matrix as Array<{ id: string; evidence: Record<string, unknown> }>
  ).find(({ id }) => id === "unlink-preserves-durable-chats-and-media")!;

  assert.deepEqual(preserved.evidence.countAdditions, { chats: 5, contacts: 4, groups: 1 });
  assert.deepEqual(preserved.evidence.countShortfall, { chats: 0, contacts: 0, groups: 0 });
});

test("the bonus row gates nothing", () => {
  const store = completeStore();
  const gating = gatingRows(store.rows);

  assert.equal(gating.length, store.rows.length - 1);
  assert.equal(
    gating.some(({ id }) => id === "bonus-first-link-history-sync"),
    false,
  );
});

test("a failure finalizes every measured row rather than losing the run", () => {
  const store = completeStore();
  const measured = store.rows.slice(0, 3);
  const finalized = finalizeRunBFailure(
    measured,
    "unlink-clears-only-target-credentials",
    "unlink",
  );

  assert.equal(finalized.length, store.rows.length);
  assert.deepEqual(
    finalized.map(({ id, verdict }) => [id, verdict]),
    [
      ["challenge-consumed-exactly-once", "observed"],
      ["challenge-never-in-ordinary-state", "observed"],
      ["pair-links-through-one-session", "observed"],
      ["unlink-clears-only-target-credentials", "failed"],
      ["unlink-preserves-durable-chats-and-media", "not_observed"],
      ["runtime-survives-unlink-and-accepts-repair", "not_observed"],
      ["durable-profiles-untouched-by-run-b", "not_observed"],
      ["bonus-first-link-history-sync", "not_observed"],
    ],
  );
  // No absence is ever presented as success.
  assert.equal(
    finalized.every(({ verdict }) => ["observed", "not_observed", "failed"].includes(verdict)),
    true,
  );
});

test("a finalized failure still produces a writable, sanitized receipt", () => {
  const store = completeStore();
  const partial = {
    ...store,
    rows: finalizeRunBFailure(
      store.rows.slice(0, 3),
      "unlink-clears-only-target-credentials",
      "unlink",
    ),
  };
  const receipt = buildRunBReceipt(partial, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const scan = scanRunBReceipt(receipt, store.knownValues);

  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.knownValueHits, 0);
});

test("the known-value control catches account material planted in the receipt", () => {
  const store = completeStore();
  const receipt = buildRunBReceipt(store, { gitHead: store.runStart.gitHead, treeClean: true });

  assert.equal(scanRunBReceipt(receipt, store.knownValues).knownValueHits, 0);
  // The same scan, asked about a value the receipt genuinely contains.
  assert.equal(scanRunBReceipt(receipt, ["P4"]).knownValueHits, 1);
});
