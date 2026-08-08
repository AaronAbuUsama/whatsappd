import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./_expect.ts";
import {
  CANDIDATE_VERSION,
  FINAL_GATES_SCOPE,
  PLAN_FLOOR,
  ROUND_CEILING,
  buildFinalGatesReceipt,
  deriveFinalGatesVerdict,
  missingFinalGatesFields,
  scanFinalGatesReceipt,
  validateFinalGatesStore,
  type CurrentRepoState,
  type FinalGatesObservationStore,
} from "./final-gates-receipt.ts";
import { compareCoverage, hundredths, parseLcov } from "./coverage-comparison.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Stand-ins for the real run's known values: account-shaped strings the run
// held and the receipt must not quote back. They are absent from a clean
// receipt, which is the only way their hit count means anything — `origin/master`
// would be a useless control, because the receipt names that ref legitimately.
const KNOWN_VALUES = ["15551234567@s.whatsapp.net", "120363042384062365@g.us", ".proof-private"];
const gitSha = (seed: string): string => "b".repeat(39) + seed;

const store = (
  overrides: Partial<FinalGatesObservationStore> = {},
): FinalGatesObservationStore => ({
  runStart: {
    captureSite: "final-gates-proof-run-start",
    gitHead: gitSha("0"),
    sourceTreeHash: gitSha("1"),
    treeClean: true,
    startedAt: "2026-08-08T00:00:00Z",
  },
  finalizedAt: "2026-08-08T00:30:00Z",
  knownValues: [...KNOWN_VALUES],
  publication: {
    candidateTag: `v${CANDIDATE_VERSION}`,
    candidateTagPresentLocal: false,
    tagQuerySawKnownTag: true,
    candidateTagPresentRemote: false,
    remoteTagQuerySawKnownTag: true,
    remoteTagVerdict: "observed",
    registryCandidateStatus: 404,
    registryControlStatus: 200,
    registryVersionCount: 4,
    candidateInPackument: false,
    registryVerdict: "observed",
    npmViewDirectExit: 1,
    npmViewPipedExit: 0,
    npmViewControlDirectExit: 1,
    releaseWorkflowDiffLineCount: 0,
    workflowDiffQuerySawAKnownDifference: true,
    releaseRunsOnCandidateBranch: 0,
    releaseRunQuerySawAKnownRun: true,
    releaseRunVerdict: "observed",
    candidateBranchPresentOnRemote: false,
    remoteBranchQuerySawKnownBranch: true,
    remoteBranchVerdict: "observed",
  },
  coverage: {
    baseRef: "origin/master",
    baseSha: gitSha("2"),
    headSha: gitSha("0"),
    measuredInOneSession: true,
    baseFileCount: 34,
    headFileCount: 48,
    comparedFileCount: 34,
    newAtHeadCount: 14,
    removedAtHeadCount: 0,
    aggregateHeadLinesHundredths: 9624,
    aggregateHeadBranchesHundredths: 8842,
    aggregateHeadFunctionsHundredths: 9089,
    aggregateBaseLinesHundredths: 9584,
    aggregateBaseBranchesHundredths: 8690,
    aggregateBaseFunctionsHundredths: 8955,
    aggregateMeetsFloor: true,
    regressedFileCount: 0,
    regressions: [],
    denominatorOnlyFileCount: 0,
    realGateExit: 0,
    raisedFloorHundredths: 9674,
    raisedFloorExit: 1,
    selfTestBaseVsBaseRegressions: 0,
    selfTestInvertedRegressions: 9,
    selfTestEmptyCorpusRefused: true,
    verdict: "observed",
  },
  suite: {
    planPresent: true,
    planCount: 569,
    testsCount: 569,
    passCount: 569,
    failCount: 0,
    skippedCount: 0,
    todoCount: 0,
    onDiskTestFileCount: 39,
    perFileTotal: 569,
    perFileZeroCount: 0,
    perFileTotalEqualsPlan: true,
    verdict: "observed",
  },
  traps: [
    { id: "empty-glob", verdict: "observed", exitCode: 0, observedCount: 0, controlCount: 569 },
    {
      id: "empty-glob-coverage",
      verdict: "observed",
      exitCode: 0,
      observedCount: 0,
      controlCount: 94,
    },
    {
      id: "non-recursive-glob",
      verdict: "observed",
      exitCode: 0,
      observedCount: 39,
      controlCount: 39,
    },
  ],
  redProbes: [
    { id: "coverage-floor", verdict: "observed", greenExit: 0, redExit: 1 },
    { id: "planted-failure", verdict: "observed", greenExit: 0, redExit: 1 },
    { id: "comparator-direction", verdict: "observed", greenExit: 0, redExit: 9 },
  ],
  staticGates: { check: 0, checkDocs: 0, checkDupes: 0, checkUnused: 0, proofPack: 0 },
  duplicationHundredthsOfPercent: 7,
  duplicationCeilingHundredthsOfPercent: 30,
  cloneCount: 1,
  leakScan: {
    corpusFileCount: 342,
    baseMatchValueCount: 6,
    headMatchValueCount: 7,
    newValueCount: 1,
    newValuesAllKnownSynthetic: true,
    hiddenFlagWithoutHits: 0,
    hiddenFlagWithHits: 1,
  },
  proofPrivate: {
    trackedFileCount: 0,
    ignored: true,
    statusHitCount: 0,
    controlTrackedPathFileCount: 21,
  },
  profiles: [
    {
      id: "android",
      verdict: "observed",
      directoryInode: 464_236_357,
      databaseInode: 464_236_382,
      databaseByteLength: 954_368,
      fileCount: 27,
      credentialRowCount: 1,
      hasIdentity: true,
      hasAccount: true,
      hasNoiseKey: true,
    },
    {
      id: "ios",
      verdict: "observed",
      directoryInode: 464_236_385,
      databaseInode: 464_236_660,
      databaseByteLength: 6_397_952,
      fileCount: 587,
      credentialRowCount: 1,
      hasIdentity: true,
      hasAccount: true,
      hasNoiseKey: true,
    },
  ],
  pullRequests: [
    {
      number: 116,
      verdict: "observed",
      headCommit: "98c01c4",
      headClaimPresent: true,
      headClaimMatchesACommit: true,
      commitCount: 7,
      reviewCount: 0,
      commentCount: 7,
      distinctCommentAuthorCount: 1,
    },
  ],
  ledger: {
    maxRoundsRecorded: 3,
    roundCeiling: ROUND_CEILING,
    withinCeiling: true,
    replanRecorded: true,
    classHistoryDoesNotReset: true,
    reviewerSubstitutionRecorded: true,
    ownerConfirmationRecorded: true,
    independentGraderVerdict: "not_observed",
  },
  ...overrides,
});

