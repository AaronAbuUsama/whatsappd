/**
 * Schema, refusals, and writer for the 0.3.0 final-gates receipt.
 *
 * Same convention as `tests/release-candidate-receipt.ts`: the runner captures
 * head and cleanliness at source, this module transcribes, and the writer
 * refuses a mismatch.
 *
 * The tier is **P0**. This run asserts repository state — tags, the registry,
 * gate exit codes, an executed test plan, artifact safety and review history.
 * It opens no WhatsApp connection and sends nothing, so P4 would name a rung it
 * never touched; it reproduces but does not own the packed-consumer run, so P6
 * would borrow issue #112's rung.
 *
 * **This receipt is allowed to say a gate failed.** The coverage comparison is
 * the one gate whose result is not known in advance, so `verdict: "failed"` is
 * a recordable outcome rather than a refusal. Every other block refuses,
 * because a v0.3.0 tag or a published version would mean this mission did
 * something it had no authority to do, and there is no honest way to file that.
 *
 * Percentages are stored as **hundredths of a point, as integers**. A float
 * would need a schema type that admits arbitrary numbers, and the one thing
 * this scanner must never grow is a field type that accepts anything.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { childEnvironment } from "./child-environment.ts";
import {
  receiptField as field,
  scanSchemaDrivenReceipt,
  type ReceiptFieldSchema,
  type ReceiptScanReport,
} from "./proof-receipt-scan.ts";

export const FINAL_GATES_SCOPE =
  "0.3.0 final gates: publication side effects, regression floors, executed suite, artifact safety, review history";
export const CANDIDATE_VERSION = "0.3.0";
export const PLAN_FLOOR = 421;
export const COVERAGE_FLOOR_HUNDREDTHS = { lines: 9400, branches: 8500, functions: 8800 } as const;
export const ROUND_CEILING = 4;

export type Verdict = "observed" | "not_observed" | "failed";

/**
 * Trap and red-probe identifiers, as closed sets.
 *
 * These are enums rather than free-form strings, and not to dodge the leak
 * scanner. They are a fixed vocabulary: a run that invents an id is a run whose
 * harness changed, and the receipt should refuse the unrecognized label rather
 * than record it. That several of these hyphenated slugs also stop tripping the
 * ≥32-character key pattern is a consequence of typing them correctly, not the
 * reason for doing it.
 */
export const TRAP_IDS = [
  "empty-glob-exits-zero-with-no-tests",
  "empty-glob-still-exits-zero-under-coverage-floor",
  "suite-glob-is-non-recursive",
] as const;

export const RED_PROBE_IDS = [
  "coverage-gate-at-a-raised-floor",
  "test-runner-reports-a-planted-failure",
  "coverage-comparator-has-direction",
  "coverage-comparator-refuses-an-empty-corpus",
  "inherited-node-test-context-makes-a-red-child-green",
] as const;

export type TrapId = (typeof TRAP_IDS)[number];
export type RedProbeId = (typeof RED_PROBE_IDS)[number];

export interface FinalGatesRunStart {
  readonly captureSite: "final-gates-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface PublicationObservation {
  readonly candidateTag: string;
  readonly candidateTagPresentLocal: boolean;
  readonly tagQuerySawKnownTag: boolean;
  readonly candidateTagPresentRemote: boolean;
  readonly remoteTagQuerySawKnownTag: boolean;
  readonly remoteTagVerdict: Verdict;
  readonly registryCandidateStatus: number;
  readonly registryControlStatus: number;
  readonly registryVersionCount: number;
  readonly candidateInPackument: boolean;
  readonly registryVerdict: Verdict;
  readonly npmViewDirectExit: number;
  readonly npmViewPipedExit: number;
  readonly npmViewControlDirectExit: number;
  readonly releaseWorkflowDiffLineCount: number;
  readonly workflowDiffQuerySawAKnownDifference: boolean;
  readonly releaseRunsOnCandidateBranch: number;
  readonly releaseRunQuerySawAKnownRun: boolean;
  readonly releaseRunVerdict: Verdict;
  readonly candidateBranchPresentOnRemote: boolean;
  readonly remoteBranchQuerySawKnownBranch: boolean;
  readonly remoteBranchVerdict: Verdict;
}

export interface CoverageFileDrop {
  readonly path: string;
  readonly metric: string;
  readonly baseHundredths: number;
  readonly headHundredths: number;
  readonly baseUncovered: number;
  readonly headUncovered: number;
}

export interface CoverageObservation {
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly measuredInOneSession: boolean;
  readonly baseFileCount: number;
  readonly headFileCount: number;
  readonly comparedFileCount: number;
  readonly newAtHeadCount: number;
  readonly removedAtHeadCount: number;
  readonly aggregateHeadLinesHundredths: number;
  readonly aggregateHeadBranchesHundredths: number;
  readonly aggregateHeadFunctionsHundredths: number;
  readonly aggregateBaseLinesHundredths: number;
  readonly aggregateBaseBranchesHundredths: number;
  readonly aggregateBaseFunctionsHundredths: number;
  readonly aggregateMeetsFloor: boolean;
  readonly regressedFileCount: number;
  readonly regressions: readonly CoverageFileDrop[];
  readonly denominatorOnlyFileCount: number;
  readonly preExistingSourceIdentityCount: number;
  readonly headUncoveredSourceIdentityCount: number;
  readonly newlyUncoveredPreExistingCount: number;
  readonly uncoveredNewSourceCount: number;
  readonly unclassifiedRegressionCount: number;
  readonly newSourceMissesTrackedByIssue: number;
  readonly realGateExit: number;
  readonly raisedFloorHundredths: number;
  readonly raisedFloorExit: number;
  readonly selfTestBaseVsBaseRegressions: number;
  readonly selfTestInvertedRegressions: number;
  readonly selfTestEmptyCorpusRefused: boolean;
  readonly selfTestPlantedPreExistingRegressionCount: number;
  readonly selfTestPlantedPreExistingFunctionRegressionCount: number;
  readonly selfTestPlantedPreExistingBranchRegressionCount: number;
  readonly verdict: Verdict;
}

export interface SuiteObservation {
  readonly planPresent: boolean;
  readonly planCount: number;
  readonly testsCount: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly skippedCount: number;
  readonly todoCount: number;
  readonly onDiskTestFileCount: number;
  readonly perFileTotal: number;
  readonly perFileZeroCount: number;
  readonly perFileTotalEqualsPlan: boolean;
  readonly verdict: Verdict;
}

export interface TrapObservation {
  readonly id: TrapId;
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly observedCount: number;
  readonly controlCount: number;
}

export interface RedProbeObservation {
  readonly id: RedProbeId;
  readonly verdict: Verdict;
  readonly greenExit: number;
  readonly redExit: number;
}

