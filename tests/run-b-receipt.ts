/**
 * Issue #112 Run B — the P4 receipt writer.
 *
 * Run B spans two processes and one human QR scan. Phase 1 is unrepeatable, so
 * every phase-1 row here is carried forward from the durable handoff rather
 * than re-measured, and the writer refuses a carry-forward whose source tree
 * differs from the head being claimed. Phase 2 rows are measured at run time.
 *
 * The raw challenge value never reaches this module. `challengeValueLength` is
 * the only thing recorded about it — not the value, and not a hash of it: a QR
 * reference is short and dictionary-confirmable, so a digest is a lookup away
 * from the value itself.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  receiptField as field,
  scanSchemaDrivenReceipt,
  type ReceiptFieldSchema,
  type ReceiptScanReport,
} from "./proof-receipt-scan.ts";

/**
 * The rows a run records. One per contract clause the run is asked to reach.
 *
 * Three of these clauses have a sub-clause the run does not observe on every
 * path, and a single verdict over the pair reports the unobserved half as
 * observed. Those three are split into `DERIVED_MATRIX_IDS` before the receipt
 * is written, so the strong half keeps its verdict and the weak half carries
 * its own.
 */
const SOURCE_MATRIX_IDS = [
  "challenge-consumed-exactly-once",
  "challenge-never-in-ordinary-state",
  "pair-links-through-one-session",
  "unlink-clears-only-target-credentials",
  "unlink-preserves-durable-chats-and-media",
  "runtime-survives-unlink-and-accepts-repair",
  "durable-profiles-untouched-by-run-b",
  "bonus-first-link-history-sync",
] as const;

/**
 * The sub-clause rows, derived from a source row's own evidence.
 *
 * They are never asserted by a caller. Each one's verdict is read off the
 * evidence the run recorded, so a receipt cannot claim a sub-clause its own
 * numbers contradict — the defect these three exist to close.
 */
const DERIVED_MATRIX_IDS = [
  "pair-restart-recorded-as-a-labelled-reconnect",
  "unlink-logout-preceded-the-clear",
  "unlink-preserves-durable-messages",
] as const;

const MATRIX_IDS = [...SOURCE_MATRIX_IDS, ...DERIVED_MATRIX_IDS] as const;

/**
 * Why a row was not observed, and whether it could ever be observed again.
 *
 * A bare `not_observed` reads as "nobody got round to it". Run B's live
 * lifecycle is spent — one human QR scan linked a throwaway device slot and
 * `client.account.unlink()` fired once — so three of these can never be
 * re-observed at all, and the receipt says which.
 */
const NOT_OBSERVED_REASONS = [
  "logout-ordering-was-asserted-only-in-the-spent-unlinking-process",
  "no-message-count-was-captured-before-the-spent-unlink",
  "no-reconnect-was-labelled-as-the-515-restart-in-the-spent-pairing",
  "the-run-ended-before-this-observation",
] as const;

/**
 * Why a written receipt was replaced rather than appended to.
 *
 * Receipts are `wx` and append-only, and that rule exists to stop a run
 * quietly improving its own record. It does **not** oblige the repository to
 * keep a claim it has since established was false: an over-claiming receipt is
 * indistinguishable from a true one, and the next gate consumes it as fact.
 *
 * A correction is therefore the one sanctioned overwrite, and it is fenced —
 * it re-derives the matrix from the run's own observation store, it names the
 * digest of the exact bytes it replaces and refuses if the file on disk is not
 * those bytes, and it may only lower a verdict.
 */
const CORRECTION_REASONS = ["rows-claimed-sub-clauses-the-run-did-not-observe"] as const;

/**
 * The bonus row records the mission's only genuine first-link history sync.
 * M4 recorded it `not_observed`; it gates nothing here, and the writer refuses
 * a receipt in which it claims to.
 */
const BONUS_ID = "bonus-first-link-history-sync";

export type RunBSourceMatrixId = (typeof SOURCE_MATRIX_IDS)[number];
export type RunBDerivedMatrixId = (typeof DERIVED_MATRIX_IDS)[number];
export type RunBMatrixId = (typeof MATRIX_IDS)[number];
export type RunBNotObservedReason = (typeof NOT_OBSERVED_REASONS)[number];
export type RunBCorrectionReason = (typeof CORRECTION_REASONS)[number];
export type RunBVerdict = "observed" | "not_observed" | "failed";
export type RunBMode = "unlink" | "verify";

export type RunBStage =
  | "sandbox"
  | "handoff"
  | "throwaway-open"
  | "unlink"
  | "operations-oracle"
  | "credentials-oracle"
  | "durable-compare"
  | "media-compare"
  | "cold-open"
  | "repair";

