import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRunBSanitizationDescribesFinalObject,
  buildRunBReceipt,
  deriveRunBMatrix,
  finalizeRunBFailure,
  gatingRows,
  scanRunBReceipt,
  DERIVED_MATRIX_IDS,
  SOURCE_MATRIX_IDS,
  type RunBObservationStore,
} from "./run-b-receipt.ts";
import { test } from "./_expect.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (character: string): string => character.repeat(40);
const digest = (character: string): string => character.repeat(64);

interface MatrixRow {
  readonly id: string;
  readonly verdict: string;
  readonly notObservedReason?: string;
  readonly evidence: Record<string, unknown>;
}
const matrixOf = (receipt: Record<string, unknown>): readonly MatrixRow[] =>
  receipt.matrix as readonly MatrixRow[];
const rowOf = (receipt: Record<string, unknown>, id: string): MatrixRow =>
  matrixOf(receipt).find((row) => row.id === id)!;

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
  const once = rowOf(receipt, "challenge-consumed-exactly-once");

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
  const preserved = rowOf(receipt, "unlink-preserves-durable-chats-and-media");

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
  // No absence is ever presented as success, and none without its reason.
  assert.equal(
    finalized.every(({ verdict }) => ["observed", "not_observed", "failed"].includes(verdict)),
    true,
  );
  for (const row of finalized.filter(({ verdict }) => verdict === "not_observed"))
    assert.equal(row.notObservedReason, "the-run-ended-before-this-observation", row.id);
  for (const row of finalized.filter(({ verdict }) => verdict !== "not_observed"))
    assert.equal(row.notObservedReason, undefined, row.id);
});

test("a not_observed row without a reason, or a reason without an absence, is refused", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };
  const replace = (id: string, patch: Record<string, unknown>): RunBObservationStore => ({
    ...store,
    rows: store.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
  });

  assert.throws(
    () =>
      buildRunBReceipt(
        replace("bonus-first-link-history-sync", { verdict: "not_observed" }),
        current,
      ),
    /not_observed with no recorded reason/u,
  );
  assert.throws(
    () =>
      buildRunBReceipt(
        replace("bonus-first-link-history-sync", {
          notObservedReason: "the-run-ended-before-this-observation",
        }),
        current,
      ),
    /carries a reason it is not an absence for/u,
  );
  // The same row with both halves agreeing is accepted, so the two refusals
  // above are about the disagreement rather than about the row.
  assert.doesNotThrow(() =>
    buildRunBReceipt(
      replace("bonus-first-link-history-sync", {
        verdict: "not_observed",
        notObservedReason: "the-run-ended-before-this-observation",
      }),
      current,
    ),
  );
});

test("a sub-clause the run never observed gets its own not_observed row", () => {
  const store = completeStore();
  const receipt = buildRunBReceipt(store, { gitHead: store.runStart.gitHead, treeClean: true });

  // The three defects this split exists to correct. Each parent keeps the part
  // it genuinely observed; each sub-clause carries its own absence and says why
  // it can never be re-observed — Run B's live lifecycle is spent.
  for (const [id, reason] of [
    [
      "unlink-logout-preceded-the-clear",
      "logout-ordering-was-asserted-only-in-the-spent-unlinking-process",
    ],
    ["unlink-preserves-durable-messages", "no-message-count-was-captured-before-the-spent-unlink"],
    [
      "pair-restart-recorded-as-a-labelled-reconnect",
      "no-reconnect-was-labelled-as-the-515-restart-in-the-spent-pairing",
    ],
  ] as const) {
    const row = rowOf(receipt, id);
    assert.equal(row.verdict, "not_observed", id);
    assert.equal(row.notObservedReason, reason, id);
  }

  // The strong halves survive the split rather than being thrown away.
  assert.equal(rowOf(receipt, "unlink-clears-only-target-credentials").verdict, "observed");
  assert.equal(rowOf(receipt, "unlink-preserves-durable-chats-and-media").verdict, "observed");
  assert.equal(rowOf(receipt, "pair-links-through-one-session").verdict, "observed");
  assert.equal(
    rowOf(receipt, "unlink-preserves-durable-chats-and-media").evidence.mediaDigestEqual,
    true,
  );
  assert.equal(
    rowOf(receipt, "pair-links-through-one-session").evidence.sessionFactoryOpenCalls,
    1,
  );

  // A count is not a label: the bare reconnectCount is carried as context and
  // is explicitly not the thing the sub-clause turns on.
  const restart = rowOf(receipt, "pair-restart-recorded-as-a-labelled-reconnect");
  assert.equal(restart.evidence.reconnectCount, 2);
  assert.equal(restart.evidence.restartLabelRetained, false);
});

test("a sub-clause row is derived from evidence, never asserted by a caller", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };
  // A caller cannot hand one in: the source row set is closed, so an asserted
  // derived row is an extra row and the writer refuses the count.
  assert.throws(
    () =>
      buildRunBReceipt(
        {
          ...store,
          rows: [
            ...store.rows,
            {
              id: "unlink-logout-preceded-the-clear",
              verdict: "observed",
              captureSite: "throwaway-credentials-oracle",
              evidence: { logoutOrderingRetained: true },
            },
          ] as RunBObservationStore["rows"],
        },
        current,
      ),
    /exactly 8 source rows/u,
  );

  // And it tracks the evidence rather than a wish: the same three rows go green
  // the moment a run actually records the observations they name.
  const observed = deriveRunBMatrix(
    store.rows.map((row) => {
      if (row.id === "unlink-clears-only-target-credentials")
        return { ...row, evidence: { ...row.evidence, logoutOrderingRetained: true } };
      if (row.id === "pair-links-through-one-session")
        return { ...row, evidence: { ...row.evidence, labelledRestartReconnectCount: 1 } };
      if (row.id === "unlink-preserves-durable-chats-and-media")
        return {
          ...row,
          evidence: {
            ...row.evidence,
            phaseOneCounts: { chats: 63, contacts: 79, groups: 21, messages: 1200 },
          },
        };
      return row;
    }),
  );
  assert.deepEqual(
    observed.map(({ verdict }) => verdict),
    ["observed", "observed", "observed"],
  );
  assert.equal(
    observed.every(({ notObservedReason }) => notObservedReason === undefined),
    true,
  );
});