/**
 * The environment this proof handed its spawned children.
 *
 * Children are launched with an explicit allowlist rather than a spread of
 * `process.env`. `NODE_TEST_CONTEXT` is the concrete hazard — a child launched
 * under `node --test` with it set skips its work and exits 0 — so the receipt
 * records that the parent held it, that the child did not, and that a child
 * given it really does go green on a planted failure.
 */
export interface ChildEnvironmentObservation {
  readonly allowlistedKeyCount: number;
  readonly parentKeyCount: number;
  readonly childKeyCount: number;
  readonly forbiddenLeakCount: number;
  /** The control: the parent really did carry the variable being excluded. */
  readonly parentCarriedNodeTestContext: boolean;
  readonly childCarriedNodeTestContext: boolean;
  readonly contaminatedChildExit: number;
  readonly cleanChildExit: number;
}

export interface LeakScanObservation {
  readonly corpusFileCount: number;
  readonly baseMatchValueCount: number;
  readonly headMatchValueCount: number;
  readonly newValueCount: number;
  readonly newValuesAllKnownSynthetic: boolean;
  readonly hiddenFlagWithoutHits: number;
  readonly hiddenFlagWithHits: number;
}

export interface ProofPrivateObservation {
  readonly trackedFileCount: number;
  readonly ignored: boolean;
  readonly statusHitCount: number;
  readonly controlTrackedPathFileCount: number;
}

export interface ProfileObservation {
  readonly id: string;
  readonly verdict: Verdict;
  readonly directoryInode: number;
  readonly databaseInode: number;
  readonly databaseByteLength: number;
  readonly fileCount: number;
  readonly credentialRowCount: number;
  readonly hasIdentity: boolean;
  readonly hasAccount: boolean;
  readonly hasNoiseKey: boolean;
}

export interface PullRequestObservation {
  readonly number: number;
  readonly verdict: Verdict;
  readonly headCommit: string;
  readonly headClaimPresent: boolean;
  readonly headClaimMatchesACommit: boolean;
  readonly commitCount: number;
  readonly reviewCount: number;
  readonly commentCount: number;
  readonly distinctCommentAuthorCount: number;
  /**
   * The four-round ceiling, evaluated for this pull request.
   *
   * The contract is per PR: the numeric counter restarts at 1 for each one
   * while the class history does not reset. A single global maximum over the
   * whole ledger cannot see that rule — it cannot tell a counter that restarted
   * from one that carried over, which is the PR #93/#94 failure itself.
   */
  readonly roundsAttributed: number;
  readonly highestRoundNumber: number;
  readonly counterRestartsAtOne: boolean;
  readonly roundNumbersSequential: boolean;
  readonly withinCeiling: boolean;
  readonly replanRequired: boolean;
  readonly replanRecorded: boolean;
}

export interface LedgerObservation {
  readonly maxRoundsRecorded: number;
  readonly roundCeiling: number;
  readonly withinCeiling: boolean;
  readonly replanRecorded: boolean;
  readonly classHistoryDoesNotReset: boolean;
  readonly reviewerSubstitutionRecorded: boolean;
  readonly ownerConfirmationRecorded: boolean;
  readonly independentGraderVerdict: Verdict;
  /**
   * The class history, which survives every per-PR counter restart.
   *
   * One shared `## Classes` section holding a non-empty class list is what
   * "does not reset" means mechanically. A second section would be a per-PR
   * class history — the reset the contract forbids — so the count is asserted
   * rather than the prose alone.
   */
  readonly classCount: number;
  readonly classSectionCount: number;
  readonly baselineClassCount: number;
  readonly missingRequiredClassCount: number;
  /** A round heading belonging to no mission PR is an unrecorded review loop. */
  readonly unattributedRoundCount: number;
  readonly attributedRoundCount: number;
}

export interface FinalGatesObservationStore {
  readonly runStart: FinalGatesRunStart;
  finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly publication: PublicationObservation;
  readonly coverage: CoverageObservation;
  readonly suite: SuiteObservation;
  readonly traps: readonly TrapObservation[];
  readonly redProbes: readonly RedProbeObservation[];
  readonly staticGates: Readonly<Record<string, number>>;
  readonly duplicationHundredthsOfPercent: number;
  readonly duplicationCeilingHundredthsOfPercent: number;
  readonly cloneCount: number;
  readonly leakScan: LeakScanObservation;
  readonly childEnvironment: ChildEnvironmentObservation;
  readonly proofPrivate: ProofPrivateObservation;
  readonly profiles: readonly ProfileObservation[];
  readonly pullRequests: readonly PullRequestObservation[];
  readonly ledger: LedgerObservation;
}

export interface CurrentRepoState {
  readonly gitHead: string;
  readonly treeClean: boolean;
}

const RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("enum", [FINAL_GATES_SCOPE])],
  ["/tier", field("enum", ["P0"])],
  ["/verdict", field("enum", ["observed", "not_observed", "failed"])],

  ["/provenance/captureSite", field("enum", ["final-gates-proof-run-start"])],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("git_sha")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  ["/provenance/command", field("free_form")],
  ["/provenance/observationStoreSha256", field("digest")],

  ["/publication/captureSite", field("enum", ["git-registry-and-workflow-queries"])],
  ["/publication/candidateTag", field("free_form")],
  ["/publication/candidateTagPresentLocal", field("boolean")],
  ["/publication/tagQuerySawKnownTag", field("boolean")],
  ["/publication/candidateTagPresentRemote", field("boolean")],
  ["/publication/remoteTagQuerySawKnownTag", field("boolean")],
  ["/publication/remoteTagVerdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/publication/registryCandidateStatus", field("count")],
  ["/publication/registryControlStatus", field("count")],
  ["/publication/registryVersionCount", field("count")],
  ["/publication/candidateInPackument", field("boolean")],
  ["/publication/registryVerdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/publication/npmViewDirectExit", field("count")],
  ["/publication/npmViewPipedExit", field("count")],
  ["/publication/npmViewControlDirectExit", field("count")],
  ["/publication/releaseWorkflowDiffLineCount", field("count")],
  ["/publication/workflowDiffQuerySawAKnownDifference", field("boolean")],
  ["/publication/releaseRunsOnCandidateBranch", field("count")],
  ["/publication/releaseRunQuerySawAKnownRun", field("boolean")],
  ["/publication/releaseRunVerdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/publication/candidateBranchPresentOnRemote", field("boolean")],
  ["/publication/remoteBranchQuerySawKnownBranch", field("boolean")],
  ["/publication/remoteBranchVerdict", field("enum", ["observed", "not_observed", "failed"])],

  ["/coverage/captureSite", field("enum", ["lcov-base-and-head-in-one-session"])],
  ["/coverage/baseRef", field("free_form")],
  ["/coverage/baseSha", field("git_sha")],
  ["/coverage/headSha", field("git_sha")],
  ["/coverage/measuredInOneSession", field("boolean")],
  ["/coverage/baseFileCount", field("count")],
  ["/coverage/headFileCount", field("count")],
  ["/coverage/comparedFileCount", field("count")],
  ["/coverage/newAtHeadCount", field("count")],
  ["/coverage/removedAtHeadCount", field("count")],
  ["/coverage/aggregateHeadLinesHundredths", field("count")],
  ["/coverage/aggregateHeadBranchesHundredths", field("count")],
  ["/coverage/aggregateHeadFunctionsHundredths", field("count")],
  ["/coverage/aggregateBaseLinesHundredths", field("count")],
  ["/coverage/aggregateBaseBranchesHundredths", field("count")],
  ["/coverage/aggregateBaseFunctionsHundredths", field("count")],
  ["/coverage/floorLinesHundredths", field("count")],
  ["/coverage/floorBranchesHundredths", field("count")],
  ["/coverage/floorFunctionsHundredths", field("count")],
  ["/coverage/aggregateMeetsFloor", field("boolean")],
  ["/coverage/regressedFileCount", field("count")],
  ["/coverage/regressions/*/path", field("free_form")],
  ["/coverage/regressions/*/metric", field("enum", ["lines", "branches", "functions"])],
  ["/coverage/regressions/*/baseHundredths", field("count")],
  ["/coverage/regressions/*/headHundredths", field("count")],
  ["/coverage/regressions/*/baseUncovered", field("count")],
  ["/coverage/regressions/*/headUncovered", field("count")],
  ["/coverage/denominatorOnlyFileCount", field("count")],
  ["/coverage/preExistingSourceIdentityCount", field("count")],
  ["/coverage/headUncoveredSourceIdentityCount", field("count")],
  ["/coverage/newlyUncoveredPreExistingCount", field("count")],
  ["/coverage/uncoveredNewSourceCount", field("count")],
  ["/coverage/unclassifiedRegressionCount", field("count")],
  ["/coverage/newSourceMissesTrackedByIssue", field("count")],
  ["/coverage/realGateExit", field("count")],
  ["/coverage/raisedFloorHundredths", field("count")],
  ["/coverage/raisedFloorExit", field("count")],
  ["/coverage/selfTestBaseVsBaseRegressions", field("count")],
  ["/coverage/selfTestInvertedRegressions", field("count")],
  ["/coverage/selfTestEmptyCorpusRefused", field("boolean")],
  ["/coverage/selfTestPlantedPreExistingRegressionCount", field("count")],
  ["/coverage/selfTestPlantedPreExistingFunctionRegressionCount", field("count")],
  ["/coverage/selfTestPlantedPreExistingBranchRegressionCount", field("count")],
  ["/coverage/verdict", field("enum", ["observed", "not_observed", "failed"])],

  ["/suite/captureSite", field("enum", ["tap-artifact-and-per-file-runs"])],
  ["/suite/planPresent", field("boolean")],
  ["/suite/planCount", field("count")],
  ["/suite/planFloor", field("count")],
  ["/suite/testsCount", field("count")],
  ["/suite/passCount", field("count")],
  ["/suite/failCount", field("count")],
  ["/suite/skippedCount", field("count")],
  ["/suite/todoCount", field("count")],
  ["/suite/onDiskTestFileCount", field("count")],
  ["/suite/perFileTotal", field("count")],
  ["/suite/perFileZeroCount", field("count")],
  ["/suite/perFileTotalEqualsPlan", field("boolean")],
  ["/suite/verdict", field("enum", ["observed", "not_observed", "failed"])],

  ["/traps/*/id", field("enum", [...TRAP_IDS])],
  ["/traps/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/traps/*/captureSite", field("enum", ["child-process-exit-and-output"])],
  ["/traps/*/exitCode", field("count")],
  ["/traps/*/observedCount", field("count")],
  ["/traps/*/controlCount", field("count")],

  ["/redProbes/*/id", field("enum", [...RED_PROBE_IDS])],
  ["/redProbes/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/redProbes/*/captureSite", field("enum", ["gate-rerun-with-planted-defect"])],
  ["/redProbes/*/greenExit", field("count")],
  ["/redProbes/*/redExit", field("count")],

  ["/staticGates/captureSite", field("enum", ["pnpm-script-exit-codes"])],
  ["/staticGates/check", field("count")],
  ["/staticGates/checkDocs", field("count")],
  ["/staticGates/checkDupes", field("count")],
  ["/staticGates/checkUnused", field("count")],
  ["/staticGates/proofPack", field("count")],
  ["/staticGates/duplicationHundredthsOfPercent", field("count")],
  ["/staticGates/duplicationCeilingHundredthsOfPercent", field("count")],
  ["/staticGates/cloneCount", field("count")],
  ["/staticGates/underDuplicationCeiling", field("boolean")],

  ["/safety/leakScan/captureSite", field("enum", ["ripgrep-match-set-head-versus-base"])],
  ["/safety/leakScan/corpusFileCount", field("count")],
  ["/safety/leakScan/baseMatchValueCount", field("count")],
  ["/safety/leakScan/headMatchValueCount", field("count")],
  ["/safety/leakScan/newValueCount", field("count")],
  ["/safety/leakScan/newValuesAllKnownSynthetic", field("boolean")],
  ["/safety/leakScan/hiddenFlagWithoutHits", field("count")],
  ["/safety/leakScan/hiddenFlagWithHits", field("count")],
  ["/safety/leakScan/hiddenFlagIsLoadBearing", field("boolean")],

  ["/safety/childEnvironment/captureSite", field("enum", ["constructed-child-environment"])],
  ["/safety/childEnvironment/allowlistedKeyCount", field("count")],
  ["/safety/childEnvironment/parentKeyCount", field("count")],
  ["/safety/childEnvironment/childKeyCount", field("count")],
  ["/safety/childEnvironment/forbiddenLeakCount", field("count")],
  ["/safety/childEnvironment/parentCarriedNodeTestContext", field("boolean")],
  ["/safety/childEnvironment/childCarriedNodeTestContext", field("boolean")],
  ["/safety/childEnvironment/contaminatedChildExit", field("count")],
  ["/safety/childEnvironment/cleanChildExit", field("count")],
  ["/safety/childEnvironment/childIsNarrowerThanParent", field("boolean")],

  ["/safety/proofPrivate/captureSite", field("enum", ["git-ls-files-and-check-ignore"])],
  ["/safety/proofPrivate/trackedFileCount", field("count")],
  ["/safety/proofPrivate/ignored", field("boolean")],
  ["/safety/proofPrivate/statusHitCount", field("count")],
  ["/safety/proofPrivate/controlTrackedPathFileCount", field("count")],

  ["/safety/profiles/*/id", field("enum", ["android", "ios"])],
  ["/safety/profiles/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/safety/profiles/*/captureSite", field("enum", ["filesystem-inode-and-read-only-copy"])],
  ["/safety/profiles/*/directoryInode", field("count")],
  ["/safety/profiles/*/databaseInode", field("count")],
  ["/safety/profiles/*/databaseByteLength", field("count")],
  ["/safety/profiles/*/fileCount", field("count")],
  ["/safety/profiles/*/credentialRowCount", field("count")],
  ["/safety/profiles/*/hasIdentity", field("boolean")],
  ["/safety/profiles/*/hasAccount", field("boolean")],
  ["/safety/profiles/*/hasNoiseKey", field("boolean")],

  ["/process/pullRequests/*/number", field("count")],
  ["/process/pullRequests/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/process/pullRequests/*/captureSite", field("enum", ["github-pull-request-api"])],
  ["/process/pullRequests/*/headCommit", field("free_form")],
  ["/process/pullRequests/*/headClaimPresent", field("boolean")],
  ["/process/pullRequests/*/headClaimMatchesACommit", field("boolean")],
  ["/process/pullRequests/*/commitCount", field("count")],
  ["/process/pullRequests/*/reviewCount", field("count")],
  ["/process/pullRequests/*/commentCount", field("count")],
  ["/process/pullRequests/*/distinctCommentAuthorCount", field("count")],
  ["/process/pullRequests/*/roundsAttributed", field("count")],
  ["/process/pullRequests/*/highestRoundNumber", field("count")],
  ["/process/pullRequests/*/counterRestartsAtOne", field("boolean")],
  ["/process/pullRequests/*/roundNumbersSequential", field("boolean")],
  ["/process/pullRequests/*/withinCeiling", field("boolean")],
  ["/process/pullRequests/*/replanRequired", field("boolean")],
  ["/process/pullRequests/*/replanRecorded", field("boolean")],

  ["/process/ledger/captureSite", field("enum", ["defect-ledger-document"])],
  ["/process/ledger/maxRoundsRecorded", field("count")],
  ["/process/ledger/roundCeiling", field("count")],
  ["/process/ledger/withinCeiling", field("boolean")],
  ["/process/ledger/replanRecorded", field("boolean")],
  ["/process/ledger/classHistoryDoesNotReset", field("boolean")],
  ["/process/ledger/reviewerSubstitutionRecorded", field("boolean")],
  ["/process/ledger/ownerConfirmationRecorded", field("boolean")],
  ["/process/ledger/classCount", field("count")],
  ["/process/ledger/classSectionCount", field("count")],
  ["/process/ledger/baselineClassCount", field("count")],
  ["/process/ledger/missingRequiredClassCount", field("count")],
  ["/process/ledger/unattributedRoundCount", field("count")],
  ["/process/ledger/attributedRoundCount", field("count")],
  [
    "/process/ledger/independentGraderVerdict",
    field("enum", ["observed", "not_observed", "failed"]),
  ],

  ["/sanitization/captureSite", field("enum", ["receipt-writer-in-memory"])],
  ["/sanitization/schemaUnknownFields", field("count")],
  ["/sanitization/schemaInvalidFields", field("count")],
  ["/sanitization/patternHits", field("count")],
  ["/sanitization/knownValueHits", field("count")],
  ["/sanitization/knownValueControlCount", field("count")],
  ["/sanitization/freeFormFields", field("count")],
  ["/sanitization/digestFields", field("count")],
  ["/sanitization/nonEmpty", field("boolean")],
  ["/sanitization/floorPassed", field("boolean")],
]);

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: childEnvironment(process.env),
  })
    .toString()
    .trim();
}