export type RunBCaptureSite =
  | "run-b-sandbox-probe"
  | "phase-one-handoff"
  | "throwaway-operations-oracle"
  | "throwaway-credentials-oracle"
  | "throwaway-media-oracle"
  | "cold-process-client"
  | "leak-scanner-self-test"
  | "run-stage-verdict";

export interface RunBRunStart {
  readonly captureSite: "run-b-receipt-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface RunBMatrixRow {
  readonly id: RunBMatrixId;
  readonly verdict: RunBVerdict;
  /**
   * Why this row is an absence, present on exactly the `not_observed` rows.
   *
   * The writer refuses a `not_observed` row without one and refuses one on any
   * other verdict, so "no absence is ever presented as success" is joined by
   * "no absence is ever presented without its reason".
   */
  readonly notObservedReason?: RunBNotObservedReason;
  readonly captureSite: RunBCaptureSite;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** A row a run records directly. Derived rows are never asserted by a caller. */
export interface RunBSourceMatrixRow extends RunBMatrixRow {
  readonly id: RunBSourceMatrixId;
}

export interface RunBObservationStore {
  readonly runStart: RunBRunStart;
  readonly mode: RunBMode;
  readonly finalizedAt?: string;
  /**
   * Real account material held in memory by the harness. Nothing here may
   * appear anywhere in the receipt — the one check that catches a leak in a
   * shape no pattern anticipated.
   */
  readonly knownValues: readonly string[];
  /** The rows the run recorded. The derived sub-clause rows are not among them. */
  readonly rows: readonly RunBSourceMatrixRow[];
}

export interface CurrentRepoState {
  readonly gitHead: string;
  readonly treeClean: boolean;
}

/**
 * Finalize every row the run never reached.
 *
 * Phase 2 threw at its cold-process assertion once already and printed no
 * summary at all, so a real run's evidence was lost. Nothing measured is
 * allowed to die with the exception that interrupted it.
 */
export function finalizeRunBFailure(
  rows: readonly RunBSourceMatrixRow[],
  failedId: RunBSourceMatrixId,
  stage: RunBStage,
): RunBSourceMatrixRow[] {
  const failedIndex = SOURCE_MATRIX_IDS.indexOf(failedId);
  const completed = new Set(rows.map(({ id }) => id));
  return [
    // A row is pushed with its measurements *before* the assertions that judge
    // them, so the failing row may already be present reading `observed`.
    // Downgrading it here is the difference between a receipt that reports a
    // failure and one that reports the failing row as a success.
    ...rows.map((row) =>
      row.id === failedId && row.id !== BONUS_ID
        ? { ...row, verdict: "failed" as const, evidence: { ...row.evidence, stage } }
        : row,
    ),
    ...SOURCE_MATRIX_IDS.filter((id) => !completed.has(id)).map((id): RunBSourceMatrixRow => {
      // The bonus row gates nothing, so a phase-2 failure never marks it
      // `failed` — it was either carried forward already or never reached. It
      // restates `gatesNothing` on this path too, because a row that declares
      // it only when observed leaves the claim absent exactly when a reader is
      // most likely to over-read the rest of the receipt.
      const failedHere = id === failedId && id !== BONUS_ID;
      const failed = failedHere || SOURCE_MATRIX_IDS.indexOf(id) < failedIndex;
      return {
        id,
        verdict: failed ? "failed" : "not_observed",
        captureSite: "run-stage-verdict",
        // An absence names why it is an absence. Without this the reader
        // cannot tell a row nobody reached from one that is unreachable.
        ...(!failed && { notObservedReason: "the-run-ended-before-this-observation" as const }),
        evidence: { stage, ...(id === BONUS_ID && { gatesNothing: true }) },
      };
    }),
  ];
}

const RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("free_form")],
  ["/tier", field("enum", ["P4"])],
  ["/mode", field("enum", ["unlink", "verify"])],
  ["/provenance/captureSite", field("enum", ["run-b-receipt-run-start"])],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("hash")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  [
    "/provenance/command",
    field("enum", ["pnpm proof:run-b:unlink < /dev/null", "pnpm proof:run-b:verify < /dev/null"]),
  ],
  ["/provenance/observationStoreSha256", field("digest")],
  ["/matrix/*/id", field("enum", MATRIX_IDS)],
  ["/matrix/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/matrix/*/notObservedReason", field("enum", NOT_OBSERVED_REASONS)],
  [
    "/matrix/*/captureSite",
    field("enum", [
      "run-b-sandbox-probe",
      "phase-one-handoff",
      "throwaway-operations-oracle",
      "throwaway-credentials-oracle",
      "throwaway-media-oracle",
      "cold-process-client",
      "leak-scanner-self-test",
      "run-stage-verdict",
    ]),
  ],
  [
    "/matrix/*/evidence/stage",
    field("enum", [
      "sandbox",
      "handoff",
      "throwaway-open",
      "unlink",
      "operations-oracle",
      "credentials-oracle",
      "durable-compare",
      "media-compare",
      "cold-open",
      "repair",
    ]),
  ],

  // Phase 1, carried forward from the durable handoff.
  ["/matrix/*/evidence/phaseOneRunIdSha256", field("digest")],
  ["/matrix/*/evidence/phaseOneGitHead", field("git_sha")],
  ["/matrix/*/evidence/phaseOneSourceTreeHash", field("hash")],
  ["/matrix/*/evidence/phaseOneLinkedAt", field("iso8601")],
  ["/matrix/*/evidence/handoffFinalized", field("boolean")],
  ["/matrix/*/evidence/challengeValueLength", field("length")],
  ["/matrix/*/evidence/challengeValueRetained", field("boolean")],
  ["/matrix/*/evidence/laterConsumeNullsRetained", field("boolean")],
  ["/matrix/*/evidence/positiveControlRetained", field("boolean")],
  [
    "/matrix/*/evidence/onceOnlyEvidence",
    field("enum", ["handoff-finalized-after-assertions", "not_retained"]),
  ],
  [
    "/matrix/*/evidence/leakScanEvidence",
    field("enum", ["handoff-finalized-after-assertions", "not_retained"]),
  ],
  ["/matrix/*/evidence/sessionFactoryOpenCalls", field("count")],
  ["/matrix/*/evidence/reconnectCount", field("count")],
  ["/matrix/*/evidence/labelledRestartReconnectCount", field("count")],
  ["/matrix/*/evidence/conversationSyncBatches", field("count")],
  ["/matrix/*/evidence/conversationSyncChats", field("count")],
  ["/matrix/*/evidence/gatesNothing", field("boolean")],
  [
    "/matrix/*/evidence/observationKind",
    field("enum", ["native-first-link-history-sync", "injected-regression-control"]),
  ],

  // The leak scanner, re-verified live against this run's real corpus.
  ["/matrix/*/evidence/scannerScannedEntries", field("count")],
  ["/matrix/*/evidence/scannerScannedBytes", field("count")],
  ["/matrix/*/evidence/scannerCleanCorpusHits", field("count")],
  ["/matrix/*/evidence/scannerPlantedControlDetected", field("boolean")],
  ["/matrix/*/evidence/scannerControlKind", field("enum", ["synthetic-value-over-live-corpus"])],

  // Phase 2 oracles.
  ["/matrix/*/evidence/unlinkOperationCount", field("count")],
  ["/matrix/*/evidence/unlinkTerminalStatus", field("enum", ["succeeded"])],
  ["/matrix/*/evidence/authRowCount", field("count")],
  ["/matrix/*/evidence/credentialsCleared", field("boolean")],
  ["/matrix/*/evidence/logoutOrderingRetained", field("boolean")],
  ["/matrix/*/evidence/repairPairOperationCount", field("count")],
  [
    "/matrix/*/evidence/repairTerminalStatus",
    field("enum", ["outcome_unknown", "failed", "succeeded"]),
  ],
  ["/matrix/*/evidence/repairReachedSucceeded", field("boolean")],
  ["/matrix/*/evidence/credentialsStillClearedAfterRepair", field("boolean")],
  ["/matrix/*/evidence/coldRuntimeClosed", field("boolean")],
  ["/matrix/*/evidence/coldBackendReadable", field("boolean")],
  ["/matrix/*/evidence/coldLinkStatus", field("enum", ["needs_pairing", "pairing", "linked"])],
  ["/matrix/*/evidence/coldSessionFactoryOpenCalls", field("count")],
  ["/matrix/*/evidence/coldPid", field("count")],
  ["/matrix/*/evidence/distinctFromPhaseOnePid", field("boolean")],
  ["/matrix/*/evidence/outstandingLifecycleOperations", field("count")],

  // Durable preservation, compared asymmetrically.
  ["/matrix/*/evidence/comparisonBasis", field("enum", ["phase-one-counts"])],
  ["/matrix/*/evidence/phaseOneCounts/chats", field("count")],
  ["/matrix/*/evidence/phaseOneCounts/contacts", field("count")],
  ["/matrix/*/evidence/phaseOneCounts/groups", field("count")],
  ["/matrix/*/evidence/phaseOneCounts/messages", field("count")],
  ["/matrix/*/evidence/afterCounts/chats", field("count")],
  ["/matrix/*/evidence/afterCounts/contacts", field("count")],
  ["/matrix/*/evidence/afterCounts/groups", field("count")],
  ["/matrix/*/evidence/afterCounts/messages", field("count")],
  ["/matrix/*/evidence/countShortfall/chats", field("count")],
  ["/matrix/*/evidence/countShortfall/contacts", field("count")],
  ["/matrix/*/evidence/countShortfall/groups", field("count")],
  ["/matrix/*/evidence/countAdditions/chats", field("count")],
  ["/matrix/*/evidence/countAdditions/contacts", field("count")],
  ["/matrix/*/evidence/countAdditions/groups", field("count")],
  ["/matrix/*/evidence/durableIdDigest/chats", field("digest")],
  ["/matrix/*/evidence/durableIdDigest/contacts", field("digest")],
  ["/matrix/*/evidence/durableIdDigest/groups", field("digest")],
  ["/matrix/*/evidence/coldIdMissingCount/chats", field("count")],
  ["/matrix/*/evidence/coldIdMissingCount/contacts", field("count")],
  ["/matrix/*/evidence/coldIdMissingCount/groups", field("count")],
  ["/matrix/*/evidence/mediaFileCount", field("count")],
  ["/matrix/*/evidence/mediaDigest", field("digest")],
  ["/matrix/*/evidence/coldMediaDigest", field("digest")],
  ["/matrix/*/evidence/mediaDigestEqual", field("boolean")],

  // The derived sub-clause rows.
  ["/matrix/*/evidence/derivedFrom", field("enum", SOURCE_MATRIX_IDS)],
  ["/matrix/*/evidence/restartLabelRetained", field("boolean")],
  ["/matrix/*/evidence/beforeMessageCount", field("count")],
  ["/matrix/*/evidence/afterMessageCount", field("count")],
  ["/matrix/*/evidence/beforeMessageCountRetained", field("boolean")],
  ["/matrix/*/evidence/messageShortfall", field("count")],

  // The durable-profile sandbox, observed positively at run start.
  ["/matrix/*/evidence/permissionModelEnabled", field("boolean")],
  ["/matrix/*/evidence/deniedProfileReadAttempts", field("count")],
  ["/matrix/*/evidence/deniedProfileReadDenials", field("count")],
  ["/matrix/*/evidence/durableProfileHandlesOpened", field("count")],
  ["/matrix/*/evidence/durableProfileResumeRevalidatedHere", field("boolean")],

  // Present only on a corrected receipt, naming what it replaced and why.
  ["/correction/captureSite", field("enum", ["run-b-receipt-correction"])],
  ["/correction/reason", field("enum", CORRECTION_REASONS)],
  ["/correction/supersededSha256", field("digest")],
  ["/correction/supersededGitHead", field("git_sha")],
  ["/correction/correctedAtGitHead", field("git_sha")],
  ["/correction/correctedAtTreeClean", field("boolean")],
  ["/correction/correctedAt", field("iso8601")],
  ["/correction/loweredRowCount", field("count")],
  ["/correction/raisedRowCount", field("count")],
  ["/correction/addedRowCount", field("count")],

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
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