const current: CurrentRepoState = { gitHead: gitSha("0"), treeClean: true };

test("a complete observation store builds a receipt that scans clean", () => {
  const receipt = buildFinalGatesReceipt(store(), current);
  assert.equal(receipt.scope, FINAL_GATES_SCOPE);
  assert.equal(receipt.tier, "P0");
  assert.deepEqual(missingFinalGatesFields(receipt), []);
  const scan = scanFinalGatesReceipt(receipt, KNOWN_VALUES);
  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.ok(scan.floorPassed);
});

test("the writer refuses a dirty tree and a head that moved", () => {
  assert.throws(
    () => validateFinalGatesStore(store(), { ...current, treeClean: false }),
    /worktree is dirty/u,
  );
  assert.throws(
    () => validateFinalGatesStore(store(), { ...current, gitHead: gitSha("9") }),
    /does not match the captured run head/u,
  );
});

test("a tag, a published version, or a pushed branch is a refusal", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, candidateTagPresentLocal: true } }),
        current,
      ),
    /tagging is owner-held/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, candidateTagPresentRemote: true } }),
        current,
      ),
    /a remote tag for this version exists/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, candidateInPackument: true } }),
        current,
      ),
    /publishing is owner-held/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, candidateBranchPresentOnRemote: true } }),
        current,
      ),
    /was pushed to the remote/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, releaseWorkflowDiffLineCount: 3 } }),
        current,
      ),
    /release workflow differs/u,
  );
});