export function captureFinalGatesRunStart(root: string): FinalGatesRunStart {
  return {
    captureSite: "final-gates-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    treeClean: git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Free-form pointers whose value trips a leak pattern.
 *
 * The scanner returns a count. A count sends the next reader hunting; this
 * names the field, which is the difference between a refusal that is actionable
 * and one that gets worked around.
 */
export function flaggedFinalGatesFields(receipt: unknown): readonly string[] {
  const flagged: string[] = [];
  const walk = (value: unknown, pointer = ""): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${pointer}/${i}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) walk(entry, `${pointer}/${key}`);
      return;
    }
    const schema = RECEIPT_SCHEMA.get(pointer.replace(/\/\d+(?=\/|$)/gu, "/*"));
    if (schema?.type !== "free_form" || typeof value !== "string") return;
    const solo = scanSchemaDrivenReceipt(
      { probe: value },
      [],
      new Map([["/probe", field("free_form")]]),
    );
    if (solo.patternHits > 0) flagged.push(`${pointer} (${solo.patternHits})`);
  };
  walk(receipt);
  return flagged;
}

export function scanFinalGatesReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, RECEIPT_SCHEMA);
}

function leafPointers(value: unknown, pointer = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, i) => leafPointers(entry, `${pointer}/${i}`));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPointers(entry, `${pointer}/${key}`),
    );
  return [pointer];
}

/**
 * Schema fields the receipt does not carry.
 *
 * The scanner counts *unknown* fields and is silent about *missing* ones, so a
 * receipt that dropped half its observations would pass every sanitization
 * check ever written. Array-valued blocks are exempt only when the array is
 * legitimately empty, which `validateFinalGatesStore` forbids for every block
 * this proof requires.
 */
/**
 * Schema pointers that are absent when, and only when, there is nothing to
 * report.
 *
 * `/coverage/regressions` is written only when a file regressed — which is the
 * outcome this proof hopes never to see. The count that must always be present
 * is `/coverage/regressedFileCount`, and `validateFinalGatesStore` forces the
 * two to agree, so the list cannot go missing while the count says otherwise.
 * Nothing else is exemptible: every other block is required non-empty.
 */
const CONDITIONAL_FIELDS = /^\/coverage\/regressions\//u;

/**
 * The schema version this writer emits.
 *
 * Bumped when a field is added, because the committed-receipt scan checks every
 * receipt on disk against the schema. Without a version, adding a field made
 * that scan red for receipts written before it — and since the scan runs inside
 * the suite the final-gates proof must pass *before* it writes a receipt, the
 * red could not be cleared by rerunning the proof. A stale receipt would have
 * to be hand-edited or deleted, which is the one thing a receipt must never
 * invite.
 */
export const RECEIPT_SCHEMA_VERSION = 4;