export function captureRunBRunStart(root: string): RunBRunStart {
  return {
    captureSite: "run-b-receipt-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

export function scanRunBReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, RECEIPT_SCHEMA);
}

const number = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

function validateStore(store: RunBObservationStore, current: CurrentRepoState): void {
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

  if (store.rows.length !== SOURCE_MATRIX_IDS.length)
    throw new Error(
      `refusing receipt: exactly ${SOURCE_MATRIX_IDS.length} source rows are required`,
    );
  const rows = new Map(store.rows.map((row) => [row.id, row]));
  if (rows.size !== SOURCE_MATRIX_IDS.length || SOURCE_MATRIX_IDS.some((id) => !rows.has(id)))
    throw new Error("refusing receipt: every required matrix row must be present exactly once");

  // No absence is presented as success, and none is presented without a
  // reason either. A `not_observed` row whose reason is missing reads as an
  // oversight; one on any other verdict is a reason contradicting its own row.
  for (const row of store.rows) {
    if (row.verdict === "not_observed" && row.notObservedReason === undefined)
      throw new Error(`refusing receipt: row ${row.id} is not_observed with no recorded reason`);
    if (row.verdict !== "not_observed" && row.notObservedReason !== undefined)
      throw new Error(`refusing receipt: row ${row.id} carries a reason it is not an absence for`);
  }

  // A phase-1 row is carried forward across processes. Currency is a tree
  // comparison rather than a judgement: if `src` moved since the scan, the
  // carried row no longer describes the head this receipt names.
  for (const row of store.rows) {
    if (row.captureSite !== "phase-one-handoff") continue;
    const carried = row.evidence.phaseOneSourceTreeHash;
    if (carried !== undefined && carried !== store.runStart.sourceTreeHash)
      throw new Error(
        "refusing receipt: a carried-forward phase-1 row was captured against a different source tree",
      );
  }

  const sandbox = rows.get("durable-profiles-untouched-by-run-b")!;
  if (sandbox.verdict === "observed") {
    const attempts = number(sandbox.evidence.deniedProfileReadAttempts);
    const denials = number(sandbox.evidence.deniedProfileReadDenials);
    if (
      sandbox.evidence.permissionModelEnabled !== true ||
      attempts === undefined ||
      attempts < 2 ||
      denials !== attempts ||
      sandbox.evidence.durableProfileHandlesOpened !== 0
    )
      throw new Error("refusing receipt: the durable-profile sandbox was not positively observed");
  }

  const cleared = rows.get("unlink-clears-only-target-credentials")!;
  if (cleared.verdict === "observed") {
    if (
      cleared.evidence.unlinkOperationCount !== 1 ||
      cleared.evidence.unlinkTerminalStatus !== "succeeded" ||
      cleared.evidence.authRowCount !== 0 ||
      cleared.evidence.credentialsCleared !== true
    )
      throw new Error("refusing receipt: the unlink credential observation is incomplete");
  }

  const preserved = rows.get("unlink-preserves-durable-chats-and-media")!;
  if (preserved.verdict === "observed") {
    const shortfall = preserved.evidence.countShortfall as
      | Readonly<Record<string, unknown>>
      | undefined;
    const missing = preserved.evidence.coldIdMissingCount as
      | Readonly<Record<string, unknown>>
      | undefined;
    // Asymmetric on purpose: live drift adds and mutates, it never deletes a
    // durable row. Additions are reported; a loss is a refusal.
    const noLoss =
      shortfall !== undefined &&
      missing !== undefined &&
      ["chats", "contacts", "groups"].every((key) => shortfall[key] === 0 && missing[key] === 0);
    if (!noLoss || preserved.evidence.mediaDigestEqual !== true)
      throw new Error("refusing receipt: durable preservation was not observed without loss");
  }

  const repair = rows.get("runtime-survives-unlink-and-accepts-repair")!;
  if (repair.verdict === "observed") {
    if (
      repair.evidence.repairPairOperationCount !== 1 ||
      repair.evidence.repairReachedSucceeded !== false ||
      repair.evidence.credentialsStillClearedAfterRepair !== true ||
      repair.evidence.coldRuntimeClosed !== false ||
      repair.evidence.coldBackendReadable !== true
    )
      throw new Error("refusing receipt: the repair-and-survive observation is incomplete");
  }

  const paired = rows.get("pair-links-through-one-session")!;
  if (paired.verdict === "observed" && paired.evidence.sessionFactoryOpenCalls !== 1)
    throw new Error("refusing receipt: the single-Session observation is incomplete");

  const bonus = rows.get(BONUS_ID)!;
  if (bonus.evidence.gatesNothing !== true)
    throw new Error("refusing receipt: the bonus row must declare that it gates nothing");
}