test("the message comparison is asymmetric: a loss fails, an addition is reported", () => {
  const store = completeStore();
  const withMessages = (before: number, after: number): readonly unknown[] =>
    deriveRunBMatrix(
      store.rows.map((row) =>
        row.id === "unlink-preserves-durable-chats-and-media"
          ? {
              ...row,
              evidence: {
                ...row.evidence,
                phaseOneCounts: { chats: 63, contacts: 79, groups: 21, messages: before },
                afterCounts: { chats: 68, contacts: 83, groups: 22, messages: after },
              },
            }
          : row,
      ),
    ).filter(({ id }) => id === "unlink-preserves-durable-messages");

  const [gained] = withMessages(1200, 1323) as [MatrixRow];
  assert.equal(gained.verdict, "observed");
  assert.equal(gained.evidence.messageShortfall, 0, "an addition is reported, not a shortfall");

  // One message fewer than before is a loss, and a loss is never absorbed.
  const [lost] = withMessages(1324, 1323) as [MatrixRow];
  assert.equal(lost.verdict, "not_observed");
  assert.equal(lost.evidence.messageShortfall, 1);
});

test("a sub-clause of a row that failed is failed, not merely unobserved", () => {
  const store = completeStore();
  // The ceiling rule: a sub-clause cannot read better than the clause it
  // belongs to, so a failed parent never leaves a green child behind it.
  const derived = deriveRunBMatrix(
    finalizeRunBFailure(store.rows, "unlink-clears-only-target-credentials", "unlink"),
  );
  const logout = derived.find(({ id }) => id === "unlink-logout-preceded-the-clear")!;

  assert.equal(logout.verdict, "failed");
  assert.equal(logout.notObservedReason, undefined);
});

test("every source row and every derived row reaches the receipt exactly once", () => {
  const store = completeStore();
  const receipt = buildRunBReceipt(store, { gitHead: store.runStart.gitHead, treeClean: true });
  const ids = matrixOf(receipt).map(({ id }) => id);

  assert.deepEqual(ids, [...SOURCE_MATRIX_IDS, ...DERIVED_MATRIX_IDS]);
  assert.equal(new Set(ids).size, ids.length);
});

test("every committed Run B receipt still scans clean and names an honest verdict", () => {
  const directory = path.join(root, ".proof-receipts");
  const names = readdirSync(directory).filter((name) => name.startsWith("issue112-p4.run"));
  // The skip-proofing floor: an empty set passes every loop ever written.
  assert.ok(names.length > 0, "no Run B receipt is committed, so this scan proves nothing");

  for (const name of names) {
    const receipt = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Record<
      string,
      unknown
    >;
    const scan = scanRunBReceipt(receipt, ["15551234567@s.whatsapp.net"]);
    assert.equal(scan.schemaUnknownFields, 0, `${name} carries an unschema'd field`);
    assert.equal(scan.schemaInvalidFields, 0, `${name} carries an invalid field`);
    assert.equal(scan.patternHits, 0, `${name} carries account-shaped material`);
    assert.equal(scan.knownValueHits, 0, `${name} carries a known value`);
    assert.ok(scan.floorPassed, `${name} does not clear the skip-proofing floor`);

    for (const row of matrixOf(receipt)) {
      assert.equal(
        row.verdict === "not_observed",
        row.notObservedReason !== undefined,
        `${name}: row ${row.id} disagrees with its own absence reason`,
      );
      // The defect this correction closes: a row claiming more than its own
      // evidence carries. Each of these reads the sub-clause the clause names.
      if (row.id === "unlink-logout-preceded-the-clear")
        assert.equal(
          row.verdict === "observed",
          row.evidence.logoutOrderingRetained === true,
          `${name}: the logout-ordering verdict contradicts its evidence`,
        );
      if (row.id === "unlink-preserves-durable-messages")
        assert.equal(
          row.verdict === "observed",
          row.evidence.beforeMessageCountRetained === true,
          `${name}: a message comparison was claimed without a before-count`,
        );
      if (row.id === "pair-restart-recorded-as-a-labelled-reconnect")
        assert.equal(
          row.verdict === "observed",
          row.evidence.restartLabelRetained === true,
          `${name}: a 515 restart was claimed from a bare reconnect count`,
        );
    }
  }
});

test("a row already measured as observed is downgraded when its own assertion fails", () => {
  const store = completeStore();
  // Every row measured, including the one whose assertion is about to fail —
  // the real shape, because measurements are recorded before the assertions
  // that judge them.
  const finalized = finalizeRunBFailure(
    store.rows,
    "unlink-preserves-durable-chats-and-media",
    "cold-open",
  );
  const failing = finalized.find(({ id }) => id === "unlink-preserves-durable-chats-and-media")!;

  assert.equal(failing.verdict, "failed", "the failing row was reported as a success");
  assert.equal(failing.evidence.stage, "cold-open");
  // Its measurements survive the downgrade rather than being thrown away.
  assert.equal(failing.evidence.mediaFileCount, 25);
  assert.equal(
    finalized.filter(({ verdict }) => verdict === "failed").length,
    1,
    "only the failing row is downgraded",
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