test("an absence whose query never saw anything is a refusal", () => {
  // The defect this replaces: a field that cannot disagree with reality. A tag
  // query that returns nothing for everything proves no absence at all.
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, tagQuerySawKnownTag: false } }),
        current,
      ),
    /proves no absence/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ publication: { ...store().publication, registryControlStatus: 500 } }),
        current,
      ),
    /a 404 proves nothing/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({
          publication: { ...store().publication, workflowDiffQuerySawAKnownDifference: false },
        }),
        current,
      ),
    /cannot see a difference that exists/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ proofPrivate: { ...store().proofPrivate, controlTrackedPathFileCount: 0 } }),
        current,
      ),
    /an empty result proves nothing/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ leakScan: { ...store().leakScan, headMatchValueCount: 0 } }),
        current,
      ),
    /matched nothing at all/u,
  );
  assert.throws(
    () => validateFinalGatesStore(store({ cloneCount: 0 }), current),
    /found no clones/u,
  );
});

test("a coverage regression is recorded, not refused, but the verdict must agree", () => {
  const regressed = store({
    coverage: {
      ...store().coverage,
      regressedFileCount: 1,
      regressions: [
        {
          path: "src/session.ts",
          metric: "lines",
          baseHundredths: 9229,
          headHundredths: 9124,
          baseUncovered: 54,
          headUncovered: 58,
        },
      ],
      verdict: "failed",
    },
  });
  assert.doesNotThrow(() => validateFinalGatesStore(regressed, current));
  assert.equal(deriveFinalGatesVerdict(regressed), "failed");
  assert.equal(buildFinalGatesReceipt(regressed, current).verdict, "failed");

  // A verdict that disagrees with its own regression list is the shape that
  // lets a red run read as green.
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...regressed.coverage, verdict: "observed" } }),
        current,
      ),
    /disagrees with its own regression list/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...regressed.coverage, regressedFileCount: 2 } }),
        current,
      ),
    /does not match its own count/u,
  );
});

test("an inert coverage gate and a directionless comparator are refusals", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...store().coverage, raisedFloorExit: 0 } }),
        current,
      ),
    /the gate is inert/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...store().coverage, selfTestInvertedRegressions: 0 } }),
        current,
      ),
    /has no direction/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...store().coverage, selfTestEmptyCorpusRefused: false } }),
        current,
      ),
    /passes an empty corpus/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...store().coverage, comparedFileCount: 0 } }),
        current,
      ),
    /compared no files/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...store().coverage, measuredInOneSession: false } }),
        current,
      ),
    /not measured in one session/u,
  );
});

test("a suite that did not execute is a refusal", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(store({ suite: { ...store().suite, planPresent: false } }), current),
    /no plan line/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ suite: { ...store().suite, planCount: PLAN_FLOOR - 1 } }),
        current,
      ),
    /below the 421 floor/u,
  );
  for (const key of ["failCount", "skippedCount", "todoCount"] as const)
    assert.throws(
      () => validateFinalGatesStore(store({ suite: { ...store().suite, [key]: 1 } }), current),
      /failed, skipped or deferred/u,
    );
  assert.throws(
    () =>
      validateFinalGatesStore(store({ suite: { ...store().suite, perFileZeroCount: 1 } }), current),
    /contributed no tests/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ suite: { ...store().suite, perFileTotalEqualsPlan: false } }),
        current,
      ),
    /do not sum to the executed plan/u,
  );
});

test("a trap or red probe that never went red is a refusal", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({
          traps: [
            { id: "x", verdict: "failed", exitCode: 1, observedCount: 0, controlCount: 0 },
            ...store().traps,
          ],
        }),
        current,
      ),
    /was not observed/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({
          redProbes: store().redProbes.map((probe) => ({ ...probe, redExit: 0 })),
        }),
        current,
      ),
    /never went red/u,
  );
});

test("lost profile material and a shared inode are refusals", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({
          profiles: store().profiles.map((profile) => ({ ...profile, hasNoiseKey: false })),
        }),
        current,
      ),
    /lost resumable credential material/u,
  );
  const [android, ios] = store().profiles;
  assert.ok(android && ios);
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ profiles: [android, { ...ios, databaseInode: android.databaseInode }] }),
        current,
      ),
    /share an inode/u,
  );
});