/**
 * The sub-clause rows, read off the source rows' own evidence.
 *
 * Three contract clauses carry a sub-clause the run does not reach on every
 * path, and a single verdict over the pair reports the unobserved half as
 * observed. `unlink-clears-only-target-credentials` read `observed` beside its
 * own `logoutOrderingRetained: false`; `unlink-preserves-durable-chats-and-media`
 * proved chats, contacts, groups and media and never compared **messages**,
 * which its clause names; and `pair-links-through-one-session` carried a bare
 * `reconnectCount`, which cannot distinguish the 515 `restart_required`
 * restart its clause requires from any other reconnect.
 *
 * They are **derived, never asserted**. A caller cannot hand in a verdict for
 * one, so a receipt cannot claim a sub-clause its own numbers contradict — the
 * shape that produced the defect in the first place.
 */
export function deriveRunBMatrix(rows: readonly RunBSourceMatrixRow[]): readonly RunBMatrixRow[] {
  const source = new Map(rows.map((row) => [row.id, row]));

  const derive = (
    id: RunBDerivedMatrixId,
    from: RunBSourceMatrixId,
    subClauseHolds: (evidence: Readonly<Record<string, unknown>>) => boolean,
    reason: RunBNotObservedReason,
    evidenceOf: (evidence: Readonly<Record<string, unknown>>) => Record<string, unknown>,
  ): RunBMatrixRow => {
    const parent = source.get(from)!;
    // A sub-clause of an observation nobody made is not observable either. The
    // parent's verdict is the ceiling; the sub-clause can only lower it.
    const verdict: RunBVerdict =
      parent.verdict === "failed"
        ? "failed"
        : parent.verdict === "observed" && subClauseHolds(parent.evidence)
          ? "observed"
          : "not_observed";
    return {
      id,
      verdict,
      ...(verdict === "not_observed" && {
        notObservedReason:
          parent.verdict === "observed" ? reason : "the-run-ended-before-this-observation",
      }),
      captureSite: parent.captureSite,
      evidence: { derivedFrom: from, ...evidenceOf(parent.evidence) },
    };
  };

  return [
    derive(
      "pair-restart-recorded-as-a-labelled-reconnect",
      "pair-links-through-one-session",
      // A count is not a label. This holds only once a run records how many of
      // its reconnects it identified as the 515 restart — which the phase-1
      // harness never did, and which no artifact can re-establish.
      (evidence) => number(evidence.labelledRestartReconnectCount) === 1,
      "no-reconnect-was-labelled-as-the-515-restart-in-the-spent-pairing",
      (evidence) => ({
        reconnectCount: evidence.reconnectCount,
        ...(evidence.labelledRestartReconnectCount !== undefined && {
          labelledRestartReconnectCount: evidence.labelledRestartReconnectCount,
        }),
        restartLabelRetained: evidence.labelledRestartReconnectCount !== undefined,
      }),
    ),
    derive(
      "unlink-logout-preceded-the-clear",
      "unlink-clears-only-target-credentials",
      (evidence) => evidence.logoutOrderingRetained === true,
      "logout-ordering-was-asserted-only-in-the-spent-unlinking-process",
      (evidence) => ({ logoutOrderingRetained: evidence.logoutOrderingRetained === true }),
    ),
    derive(
      "unlink-preserves-durable-messages",
      "unlink-preserves-durable-chats-and-media",
      // Asymmetric, like every other durable comparison here: a before-count is
      // required, and the after-count may only be at or above it.
      (evidence) => {
        const before = number(
          (evidence.phaseOneCounts as Readonly<Record<string, unknown>> | undefined)?.messages,
        );
        const after = number(
          (evidence.afterCounts as Readonly<Record<string, unknown>> | undefined)?.messages,
        );
        return before !== undefined && after !== undefined && after >= before;
      },
      "no-message-count-was-captured-before-the-spent-unlink",
      (evidence) => {
        const before = number(
          (evidence.phaseOneCounts as Readonly<Record<string, unknown>> | undefined)?.messages,
        );
        const after = number(
          (evidence.afterCounts as Readonly<Record<string, unknown>> | undefined)?.messages,
        );
        return {
          ...(before !== undefined && { beforeMessageCount: before }),
          ...(after !== undefined && { afterMessageCount: after }),
          beforeMessageCountRetained: before !== undefined,
          ...(before !== undefined &&
            after !== undefined && { messageShortfall: Math.max(0, before - after) }),
        };
      },
    ),
  ];
}

