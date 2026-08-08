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
  RECEIPT_SCHEMA_VERSION,
  scanFinalGatesReceipt,
  validateFinalGatesStore,
  type CurrentRepoState,
  type FinalGatesObservationStore,
} from "./final-gates-receipt.ts";
import { compareCoverage, hundredths, parseLcov } from "./coverage-comparison.ts";
import { parseLedgerRounds } from "./ledger-rounds.ts";
import {
  CHILD_ENV_ALLOWLIST,
  childEnvironment,
  forbiddenChildEnvironmentLeaks,
} from "./child-environment.ts";

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
    preExistingSourceIdentityCount: 100,
    headUncoveredSourceIdentityCount: 5,
    newlyUncoveredPreExistingCount: 0,
    uncoveredNewSourceCount: 5,
    newSourceMissesTrackedByIssue: 148,
    realGateExit: 0,
    raisedFloorHundredths: 9674,
    raisedFloorExit: 1,
    selfTestBaseVsBaseRegressions: 0,
    selfTestInvertedRegressions: 9,
    selfTestEmptyCorpusRefused: true,
    selfTestPlantedPreExistingRegressionCount: 1,
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
    {
      id: "empty-glob-exits-zero-with-no-tests",
      verdict: "observed",
      exitCode: 0,
      observedCount: 0,
      controlCount: 569,
    },
    {
      id: "empty-glob-still-exits-zero-under-coverage-floor",
      verdict: "observed",
      exitCode: 0,
      observedCount: 0,
      controlCount: 94,
    },
    {
      id: "suite-glob-is-non-recursive",
      verdict: "observed",
      exitCode: 0,
      observedCount: 39,
      controlCount: 39,
    },
  ],
  redProbes: [
    { id: "coverage-gate-at-a-raised-floor", verdict: "observed", greenExit: 0, redExit: 1 },
    { id: "test-runner-reports-a-planted-failure", verdict: "observed", greenExit: 0, redExit: 1 },
    { id: "coverage-comparator-has-direction", verdict: "observed", greenExit: 0, redExit: 9 },
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
  childEnvironment: {
    allowlistedKeyCount: 17,
    parentKeyCount: 64,
    childKeyCount: 8,
    forbiddenLeakCount: 0,
    parentCarriedNodeTestContext: true,
    childCarriedNodeTestContext: false,
    contaminatedChildExit: 0,
    cleanChildExit: 1,
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
      roundsAttributed: 3,
      highestRoundNumber: 3,
      counterRestartsAtOne: true,
      withinCeiling: true,
      replanRequired: false,
      replanRecorded: true,
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
    classCount: 9,
    classSectionCount: 1,
    unattributedRoundCount: 0,
    attributedRoundCount: 3,
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
      newlyUncoveredPreExistingCount: 1,
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
    /disagrees with pre-existing source loss/u,
  );
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ coverage: { ...regressed.coverage, regressedFileCount: 2 } }),
        current,
      ),
    /does not match its own count/u,
  );

  // One file regressing on all three metrics is three rows and one file. The
  // count is over files, so this must be accepted — the length comparison it
  // replaces rejected exactly this, which is the shape the real run produced.
  const threeMetrics = store({
    coverage: {
      ...store().coverage,
      regressedFileCount: 1,
      newlyUncoveredPreExistingCount: 1,
      regressions: (["lines", "branches", "functions"] as const).map((metric) => ({
        path: "src/runtime/runtime.ts",
        metric,
        baseHundredths: 9928,
        headHundredths: 9893,
        baseUncovered: 7,
        headUncovered: 9,
      })),
      verdict: "failed" as const,
    },
  });
  assert.doesNotThrow(() => validateFinalGatesStore(threeMetrics, current));
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
            {
              id: "suite-glob-is-non-recursive",
              verdict: "failed",
              exitCode: 1,
              observedCount: 0,
              controlCount: 0,
            },
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