/**
 * Pointers introduced after version 1.
 *
 * An older receipt is complete for its own version; it is not evidence that the
 * run behind it observed something it never measured. Back-filling these into
 * a version 1 receipt would be exactly that, so they are excused there and
 * required everywhere else.
 */
const FIELDS_ADDED_IN_VERSION_2 =
  /^\/(safety\/childEnvironment\/|process\/(ledger\/(classCount|classSectionCount|unattributedRoundCount|attributedRoundCount)|pullRequests\/\*\/(roundsAttributed|highestRoundNumber|counterRestartsAtOne|withinCeiling|replanRequired|replanRecorded)))/u;
const FIELDS_ADDED_IN_VERSION_3 =
  /^\/coverage\/(preExistingSourceIdentityCount|headUncoveredSourceIdentityCount|newlyUncoveredPreExistingCount|uncoveredNewSourceCount|newSourceMissesTrackedByIssue|selfTestPlantedPreExistingRegressionCount)$/u;
const FIELDS_ADDED_IN_VERSION_4 =
  /^\/(coverage\/(unclassifiedRegressionCount|selfTestPlantedPreExistingFunctionRegressionCount|selfTestPlantedPreExistingBranchRegressionCount)|process\/(ledger\/(baselineClassCount|missingRequiredClassCount)|pullRequests\/\*\/roundNumbersSequential))$/u;

export function missingFinalGatesFields(receipt: unknown): readonly string[] {
  const present = new Set(
    leafPointers(receipt).map((pointer) => pointer.replace(/\/\d+(?=\/|$)/gu, "/*")),
  );
  const reported =
    typeof receipt === "object" &&
    receipt !== null &&
    Number(Reflect.get(Reflect.get(receipt, "coverage") ?? {}, "regressedFileCount") ?? 0) > 0;
  // A receipt is judged complete against the schema version it was written at.
  // Never against the newest one: a field added later was not measurable by an
  // earlier run, and demanding it would ask that receipt to claim more than the
  // run observed.
  const version = Number(
    (typeof receipt === "object" && receipt !== null && Reflect.get(receipt, "schemaVersion")) || 0,
  );
  return [...RECEIPT_SCHEMA.keys()]
    .filter((key) => !present.has(key))
    .filter((key) => reported || !CONDITIONAL_FIELDS.test(key))
    .filter((key) => version >= 2 || !FIELDS_ADDED_IN_VERSION_2.test(key))
    .filter((key) => version >= 3 || !FIELDS_ADDED_IN_VERSION_3.test(key))
    .filter((key) => version >= 4 || !FIELDS_ADDED_IN_VERSION_4.test(key))
    .sort();
}

/**
 * Schema pointers the receipt carries that the schema does not name.
 *
 * The scanner counts these; it does not say which. A count alone sends the next
 * reader hunting through 160 pointers by hand, so the refusal names them.
 */
export function unknownFinalGatesFields(receipt: unknown): readonly string[] {
  // An empty array is one leaf at its own pointer — the same leaf the scanner
  // counts — so it is enumerated here rather than descended into, or a receipt
  // carrying one would report a count with no name to go with it.
  const pointers = (value: unknown, pointer = ""): string[] => {
    if (Array.isArray(value))
      return value.length === 0
        ? [pointer]
        : value.flatMap((entry, i) => pointers(entry, `${pointer}/${i}`));
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      return entries.length === 0
        ? [pointer]
        : entries.flatMap(([key, entry]) => pointers(entry, `${pointer}/${key}`));
    }
    return [pointer];
  };
  return pointers(receipt)
    .map((pointer) => pointer.replace(/\/\d+(?=\/|$)/gu, "/*"))
    .filter((pointer) => !RECEIPT_SCHEMA.has(pointer))
    .sort();
}