/**
 * The rows a Run B verdict is allowed to turn on. The bonus row is not one.
 *
 * Derived rows are not one either, and are excluded by construction rather
 * than by filter: this takes the source rows, which the derived ones are not.
 * They record residue the run cannot reach on any path — a runner that exited
 * non-zero on them would exit non-zero for ever while asserting nothing new.
 * The receipt carries them as `not_observed` with a reason, which is where an
 * unreachable clause belongs.
 */
export function gatingRows(rows: readonly RunBSourceMatrixRow[]): readonly RunBSourceMatrixRow[] {
  return rows.filter(({ id }) => id !== BONUS_ID);
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

export function assertRunBSanitizationDescribesFinalObject(
  receipt: Record<string, unknown>,
  knownValues: readonly string[],
): void {
  const sanitization = receipt.sanitization;
  if (typeof sanitization !== "object" || sanitization === null)
    throw new Error("receipt sanitization block is missing");
  if (Object.hasOwn(sanitization, "receiptByteLength"))
    throw new Error("Run B receipt must omit receiptByteLength to avoid a self-reference");
  const scan = scanRunBReceipt(receipt, knownValues);
  for (const [key, value] of Object.entries(scanMetricsWithoutByteLength(scan))) {
    if (Reflect.get(sanitization, key) !== value)
      throw new Error(`embedded sanitization metric ${key} does not describe the final receipt`);
  }
}

export interface RunBCorrection {
  readonly reason: RunBCorrectionReason;
  /** sha256 of the exact bytes being replaced, so a correction cannot drift. */
  readonly supersededSha256: string;
  readonly supersededGitHead: string;
  /** The head the correction was made at — later than the run's, by definition. */
  readonly correctedAtGitHead: string;
  readonly correctedAtTreeClean: boolean;
  readonly correctedAt: string;
  readonly loweredRowCount: number;
  readonly raisedRowCount: number;
  readonly addedRowCount: number;
}

/** Verdicts, worst first. A correction may lower a row; it may never raise one. */
const VERDICT_RANK: Readonly<Record<string, number>> = {
  failed: 0,
  not_observed: 1,
  observed: 2,
};

/**
 * Compare a corrected matrix against the one it supersedes.
 *
 * A correction exists to withdraw a claim. Raising a verdict is the opposite —
 * it is a run improving its own record without having run — so this refuses
 * one outright rather than counting it. A correction that lowered nothing and
 * added nothing is a no-op pretending to be a correction, and is refused too.
 */
export function correctionCounts(
  superseded: readonly { readonly id: string; readonly verdict: string }[],
  corrected: readonly RunBMatrixRow[],
): { loweredRowCount: number; raisedRowCount: number; addedRowCount: number } {
  const before = new Map(superseded.map((row) => [row.id, row.verdict]));
  let loweredRowCount = 0;
  let addedRowCount = 0;
  const raised: string[] = [];
  for (const row of corrected) {
    const previous = before.get(row.id);
    if (previous === undefined) {
      addedRowCount += 1;
      continue;
    }
    const delta = VERDICT_RANK[row.verdict]! - VERDICT_RANK[previous]!;
    if (delta < 0) loweredRowCount += 1;
    if (delta > 0) raised.push(row.id);
  }
  if (raised.length > 0)
    throw new Error(`refusing correction: it raises the verdict of ${raised.join(", ")}`);
  const dropped = superseded.filter((row) => !corrected.some(({ id }) => id === row.id));
  if (dropped.length > 0)
    throw new Error(`refusing correction: it drops ${dropped.map(({ id }) => id).join(", ")}`);
  if (loweredRowCount === 0 && addedRowCount === 0)
    throw new Error("refusing correction: it changes nothing, so it is not a correction");
  return { loweredRowCount, raisedRowCount: 0, addedRowCount };
}

export function buildRunBReceipt(
  store: RunBObservationStore,
  current: CurrentRepoState,
  correction?: RunBCorrection,
): Record<string, unknown> {
  validateStore(store, current);
  const observationStoreSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        runStart: store.runStart,
        mode: store.mode,
        finalizedAt: store.finalizedAt,
        rows: store.rows,
      }),
    )
    .digest("hex");
  const withoutSanitization = {
    schemaVersion: 1,
    issue: 112,
    scope: "Run B throwaway-slot pairing lifecycle and unlink",
    tier: "P4",
    mode: store.mode,
    provenance: {
      ...store.runStart,
      finalizedAt: store.finalizedAt,
      command:
        store.mode === "verify"
          ? "pnpm proof:run-b:verify < /dev/null"
          : "pnpm proof:run-b:unlink < /dev/null",
      observationStoreSha256,
    },
    // The derived sub-clause rows are appended by the writer, from the source
    // rows' own evidence, so no caller can assert one.
    matrix: [...store.rows, ...deriveRunBMatrix(store.rows)],
  };
  const withCorrection = correction
    ? {
        ...withoutSanitization,
        correction: { captureSite: "run-b-receipt-correction", ...correction },
      }
    : withoutSanitization;
  const preEmbedding = scanRunBReceipt(withCorrection, store.knownValues);
  const receipt = {
    ...withCorrection,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      ...scanMetricsWithoutByteLength(preEmbedding),
      knownValueControlCount: store.knownValues.length,
    },
  };
  assertRunBSanitizationDescribesFinalObject(receipt, store.knownValues);
  const finalScan = scanRunBReceipt(receipt, store.knownValues);
  if (
    finalScan.schemaUnknownFields !== 0 ||
    finalScan.schemaInvalidFields !== 0 ||
    finalScan.patternHits !== 0 ||
    finalScan.knownValueHits !== 0 ||
    !finalScan.floorPassed
  )
    throw new Error(`refusing unsanitized receipt: ${JSON.stringify(finalScan)}`);
  return receipt;
}