test("a child environment that inherits the parent's is a refusal", () => {
  const withChild = (
    patch: Partial<FinalGatesObservationStore["childEnvironment"]>,
  ): FinalGatesObservationStore =>
    store({ childEnvironment: { ...store().childEnvironment, ...patch } });

  assert.throws(
    () => validateFinalGatesStore(withChild({ forbiddenLeakCount: 1 }), current),
    /a forbidden variable reached the child environment/u,
  );
  assert.throws(
    () => validateFinalGatesStore(withChild({ childCarriedNodeTestContext: true }), current),
    /carries NODE_TEST_CONTEXT/u,
  );
  // A spread of process.env is exactly as wide as the parent's, so "not
  // narrower" is what an inherited environment looks like from here.
  assert.throws(
    () => validateFinalGatesStore(withChild({ childKeyCount: 64 }), current),
    /not narrower than the parent/u,
  );
  assert.throws(
    () => validateFinalGatesStore(withChild({ childKeyCount: 0 }), current),
    /is empty, so it was never built/u,
  );
});

test("the NODE_TEST_CONTEXT control must reproduce, or its exclusion proves nothing", () => {
  const withChild = (
    patch: Partial<FinalGatesObservationStore["childEnvironment"]>,
  ): FinalGatesObservationStore =>
    store({ childEnvironment: { ...store().childEnvironment, ...patch } });

  // Excluding a variable the parent never had is an absence proving nothing.
  assert.throws(
    () => validateFinalGatesStore(withChild({ parentCarriedNodeTestContext: false }), current),
    /so excluding it proves nothing/u,
  );
  // The planted positive: a contaminated child that did NOT go falsely green
  // means the hazard did not reproduce, so the guard is unproven here.
  assert.throws(
    () => validateFinalGatesStore(withChild({ contaminatedChildExit: 1 }), current),
    /contamination control did not reproduce/u,
  );
  // And a clean child that also exits 0 makes the two legs indistinguishable.
  assert.throws(
    () => validateFinalGatesStore(withChild({ cleanChildExit: 0 }), current),
    /contamination control did not reproduce/u,
  );
});

test("the four-round ceiling is enforced per pull request, not globally", () => {
  const withPullRequests = (
    ...entries: readonly Partial<FinalGatesObservationStore["pullRequests"][number]>[]
  ): FinalGatesObservationStore => {
    const pullRequests = entries.map((entry, index) => ({
      ...store().pullRequests[0]!,
      number: 200 + index,
      ...entry,
    }));
    return store({
      pullRequests,
      // The ledger's own total must agree with the rows, or the cross-check
      // fires first and this test would pass for the wrong reason.
      ledger: {
        ...store().ledger,
        attributedRoundCount: pullRequests.reduce((sum, pr) => sum + pr.roundsAttributed, 0),
      },
    });
  };

  // The shape a global maximum cannot see: one PR within the ceiling and
  // another over it. `Math.max` over the whole ledger reports the same number
  // whichever PR owns the rounds, so it cannot attribute the breach.
  assert.throws(
    () =>
      validateFinalGatesStore(
        withPullRequests(
          { roundsAttributed: 2, highestRoundNumber: 2 },
          { roundsAttributed: 5, highestRoundNumber: 5, withinCeiling: false },
        ),
        current,
      ),
    /PR #201 exceeded the four-round ceiling/u,
  );

  // A counter that carried over instead of restarting — the PR #93/#94 failure,
  // where one review loop was relabelled as two attempts.
  assert.throws(
    () =>
      validateFinalGatesStore(
        withPullRequests(
          { roundsAttributed: 2, highestRoundNumber: 2 },
          { roundsAttributed: 2, highestRoundNumber: 4, counterRestartsAtOne: false },
        ),
        current,
      ),
    /round counter did not restart at 1/u,
  );

  // Hitting the ceiling forces a replan on that PR. Another PR's replan does
  // not discharge it, which a single global boolean could not express.
  assert.throws(
    () =>
      validateFinalGatesStore(
        withPullRequests(
          { roundsAttributed: 1, highestRoundNumber: 1, replanRecorded: true },
          {
            roundsAttributed: 4,
            highestRoundNumber: 4,
            replanRequired: true,
            replanRecorded: false,
          },
        ),
        current,
      ),
    /PR #201 hit the ceiling without a replan/u,
  );

  // And the same four rounds with the replan recorded is accepted, so the
  // refusals above are about the missing replan rather than the round count.
  assert.doesNotThrow(() =>
    validateFinalGatesStore(
      withPullRequests({
        roundsAttributed: 4,
        highestRoundNumber: 4,
        replanRequired: true,
        replanRecorded: true,
      }),
      current,
    ),
  );
});