test("a leaked account-shaped value that is not known-synthetic is a refusal", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({
          leakScan: { ...store().leakScan, newValueCount: 1, newValuesAllKnownSynthetic: false },
        }),
        current,
      ),
    /not known-synthetic/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ leakScan: { ...store().leakScan, hiddenFlagWithHits: 0 } }),
        current,
      ),
    /--hidden was not shown to be load-bearing/u,
  );
});

test("exceeding the four-round ceiling without a replan is a refusal", () => {
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, maxRoundsRecorded: 5, withinCeiling: false } }),
        current,
      ),
    /exceeded the four-round ceiling/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, maxRoundsRecorded: 0 } }),
        current,
      ),
    /found no rounds/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, replanRecorded: false } }),
        current,
      ),
    /no replan is recorded/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, classHistoryDoesNotReset: false } }),
        current,
      ),
    /class history survives a restart/u,
  );
});

test("a not_observed row keeps the run's verdict out of green", () => {
  // The whole point of the enum: an absence is never presented as success.
  assert.equal(deriveFinalGatesVerdict(store()), "not_observed");
  const fullyObserved = store({
    ledger: { ...store().ledger, independentGraderVerdict: "observed" },
  });
  assert.equal(deriveFinalGatesVerdict(fullyObserved), "observed");
});

test("the receipt refuses to carry a field the schema does not name", () => {
  const receipt = buildFinalGatesReceipt(store(), current) as Record<string, unknown>;
  assert.equal(scanFinalGatesReceipt(receipt, KNOWN_VALUES).schemaUnknownFields, 0);
  assert.equal(
    scanFinalGatesReceipt({ ...receipt, surprise: "unschemad" }, KNOWN_VALUES).schemaUnknownFields,
    1,
  );
});

test("a known value appearing in the receipt is caught", () => {
  const receipt = buildFinalGatesReceipt(store(), current) as Record<string, unknown>;
  assert.equal(scanFinalGatesReceipt(receipt, KNOWN_VALUES).knownValueHits, 0);
  // The control that makes the zero above mean something: a value that IS in
  // the receipt is found by the identical scanner.
  assert.equal(scanFinalGatesReceipt(receipt, [FINAL_GATES_SCOPE]).knownValueHits, 1);
});

test("the comparator sees a per-file drop the aggregate hides", () => {
  // The reason per-file is the gate: total coverage rises while a file loses
  // the only test it had.
  const base = [
    "SF:/base/src/a.ts",
    "LH:10",
    "LF:10",
    "FNH:2",
    "FNF:2",
    "BRH:2",
    "BRF:2",
    "end_of_record",
    "SF:/base/src/b.ts",
    "LH:5",
    "LF:10",
    "FNH:1",
    "FNF:2",
    "BRH:1",
    "BRF:2",
    "end_of_record",
  ].join("\n");
  const head = [
    "SF:/head/src/a.ts",
    "LH:5",
    "LF:10",
    "FNH:1",
    "FNF:2",
    "BRH:1",
    "BRF:2",
    "end_of_record",
    "SF:/head/src/b.ts",
    "LH:10",
    "LF:10",
    "FNH:2",
    "FNF:2",
    "BRH:2",
    "BRF:2",
    "end_of_record",
  ].join("\n");
  const comparison = compareCoverage(base, head);
  assert.equal(comparison.aggregateBase.lines, comparison.aggregateHead.lines);
  assert.deepEqual(
    comparison.regressions.map((entry) => `${entry.path}:${entry.metric}`),
    ["src/a.ts:lines", "src/a.ts:branches", "src/a.ts:functions"],
  );
});

test("the comparator refuses an empty corpus rather than reporting it clean", () => {
  assert.throws(() => compareCoverage("", ""), /the corpus is empty/u);
  assert.equal(parseLcov("").size, 0);
});