export function writeRunBReceipt(
  root: string,
  store: RunBObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildRunBReceipt(store, current);
  const directory = path.join(root, ".proof-receipts");
  mkdirSync(directory, { recursive: true });
  const runNumber =
    1 + readdirSync(directory).filter((name) => name.startsWith("issue112-p4.run")).length;
  const file = path.join(
    directory,
    `issue112-p4.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  try {
    writeFileSync(file, formatReceipt(root, receipt), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`refusing to overwrite existing receipt ${file}`);
    throw error;
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assertRunBSanitizationDescribesFinalObject(written, store.knownValues);
  return { file, scan: scanRunBReceipt(written, store.knownValues) };
}

const formatReceipt = (root: string, receipt: Record<string, unknown>): string =>
  execFileSync(
    path.join(root, "node_modules", ".bin", "vp"),
    ["fmt", "--stdin-filepath=.proof-receipts/receipt.json"],
    { cwd: root, input: `${JSON.stringify(receipt, null, 2)}\n`, encoding: "utf8" },
  );

/**
 * Replace a written receipt whose rows claimed more than the run observed.
 *
 * The append-only rule stops a run improving its own record; it does not
 * oblige the repository to keep a claim it has established is false. So this
 * is fenced rather than free: the matrix is re-derived from the run's own
 * observation store rather than edited, the bytes on disk must hash to
 * `supersededSha256` or the correction is refused, and `correctionCounts`
 * refuses any change that raises a verdict or drops a row.
 *
 * Nothing here observes anything. A correction can only ever withdraw.
 */
export function correctRunBReceipt(
  root: string,
  file: string,
  store: RunBObservationStore,
  reason: RunBCorrectionReason,
): {
  readonly file: string;
  readonly scan: ReceiptScanReport;
  readonly counts: ReturnType<typeof correctionCounts>;
} {
  const correctedAtGitHead = git(root, ["rev-parse", "HEAD"]);
  const correctedAtTreeClean = git(root, ["status", "--porcelain"]).length === 0;
  if (!correctedAtTreeClean) throw new Error("refusing correction: the worktree is dirty");
  // A correction is made at a later head than the run by construction, so head
  // equality is the wrong test. Currency is the tree comparison the mission
  // already uses: if `src` moved, the receipt no longer describes this
  // behaviour and the answer is a new run, not an edited record of an old one.
  if (git(root, ["rev-parse", "HEAD:src"]) !== store.runStart.sourceTreeHash)
    throw new Error(
      "refusing correction: src moved since the run, so the receipt is stale rather than wrong",
    );
  const absolute = path.isAbsolute(file) ? file : path.join(root, file);
  const bytes = readFileSync(absolute);
  const supersededSha256 = createHash("sha256").update(bytes).digest("hex");
  const superseded = JSON.parse(bytes.toString("utf8")) as {
    readonly provenance?: { readonly gitHead?: string; readonly observationStoreSha256?: string };
    readonly matrix?: readonly { readonly id: string; readonly verdict: string }[];
  };
  const supersededGitHead = superseded.provenance?.gitHead;
  if (typeof supersededGitHead !== "string")
    throw new Error("refusing correction: the superseded receipt names no head");
  if (supersededGitHead !== store.runStart.gitHead)
    throw new Error(
      "refusing correction: the observation store describes a different run than the receipt",
    );
  // The store is the run's own record; correcting one receipt from another
  // run's observations would be manufacturing evidence, not withdrawing it.
  const storeDigest = createHash("sha256")
    .update(
      JSON.stringify({
        runStart: store.runStart,
        mode: store.mode,
        finalizedAt: store.finalizedAt,
        rows: store.rows,
      }),
    )
    .digest("hex");
  if (superseded.provenance?.observationStoreSha256 !== storeDigest)
    throw new Error(
      "refusing correction: the observation store does not hash to the one the receipt was written from",
    );

  const counts = correctionCounts(superseded.matrix ?? [], [
    ...store.rows,
    ...deriveRunBMatrix(store.rows),
  ]);
  const receipt = buildRunBReceipt(
    store,
    // The run's own head, which the store carries. `validateStore` still
    // refuses a store whose head disagrees with the receipt it is correcting.
    { gitHead: store.runStart.gitHead, treeClean: correctedAtTreeClean },
    {
      reason,
      supersededSha256,
      supersededGitHead,
      correctedAtGitHead,
      correctedAtTreeClean,
      correctedAt: new Date().toISOString(),
      ...counts,
    },
  );
  writeFileSync(absolute, formatReceipt(root, receipt));
  const written = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
  assertRunBSanitizationDescribesFinalObject(written, store.knownValues);
  return { file: absolute, scan: scanRunBReceipt(written, store.knownValues), counts };
}

export { MATRIX_IDS, SOURCE_MATRIX_IDS, DERIVED_MATRIX_IDS, NOT_OBSERVED_REASONS, BONUS_ID };