test("a per-PR ceiling nobody could apply is a refusal, not a pass", () => {
  // Every PR carrying zero rounds makes each per-PR verdict vacuously true.
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({
          pullRequests: [
            { ...store().pullRequests[0]!, roundsAttributed: 0, highestRoundNumber: 0 },
          ],
          ledger: { ...store().ledger, attributedRoundCount: 0 },
        }),
        current,
      ),
    /no round was attributed to any PR/u,
  );
  // A round belonging to no mission PR is an unrecorded review loop.
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, unattributedRoundCount: 1 } }),
        current,
      ),
    /belongs to no mission PR/u,
  );
  // The per-PR rows must account for every round the ledger holds.
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, attributedRoundCount: 2 } }),
        current,
      ),
    /disagrees with the per-PR rows/u,
  );
});

test("class history is one shared, non-empty list that no PR resets", () => {
  // A second class section would be a per-PR class history — the reset the
  // contract forbids while the numeric counter restarts.
  assert.throws(
    () =>
      validateFinalGatesStore(
        store({ ledger: { ...store().ledger, classSectionCount: 2 } }),
        current,
      ),
    /exactly one non-empty shared class history/u,
  );
  assert.throws(
    () => validateFinalGatesStore(store({ ledger: { ...store().ledger, classCount: 0 } }), current),
    /exactly one non-empty shared class history/u,
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

test("the comparator separates pre-existing coverage loss from uncovered new source", () => {
  const lcov = (hits: readonly number[]): string =>
    [
      "SF:/tree/src/a.ts",
      ...hits.map((count, index) => `DA:${index + 1},${count}`),
      `LH:${hits.filter((count) => count > 0).length}`,
      `LF:${hits.length}`,
      "FNH:1",
      "FNF:1",
      "BRH:1",
      "BRF:1",
      "end_of_record",
    ].join("\n");
  const baseSources = new Map([["src/a.ts", "covered\nstays missed\ncovered duplicate\n"]]);
  const headSources = new Map([
    ["src/a.ts", "covered\nstays missed\ncovered duplicate\nnew feature miss\n"],
  ]);
  const comparison = compareCoverage(lcov([1, 0, 1]), lcov([0, 0, 1, 0]), {
    baseSources,
    headSources,
  });

  assert.deepEqual(comparison.newlyUncoveredPreExisting, ["src/a.ts:1"]);
  assert.deepEqual(comparison.uncoveredNewSource, ["src/a.ts:head:4"]);
  assert.equal(comparison.preExistingSourceIdentityCount, 4);
  assert.equal(comparison.headUncoveredSourceIdentityCount, 3);

  // Direction is load-bearing: reversing base and head reports no loss of the
  // line that is covered at the later side.
  const inverted = compareCoverage(lcov([0, 0, 1, 0]), lcov([1, 0, 1]), {
    baseSources: headSources,
    headSources: baseSources,
  });
  assert.deepEqual(inverted.newlyUncoveredPreExisting, []);
});

test("source-identity classification refuses a one-sided or empty corpus", () => {
  const lcov = [
    "SF:/tree/src/a.ts",
    "DA:1,0",
    "LH:0",
    "LF:1",
    "FNH:1",
    "FNF:1",
    "BRH:1",
    "BRF:1",
    "end_of_record",
  ].join("\n");
  assert.throws(
    () => compareCoverage(lcov, lcov, { baseSources: new Map([["src/a.ts", "x"]]) }),
    /only one source corpus/u,
  );
  assert.throws(
    () =>
      compareCoverage(lcov, lcov, {
        baseSources: new Map(),
        headSources: new Map(),
      }),
    /empty source or uncovered corpus/u,
  );
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

test("the child environment is an allowlist, not a filtered copy", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    NODE_TEST_CONTEXT: "child-v8",
    NODE_OPTIONS: "--throw-deprecation",
    AWS_SECRET_ACCESS_KEY: "unrelated",
    WHATEVER_ELSE: "unrelated",
  };
  const child = childEnvironment(parent);

  // What it keeps is named, and what it drops is everything else — including
  // variables no denylist anticipated. That is the difference between an
  // allowlist and a filtered copy.
  assert.deepEqual(Object.keys(child).sort(), ["HOME", "PATH"]);
  assert.deepEqual(forbiddenChildEnvironmentLeaks(child), []);
  assert.ok(Object.keys(child).length < Object.keys(parent).length);

  // The positive control: the same function is asked about an environment that
  // genuinely carries the forbidden variables, and reports them.
  assert.deepEqual(forbiddenChildEnvironmentLeaks(parent), ["NODE_TEST_CONTEXT", "NODE_OPTIONS"]);

  // An explicit override still reaches the child — that is how WA_LOG_LEVEL
  // and the probe's own variables get through.
  assert.equal(childEnvironment(parent, { WA_LOG_LEVEL: "silent" }).WA_LOG_LEVEL, "silent");

  // The list is the guard, so it is asserted rather than trusted: no forbidden
  // variable may be added to it, and it may not quietly become a wildcard.
  assert.deepEqual(
    CHILD_ENV_ALLOWLIST.filter((key) => forbiddenChildEnvironmentLeaks({ [key]: "x" }).length > 0),
    [],
  );
  assert.equal(new Set(CHILD_ENV_ALLOWLIST).size, CHILD_ENV_ALLOWLIST.length);
});

test("rounds are attributed to the PR whose commits they name", () => {
  const ledger = [
    "## Classes",
    "",
    "### C1 — a class",
    "",
    "### C2 — another class",
    "",
    "## #106 — review rounds",
    "",
    "### Round 1 — `aaaaaaa`",
    "",
    "Replanned rather than patched again.",
    "",
    "### Round 2 — `bbbbbbb`",
    "",
    "## #105 — review rounds",
    "",
    "### Round 1 — `ccccccc`",
    "",
  ].join("\n");
  const commits = new Map<number, readonly string[]>([
    [125, ["a".repeat(40), "b".repeat(40)]],
    [116, ["c".repeat(40)]],
    [120, ["d".repeat(40)]],
  ]);
  const report = parseLedgerRounds(ledger, commits, 4);
  const of = (number: number) => report.pullRequests.find((entry) => entry.number === number)!;

  assert.equal(of(125).roundsAttributed, 2);
  assert.equal(of(125).highestRoundNumber, 2);
  assert.equal(of(116).roundsAttributed, 1);
  assert.equal(of(116).highestRoundNumber, 1);
  // A PR with no rounds is not a PR that breached anything.
  assert.equal(of(120).roundsAttributed, 0);
  assert.equal(of(120).withinCeiling, true);
  assert.deepEqual(report.unattributedCommits, []);
  assert.equal(report.classCount, 2);
  assert.equal(report.classSectionCount, 1);

  // The replan is scoped to the section its own PR owns. #116's rounds sit in
  // a different section, so #106's replan does not discharge #116.
  assert.equal(of(125).replanRecorded, true);
  assert.equal(of(116).replanRecorded, false);

  // A global maximum would report 2 for this ledger and call it compliant;
  // per-PR, the same document says #125 ran two rounds and #116 ran one.
  assert.notDeepEqual(
    report.pullRequests.map(({ highestRoundNumber }) => highestRoundNumber),
    report.pullRequests.map(() => 2),
  );
});

test("a round whose commit belongs to no mission PR is reported, never dropped", () => {
  const ledger = ["## Rounds", "", "### Round 1 — `fedcba9`", ""].join("\n");
  const report = parseLedgerRounds(ledger, new Map([[125, ["a".repeat(40)]]]), 4);

  assert.deepEqual(report.unattributedCommits, ["fedcba9"]);
  assert.equal(report.pullRequests[0]!.roundsAttributed, 0);
  // The positive control: the same heading against the PR that owns it is
  // attributed, so the report above is about ownership and not about parsing.
  const owned = parseLedgerRounds(ledger, new Map([[125, [`fedcba9${"0".repeat(33)}`]]]), 4);
  assert.deepEqual(owned.unattributedCommits, []);
  assert.equal(owned.pullRequests[0]!.roundsAttributed, 1);
});

test("the ledger this repository ships keeps every PR under the ceiling", () => {
  const ledgerText = readFileSync(path.join(root, "docs/client-stack-defect-ledger.md"), "utf8");
  // The real commits, so this reads the shipped document rather than a fixture.
  const commits = new Map<number, readonly string[]>([
    [125, ["c81b671", "b513985", "018ca47", "e8d2028", "21b1816", "5d195df"]],
    [116, ["4ecd58f", "cfd8bc5", "c57714f", "6db9e58", "3e87ee7", "ebfc14e", "98c01c4"]],
  ]);
  const report = parseLedgerRounds(ledgerText, commits, ROUND_CEILING);

  assert.ok(report.headings.length > 0, "no rounds were parsed, so this proves nothing");
  assert.deepEqual(report.unattributedCommits, [], "a round belongs to no known PR");
  assert.equal(report.classSectionCount, 1);
  assert.ok(report.classCount > 0);
  for (const pr of report.pullRequests) {
    assert.ok(pr.withinCeiling, `PR #${pr.number} exceeded the ceiling`);
    assert.ok(pr.counterRestartsAtOne, `PR #${pr.number} did not restart its counter`);
    if (pr.replanRequired) assert.ok(pr.replanRecorded, `PR #${pr.number} needs a replan`);
  }
});

test("an older receipt is complete for its own version, a new one for the current schema", () => {
  const fresh = buildFinalGatesReceipt(store(), current) as Record<string, unknown>;
  assert.equal(fresh.schemaVersion, RECEIPT_SCHEMA_VERSION);
  assert.deepEqual(missingFinalGatesFields(fresh), []);

  // Strip everything version 2 added and label it version 1: that is exactly a
  // receipt written before this change, and it is complete for what it claims.
  const older: Record<string, unknown> = structuredClone(fresh);
  older.schemaVersion = 1;
  delete (older.safety as Record<string, unknown>).childEnvironment;
  const process_ = older.process as Record<string, unknown>;
  const ledger = process_.ledger as Record<string, unknown>;
  for (const key of [
    "classCount",
    "classSectionCount",
    "unattributedRoundCount",
    "attributedRoundCount",
  ])
    delete ledger[key];
  process_.pullRequests = (process_.pullRequests as Record<string, unknown>[]).map((pr) => {
    const copy = { ...pr };
    for (const key of [
      "roundsAttributed",
      "highestRoundNumber",
      "counterRestartsAtOne",
      "withinCeiling",
      "replanRequired",
      "replanRecorded",
    ])
      delete copy[key];
    return copy;
  });
  assert.deepEqual(missingFinalGatesFields(older), []);

  // The exemption is version-scoped, not a hole: the same stripped body
  // claiming the current version is incomplete, and says so field by field.
  const lying = { ...structuredClone(older), schemaVersion: RECEIPT_SCHEMA_VERSION };
  const missing = missingFinalGatesFields(lying);
  assert.ok(missing.includes("/safety/childEnvironment/forbiddenLeakCount"));
  assert.ok(missing.includes("/process/pullRequests/*/counterRestartsAtOne"));

  // And a version 1 receipt is still held to every field version 1 had, so the
  // exemption did not quietly excuse the whole schema.
  const trimmed = structuredClone(older);
  delete (trimmed.safety as Record<string, unknown>).leakScan;
  assert.ok(missingFinalGatesFields(trimmed).length > 0);
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