export function validateFinalGatesStore(
  store: FinalGatesObservationStore,
  current: CurrentRepoState,
): void {
  if (!store.runStart.treeClean || !current.treeClean)
    throw new Error("refusing receipt: the run or current worktree is dirty");
  if (store.runStart.gitHead !== current.gitHead)
    throw new Error("refusing receipt: current head does not match the captured run head");
  if (!store.finalizedAt) throw new Error("refusing receipt: the run is not finalized");
  if (
    store.knownValues.length < 3 ||
    store.knownValues.some((value) => value.length === 0) ||
    new Set(store.knownValues).size !== store.knownValues.length
  )
    throw new Error("refusing receipt: known-value negative control is incomplete");

  const publication = store.publication;
  if (publication.candidateTag !== `v${CANDIDATE_VERSION}`)
    throw new Error("refusing receipt: the candidate tag does not name the packaged version");
  if (publication.candidateTagPresentLocal)
    throw new Error("refusing receipt: a local tag for this version exists; tagging is owner-held");
  if (!publication.tagQuerySawKnownTag)
    throw new Error("refusing receipt: the tag query saw no known tag, so it proves no absence");
  if (publication.candidateTagPresentRemote)
    throw new Error("refusing receipt: a remote tag for this version exists");
  if (publication.remoteTagVerdict === "observed" && !publication.remoteTagQuerySawKnownTag)
    throw new Error("refusing receipt: the remote tag query proved nothing it could see");
  if (publication.candidateInPackument || publication.registryCandidateStatus !== 404)
    throw new Error("refusing receipt: the registry knows this version; publishing is owner-held");
  if (publication.registryControlStatus !== 200)
    throw new Error(
      "refusing receipt: the registry control did not return 200, so a 404 proves nothing",
    );
  if (publication.releaseWorkflowDiffLineCount !== 0)
    throw new Error("refusing receipt: the release workflow differs from origin/master");
  if (!publication.workflowDiffQuerySawAKnownDifference)
    throw new Error(
      "refusing receipt: the workflow diff query cannot see a difference that exists",
    );
  if (
    publication.releaseRunVerdict === "observed" &&
    publication.releaseRunsOnCandidateBranch !== 0
  )
    throw new Error("refusing receipt: a Release workflow run exists on the candidate branch");
  if (publication.releaseRunVerdict === "observed" && !publication.releaseRunQuerySawAKnownRun)
    throw new Error("refusing receipt: the workflow-run query proved nothing it could see");
  if (publication.candidateBranchPresentOnRemote)
    throw new Error("refusing receipt: the candidate branch was pushed to the remote");
  if (
    publication.remoteBranchVerdict === "observed" &&
    !publication.remoteBranchQuerySawKnownBranch
  )
    throw new Error("refusing receipt: the remote branch query proved nothing it could see");

  const coverage = store.coverage;
  if (!coverage.measuredInOneSession)
    throw new Error("refusing receipt: base and head coverage were not measured in one session");
  if (coverage.comparedFileCount === 0)
    throw new Error("refusing receipt: the coverage comparison compared no files");
  if (coverage.realGateExit !== 0)
    throw new Error("refusing receipt: the configured coverage gate did not pass at head");
  if (coverage.raisedFloorExit === 0)
    throw new Error("refusing receipt: a raised coverage floor still passed, so the gate is inert");
  if (coverage.selfTestBaseVsBaseRegressions !== 0)
    throw new Error(
      "refusing receipt: the comparator reports a regression comparing base to itself",
    );
  if (coverage.selfTestInvertedRegressions === 0)
    throw new Error(
      "refusing receipt: the comparator cannot see a regression, so it has no direction",
    );
  if (!coverage.selfTestEmptyCorpusRefused)
    throw new Error("refusing receipt: the comparator passes an empty corpus");
  if (coverage.preExistingSourceIdentityCount === 0)
    throw new Error("refusing receipt: the source-identity base corpus is empty");
  if (coverage.headUncoveredSourceIdentityCount === 0)
    throw new Error("refusing receipt: the uncovered source-identity corpus is empty");
  if (coverage.selfTestPlantedPreExistingRegressionCount === 0)
    throw new Error("refusing receipt: the comparator missed a planted pre-existing-line loss");
  if (coverage.selfTestPlantedPreExistingFunctionRegressionCount === 0)
    throw new Error("refusing receipt: the comparator missed a planted pre-existing-function loss");
  if (coverage.selfTestPlantedPreExistingBranchRegressionCount === 0)
    throw new Error("refusing receipt: the comparator missed a planted pre-existing-branch loss");
  if (coverage.unclassifiedRegressionCount !== 0)
    throw new Error("refusing receipt: a percentage regression has no coverage-identity cause");
  if (coverage.uncoveredNewSourceCount > 0 && coverage.newSourceMissesTrackedByIssue !== 148)
    throw new Error("refusing receipt: uncovered new source is not tracked by issue 148");
  if (!coverage.aggregateMeetsFloor)
    throw new Error("refusing receipt: aggregate coverage is below the configured floor");
  // A per-file regression is a recordable outcome, not a refusal: this receipt
  // exists to say so. What is refused is a verdict that disagrees with it.
  if (
    (coverage.newlyUncoveredPreExistingCount > 0 || coverage.unclassifiedRegressionCount > 0) !==
    (coverage.verdict === "failed")
  )
    throw new Error(
      "refusing receipt: the coverage verdict disagrees with pre-existing source loss",
    );
  // `regressedFileCount` counts files; the list carries one row per metric, so
  // one file can contribute three. The check is that they describe the same set
  // of files, not that they are the same length — the length comparison was
  // wrong and rejected a correct three-metric regression on one file.
  if (new Set(coverage.regressions.map((entry) => entry.path)).size !== coverage.regressedFileCount)
    throw new Error("refusing receipt: the regression list does not match its own count");

  const suite = store.suite;
  if (!suite.planPresent)
    throw new Error("refusing receipt: the TAP artifact carries no plan line");
  if (suite.planCount < PLAN_FLOOR)
    throw new Error(`refusing receipt: the plan is below the ${PLAN_FLOOR} floor`);
  if (suite.failCount !== 0 || suite.skippedCount !== 0 || suite.todoCount !== 0)
    throw new Error("refusing receipt: the suite failed, skipped or deferred a test");
  if (suite.onDiskTestFileCount === 0)
    throw new Error("refusing receipt: no test files were found on disk");
  if (suite.perFileZeroCount !== 0)
    throw new Error("refusing receipt: a test file on disk contributed no tests");
  if (!suite.perFileTotalEqualsPlan)
    throw new Error("refusing receipt: the per-file totals do not sum to the executed plan");
  if (suite.verdict !== "observed")
    throw new Error("refusing receipt: the suite block must be observed to be recorded green");

  if (store.traps.length < 3)
    throw new Error("refusing receipt: the verified traps are incomplete");
  for (const trap of store.traps)
    if (trap.verdict !== "observed")
      throw new Error(`refusing receipt: trap ${trap.id} was not observed`);
  if (store.redProbes.length < 3)
    throw new Error("refusing receipt: fewer than three gates were proved able to fail");
  for (const probe of store.redProbes) {
    if (probe.verdict !== "observed")
      throw new Error(`refusing receipt: red probe ${probe.id} was not observed`);
    if (probe.greenExit !== 0 || probe.redExit === 0)
      throw new Error(`refusing receipt: red probe ${probe.id} never went red`);
  }

  for (const [name, exit] of Object.entries(store.staticGates))
    if (exit !== 0) throw new Error(`refusing receipt: static gate ${name} exited ${exit}`);
  if (store.cloneCount === 0)
    throw new Error("refusing receipt: the duplication report found no clones, so it saw nothing");
  if (store.duplicationHundredthsOfPercent > store.duplicationCeilingHundredthsOfPercent)
    throw new Error("refusing receipt: duplication is above its ceiling");

  const leak = store.leakScan;
  if (leak.corpusFileCount === 0)
    throw new Error("refusing receipt: the leak scan looked at an empty corpus");
  if (leak.headMatchValueCount === 0)
    throw new Error("refusing receipt: the leak scan matched nothing at all, so it proves nothing");
  if (leak.newValueCount > 0 && !leak.newValuesAllKnownSynthetic)
    throw new Error(
      "refusing receipt: an account-shaped value appeared that is not known-synthetic",
    );
  if (leak.hiddenFlagWithoutHits !== 0 || leak.hiddenFlagWithHits === 0)
    throw new Error("refusing receipt: --hidden was not shown to be load-bearing");

  const child = store.childEnvironment;
  if (child.forbiddenLeakCount !== 0)
    throw new Error("refusing receipt: a forbidden variable reached the child environment");
  if (child.childCarriedNodeTestContext)
    throw new Error("refusing receipt: the child environment carries NODE_TEST_CONTEXT");
  if (child.childKeyCount === 0)
    throw new Error("refusing receipt: the child environment is empty, so it was never built");
  if (child.childKeyCount >= child.parentKeyCount)
    throw new Error(
      "refusing receipt: the child environment is not narrower than the parent's, so it is not an allowlist",
    );
  // The control that makes the exclusion mean something. Without it, "the
  // child did not carry NODE_TEST_CONTEXT" is satisfied by a parent that never
  // had it — an absence proving nothing, on a machine where nothing set it.
  if (!child.parentCarriedNodeTestContext)
    throw new Error(
      "refusing receipt: the parent never carried NODE_TEST_CONTEXT, so excluding it proves nothing",
    );
  // And the planted positive: a child that IS given the variable must go green
  // on a failure, or the contamination this guards against is not real here.
  if (child.contaminatedChildExit !== 0 || child.cleanChildExit === 0)
    throw new Error(
      "refusing receipt: the NODE_TEST_CONTEXT contamination control did not reproduce",
    );

  const priv = store.proofPrivate;
  if (priv.trackedFileCount !== 0) throw new Error("refusing receipt: .proof-private is tracked");
  if (!priv.ignored) throw new Error("refusing receipt: .proof-private is not ignored");
  if (priv.statusHitCount !== 0)
    throw new Error("refusing receipt: git status still reports .proof-private");
  if (priv.controlTrackedPathFileCount === 0)
    throw new Error(
      "refusing receipt: git ls-files saw nothing, so an empty result proves nothing",
    );

  if (store.profiles.length !== 2)
    throw new Error("refusing receipt: exactly two linked profiles are expected");
  const inodes = store.profiles.flatMap((p) => [p.directoryInode, p.databaseInode]);
  if (new Set(inodes).size !== inodes.length)
    throw new Error("refusing receipt: two profiles share an inode, so they are not distinct");
  for (const profile of store.profiles) {
    if (profile.verdict !== "observed")
      throw new Error(`refusing receipt: profile ${profile.id} was not observed`);
    if (profile.credentialRowCount !== 1)
      throw new Error(`refusing receipt: profile ${profile.id} has no single credential row`);
    if (!profile.hasIdentity || !profile.hasAccount || !profile.hasNoiseKey)
      throw new Error(`refusing receipt: profile ${profile.id} lost resumable credential material`);
    if (profile.fileCount === 0 || profile.databaseByteLength === 0)
      throw new Error(`refusing receipt: profile ${profile.id} measured empty`);
  }

  if (store.pullRequests.length === 0)
    throw new Error("refusing receipt: no pull requests were inspected");
  const ledger = store.ledger;
  if (ledger.roundCeiling !== ROUND_CEILING)
    throw new Error("refusing receipt: the round ceiling is not the mission's four");
  if (!ledger.withinCeiling || ledger.maxRoundsRecorded > ledger.roundCeiling)
    throw new Error("refusing receipt: a pull request exceeded the four-round ceiling");
  if (ledger.maxRoundsRecorded === 0)
    throw new Error("refusing receipt: the ledger scan found no rounds, so it read nothing");
  if (!ledger.replanRecorded)
    throw new Error("refusing receipt: no replan is recorded in the defect ledger");
  if (!ledger.classHistoryDoesNotReset)
    throw new Error(
      "refusing receipt: the ledger does not state that class history survives a restart",
    );

  // The ceiling is per PR, so it is evaluated per PR. A global maximum cannot
  // distinguish a counter that restarted from one that carried over — the
  // PR #93/#94 failure — and lets one PR's replan satisfy every other's.
  for (const pr of store.pullRequests.filter(({ verdict }) => verdict === "observed")) {
    if (!pr.withinCeiling || pr.highestRoundNumber > ledger.roundCeiling)
      throw new Error(`refusing receipt: PR #${pr.number} exceeded the four-round ceiling`);
    if (!pr.counterRestartsAtOne)
      throw new Error(`refusing receipt: PR #${pr.number}'s round counter did not restart at 1`);
    if (!pr.roundNumbersSequential)
      throw new Error(`refusing receipt: PR #${pr.number}'s rounds are duplicated or gapped`);
    if (pr.replanRequired && !pr.replanRecorded)
      throw new Error(`refusing receipt: PR #${pr.number} hit the ceiling without a replan`);
  }
  // An absence that proves nothing: if no PR carries a round, the per-PR check
  // above ran over nothing and every one of its verdicts is vacuous.
  if (!store.pullRequests.some(({ roundsAttributed }) => roundsAttributed > 0))
    throw new Error(
      "refusing receipt: no round was attributed to any PR, so the per-PR ceiling proves nothing",
    );
  // The oracle, after the assertion it cross-checks: the per-PR rows must
  // account for every round the ledger holds, or rows were dropped between the
  // scan and the receipt.
  const attributed = store.pullRequests.reduce((sum, pr) => sum + pr.roundsAttributed, 0);
  if (ledger.attributedRoundCount !== attributed)
    throw new Error("refusing receipt: the attributed round count disagrees with the per-PR rows");
  if (ledger.unattributedRoundCount !== 0)
    throw new Error(
      "refusing receipt: a review round belongs to no mission PR, so it is unrecorded",
    );
  // Class history does not reset: one shared, non-empty class list.
  if (
    ledger.classSectionCount !== 1 ||
    ledger.classCount === 0 ||
    ledger.baselineClassCount === 0 ||
    ledger.missingRequiredClassCount !== 0
  )
    throw new Error(
      "refusing receipt: the ledger does not hold exactly one non-empty shared class history",
    );
}

