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

const MATRIX_IDS = [
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
 * The bonus row records the mission's only genuine first-link history sync.
 * M4 recorded it `not_observed`; it gates nothing here, and the writer refuses
 * a receipt in which it claims to.
 */
const BONUS_ID = "bonus-first-link-history-sync";

export type RunBMatrixId = (typeof MATRIX_IDS)[number];
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
  readonly captureSite: RunBCaptureSite;
  readonly evidence: Readonly<Record<string, unknown>>;
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
  readonly rows: readonly RunBMatrixRow[];
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
  rows: readonly RunBMatrixRow[],
  failedId: RunBMatrixId,
  stage: RunBStage,
): RunBMatrixRow[] {
  const failedIndex = MATRIX_IDS.indexOf(failedId);
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
    ...MATRIX_IDS.filter((id) => !completed.has(id)).map((id): RunBMatrixRow => {
      // The bonus row gates nothing, so a phase-2 failure never marks it
      // `failed` — it was either carried forward already or never reached. It
      // restates `gatesNothing` on this path too, because a row that declares
      // it only when observed leaves the claim absent exactly when a reader is
      // most likely to over-read the rest of the receipt.
      const failedHere = id === failedId && id !== BONUS_ID;
      return {
        id,
        verdict: failedHere || MATRIX_IDS.indexOf(id) < failedIndex ? "failed" : "not_observed",
        captureSite: "run-stage-verdict",
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

  // The durable-profile sandbox, observed positively at run start.
  ["/matrix/*/evidence/permissionModelEnabled", field("boolean")],
  ["/matrix/*/evidence/deniedProfileReadAttempts", field("count")],
  ["/matrix/*/evidence/deniedProfileReadDenials", field("count")],
  ["/matrix/*/evidence/durableProfileHandlesOpened", field("count")],
  ["/matrix/*/evidence/durableProfileResumeRevalidatedHere", field("boolean")],

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

  if (store.rows.length !== MATRIX_IDS.length)
    throw new Error(`refusing receipt: exactly ${MATRIX_IDS.length} source rows are required`);
  const rows = new Map(store.rows.map((row) => [row.id, row]));
  if (rows.size !== MATRIX_IDS.length || MATRIX_IDS.some((id) => !rows.has(id)))
    throw new Error("refusing receipt: every required matrix row must be present exactly once");

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

  const bonus = rows.get(BONUS_ID)!;
  if (bonus.evidence.gatesNothing !== true)
    throw new Error("refusing receipt: the bonus row must declare that it gates nothing");
}

/** The rows a Run B verdict is allowed to turn on. The bonus row is not one. */
export function gatingRows(rows: readonly RunBMatrixRow[]): readonly RunBMatrixRow[] {
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

export function buildRunBReceipt(
  store: RunBObservationStore,
  current: CurrentRepoState,
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
    matrix: store.rows,
  };
  const preEmbedding = scanRunBReceipt(withoutSanitization, store.knownValues);
  const receipt = {
    ...withoutSanitization,
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
  const formatted = execFileSync(
    path.join(root, "node_modules", ".bin", "vp"),
    ["fmt", "--stdin-filepath=.proof-receipts/receipt.json"],
    { cwd: root, input: `${JSON.stringify(receipt, null, 2)}\n`, encoding: "utf8" },
  );
  try {
    writeFileSync(file, formatted, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`refusing to overwrite existing receipt ${file}`);
    throw error;
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assertRunBSanitizationDescribesFinalObject(written, store.knownValues);
  return { file, scan: scanRunBReceipt(written, store.knownValues) };
}

export { MATRIX_IDS, BONUS_ID };