test("the branch tolerance is branch-only and named-file-only", () => {
  const record = (file: string, brh: number, brf: number, lh: number): string =>
    [
      `SF:/x/${file}`,
      `LH:${lh}`,
      "LF:1000",
      "FNH:10",
      "FNF:10",
      `BRH:${brh}`,
      `BRF:${brf}`,
      "end_of_record",
    ].join("\n");

  // A 0.2-point branch dip on a tolerated file is absorbed...
  const tolerated = compareCoverage(
    record("src/runtime/runtime.ts", 9520, 10_000, 1000),
    record("src/runtime/runtime.ts", 9500, 10_000, 1000),
  );
  assert.deepEqual(tolerated.regressions, []);

  // ...but the same dip on any other file is a regression...
  const untolerated = compareCoverage(
    record("src/session.ts", 9520, 10_000, 1000),
    record("src/session.ts", 9500, 10_000, 1000),
  );
  assert.deepEqual(
    untolerated.regressions.map((entry) => entry.metric),
    ["branches"],
  );

  // ...and lines are never tolerated, even on a tolerated file.
  const lines = compareCoverage(
    record("src/runtime/runtime.ts", 9520, 10_000, 1000),
    record("src/runtime/runtime.ts", 9520, 10_000, 995),
  );
  assert.deepEqual(
    lines.regressions.map((entry) => entry.metric),
    ["lines"],
  );
});

test("a percentage that falls without new misses is annotated, never forgiven", () => {
  const record = (lh: number, lf: number): string =>
    [
      `SF:/x/src/a.ts`,
      `LH:${lh}`,
      `LF:${lf}`,
      "FNH:10",
      "FNF:10",
      "BRH:10",
      "BRF:10",
      "end_of_record",
    ].join("\n");

  // Growing covered code around the same three misses raises the percentage,
  // so there is nothing to report.
  assert.equal(compareCoverage(record(97, 100), record(197, 200)).regressions.length, 0);

  // Shrinking it around the same three misses lowers the percentage while
  // nothing new became uncovered. Still a regression — and labelled.
  const shrank = compareCoverage(record(97, 100), record(27, 30));
  assert.equal(shrank.regressions.length, 1);
  assert.deepEqual(shrank.denominatorOnly, ["src/a.ts"]);

  // A real loss is never labelled denominator-only.
  const lost = compareCoverage(record(97, 100), record(90, 100));
  assert.equal(lost.regressions.length, 1);
  assert.deepEqual(lost.denominatorOnly, []);
});

test("hundredths are integers, so rounding is never a regression", () => {
  assert.equal(hundredths(1, 3), 3333);
  assert.equal(hundredths(2, 3), 6667);
  assert.equal(hundredths(0, 0), 10_000, "an empty denominator is complete, not zero");
  assert.ok(Number.isSafeInteger(hundredths(969, 976)));
});

test("every committed final-gates receipt still scans clean and names this scope", () => {
  const directory = path.join(root, ".proof-receipts");
  const all = readdirSync(directory).filter((name) => name.endsWith(".json"));
  // The skip-proofing floor is the receipts directory, not the final-gates
  // subset. It cannot be the subset: this test runs *inside* the suite that the
  // final-gates proof executes before it writes its receipt, so requiring one
  // here would make the first run unable to produce the artifact that would
  // satisfy it. What that costs is real and is stated rather than hidden —
  // deleting every final-gates receipt would leave this test green. What it
  // still catches is the thing that actually happens: a receipt drifting out of
  // schema as the writer changes.
  assert.ok(all.length > 0, "the receipts directory is empty, so this scan proves nothing");
  for (const name of all.filter((entry) => entry.startsWith("issue112-final-p0.run"))) {
    const receipt = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(receipt.scope, FINAL_GATES_SCOPE, `${name} names a different scope`);
    assert.equal(receipt.tier, "P0", `${name} claims a tier this proof does not reach`);
    assert.deepEqual(missingFinalGatesFields(receipt), [], `${name} is missing schema fields`);
    const scan = scanFinalGatesReceipt(receipt, KNOWN_VALUES);
    assert.equal(scan.schemaUnknownFields, 0, `${name} carries an unschema'd field`);
    assert.equal(scan.schemaInvalidFields, 0, `${name} carries an invalid field`);
    assert.equal(scan.patternHits, 0, `${name} carries account-shaped material`);
    assert.equal(scan.knownValueHits, 0, `${name} carries a known value`);
    assert.ok(scan.floorPassed, `${name} does not clear the skip-proofing floor`);
  }
});