function scanMetricsWithoutByteLength(scan: ReceiptScanReport): Record<string, unknown> {
  return {
    schemaUnknownFields: scan.schemaUnknownFields,
    schemaInvalidFields: scan.schemaInvalidFields,
    patternHits: scan.patternHits,
    knownValueHits: scan.knownValueHits,
    freeFormFields: scan.freeFormFields,
    digestFields: scan.digestFields,
    nonEmpty: scan.nonEmpty,
    floorPassed: scan.floorPassed,
  };
}

export function assertFinalGatesSanitizationDescribesFinalObject(
  receipt: Record<string, unknown>,
  knownValues: readonly string[],
): void {
  const sanitization = receipt.sanitization;
  if (typeof sanitization !== "object" || sanitization === null)
    throw new Error("receipt sanitization block is missing");
  if (Object.hasOwn(sanitization, "receiptByteLength"))
    throw new Error("the final-gates receipt must omit receiptByteLength: it self-references");
  const scan = scanFinalGatesReceipt(receipt, knownValues);
  for (const [key, value] of Object.entries(scanMetricsWithoutByteLength(scan)))
    if (Reflect.get(sanitization, key) !== value)
      throw new Error(`embedded sanitization metric ${key} does not describe the final receipt`);
}

/**
 * The run's single verdict, derived from the blocks rather than asserted.
 *
 * `failed` wins over `not_observed`: a gate that went red is the more important
 * fact about a run than a gate nobody could reach.
 */
export function deriveFinalGatesVerdict(store: FinalGatesObservationStore): Verdict {
  const verdicts: readonly Verdict[] = [
    store.coverage.verdict,
    store.suite.verdict,
    store.publication.remoteTagVerdict,
    store.publication.registryVerdict,
    store.publication.releaseRunVerdict,
    store.publication.remoteBranchVerdict,
    store.ledger.independentGraderVerdict,
    ...store.traps.map((trap) => trap.verdict),
    ...store.redProbes.map((probe) => probe.verdict),
    ...store.profiles.map((profile) => profile.verdict),
    ...store.pullRequests.map((pr) => pr.verdict),
  ];
  if (verdicts.includes("failed")) return "failed";
  if (verdicts.includes("not_observed")) return "not_observed";
  return "observed";
}

export function buildFinalGatesReceipt(
  store: FinalGatesObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  validateFinalGatesStore(store, current);
  const observationStoreSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        runStart: store.runStart,
        finalizedAt: store.finalizedAt,
        publication: store.publication,
        coverage: store.coverage,
        suite: store.suite,
        traps: store.traps,
        redProbes: store.redProbes,
        staticGates: store.staticGates,
        leakScan: store.leakScan,
        childEnvironment: store.childEnvironment,
        proofPrivate: store.proofPrivate,
        profiles: store.profiles,
        pullRequests: store.pullRequests,
        ledger: store.ledger,
      }),
    )
    .digest("hex");

  const withoutSanitization = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    issue: 112,
    scope: FINAL_GATES_SCOPE,
    tier: "P0",
    verdict: deriveFinalGatesVerdict(store),
    provenance: {
      ...store.runStart,
      finalizedAt: store.finalizedAt,
      command: "pnpm proof:final-gates",
      observationStoreSha256,
    },
    publication: { captureSite: "git-registry-and-workflow-queries", ...store.publication },
    coverage: {
      captureSite: "lcov-base-and-head-in-one-session",
      ...(({ regressions: _omitted, ...rest }) => rest)(store.coverage),
      floorLinesHundredths: COVERAGE_FLOOR_HUNDREDTHS.lines,
      floorBranchesHundredths: COVERAGE_FLOOR_HUNDREDTHS.branches,
      floorFunctionsHundredths: COVERAGE_FLOOR_HUNDREDTHS.functions,
      // Omitted entirely when nothing regressed. An empty array serializes to a
      // null leaf that no field type can describe, and `regressedFileCount` —
      // which the validator forces to agree with this list — already carries
      // the fact that there was nothing to report.
      ...(store.coverage.regressions.length > 0 && {
        regressions: store.coverage.regressions.map((entry) => ({ ...entry })),
      }),
    },
    suite: {
      captureSite: "tap-artifact-and-per-file-runs",
      ...store.suite,
      planFloor: PLAN_FLOOR,
    },
    traps: store.traps.map((trap) => ({
      id: trap.id,
      verdict: trap.verdict,
      captureSite: "child-process-exit-and-output",
      exitCode: trap.exitCode,
      observedCount: trap.observedCount,
      controlCount: trap.controlCount,
    })),
    redProbes: store.redProbes.map((probe) => ({
      id: probe.id,
      verdict: probe.verdict,
      captureSite: "gate-rerun-with-planted-defect",
      greenExit: probe.greenExit,
      redExit: probe.redExit,
    })),
    staticGates: {
      captureSite: "pnpm-script-exit-codes",
      ...store.staticGates,
      duplicationHundredthsOfPercent: store.duplicationHundredthsOfPercent,
      duplicationCeilingHundredthsOfPercent: store.duplicationCeilingHundredthsOfPercent,
      cloneCount: store.cloneCount,
      underDuplicationCeiling:
        store.duplicationHundredthsOfPercent <= store.duplicationCeilingHundredthsOfPercent,
    },
    safety: {
      leakScan: {
        captureSite: "ripgrep-match-set-head-versus-base",
        ...store.leakScan,
        hiddenFlagIsLoadBearing:
          store.leakScan.hiddenFlagWithHits > store.leakScan.hiddenFlagWithoutHits,
      },
      childEnvironment: {
        captureSite: "constructed-child-environment",
        ...store.childEnvironment,
        childIsNarrowerThanParent:
          store.childEnvironment.childKeyCount < store.childEnvironment.parentKeyCount,
      },
      proofPrivate: { captureSite: "git-ls-files-and-check-ignore", ...store.proofPrivate },
      profiles: store.profiles.map((profile) => ({
        ...profile,
        captureSite: "filesystem-inode-and-read-only-copy",
      })),
    },
    process: {
      pullRequests: store.pullRequests.map((pr) => ({
        ...pr,
        captureSite: "github-pull-request-api",
      })),
      ledger: { captureSite: "defect-ledger-document", ...store.ledger },
    },
  };

  const preEmbedding = scanFinalGatesReceipt(withoutSanitization, store.knownValues);
  const receipt = {
    ...withoutSanitization,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      ...scanMetricsWithoutByteLength(preEmbedding),
      knownValueControlCount: store.knownValues.length,
    },
  };
  assertFinalGatesSanitizationDescribesFinalObject(receipt, store.knownValues);
  const missing = missingFinalGatesFields(receipt);
  if (missing.length > 0)
    throw new Error(`refusing incomplete receipt, missing: ${missing.join(", ")}`);
  const finalScan = scanFinalGatesReceipt(receipt, store.knownValues);
  if (
    finalScan.schemaUnknownFields !== 0 ||
    finalScan.schemaInvalidFields !== 0 ||
    finalScan.patternHits !== 0 ||
    finalScan.knownValueHits !== 0 ||
    !finalScan.floorPassed
  )
    throw new Error(
      `refusing unsanitized receipt: ${JSON.stringify(finalScan)}${
        finalScan.schemaUnknownFields > 0
          ? `; unschema'd: ${unknownFinalGatesFields(receipt).join(", ")}`
          : ""
      }${
        finalScan.patternHits > 0
          ? `; pattern hits at: ${flaggedFinalGatesFields(receipt).join(", ")}`
          : ""
      }`,
    );
  return receipt;
}

export function writeFinalGatesReceipt(
  root: string,
  store: FinalGatesObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport; readonly verdict: Verdict } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0,
  };
  const receipt = buildFinalGatesReceipt(store, current);
  const directory = path.join(root, ".proof-receipts");
  mkdirSync(directory, { recursive: true });
  const runNumber =
    1 + readdirSync(directory).filter((name) => name.startsWith("issue112-final-p0.run")).length;
  const file = path.join(
    directory,
    `issue112-final-p0.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  const formatted = execFileSync(
    path.join(root, "node_modules", ".bin", "vp"),
    ["fmt", "--stdin-filepath=.proof-receipts/receipt.json"],
    {
      cwd: root,
      env: childEnvironment(process.env),
      input: `${JSON.stringify(receipt, null, 2)}\n`,
      encoding: "utf8",
    },
  );
  try {
    writeFileSync(file, formatted, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`refusing to overwrite existing receipt ${file}`);
    throw error;
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assertFinalGatesSanitizationDescribesFinalObject(written, store.knownValues);
  return {
    file,
    scan: scanFinalGatesReceipt(written, store.knownValues),
    verdict: receipt.verdict as Verdict,
  };
}
