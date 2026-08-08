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
  "resume-unattended",
  "inbound-text",
  "inbound-document",
  "attachment-bytes",
  "outbound-durable-send",
  "saved-state",
  "process-replacement",
] as const;

export type RunAMatrixId = (typeof MATRIX_IDS)[number];
export type RunAVerdict = "observed" | "not_observed" | "failed";

export interface RunAProofRunStart {
  readonly captureSite: "run-a-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface RunAMatrixRow {
  readonly id: RunAMatrixId;
  readonly verdict: RunAVerdict;
  readonly captureSite:
    | "subject-runtime-events"
    | "client-live-upsert"
    | "client-stored-page"
    | "client-message-record"
    | "client-media-read"
    | "android-client-operation-and-authoritative-echo"
    | "subject-client-runtime-backend-close"
    | "replacement-child-result"
    | "run-stage-verdict";
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface RunAProofObservationStore {
  readonly runStart: RunAProofRunStart;
  readonly finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly rows: readonly RunAMatrixRow[];
}

export interface CurrentRepoState {
  readonly gitHead: string;
  readonly treeClean: boolean;
}

export function outboundSendLanded(rows: readonly RunAMatrixRow[]): boolean {
  const outbound = rows.find(({ id }) => id === "outbound-durable-send");
  if (outbound?.verdict !== "observed") return false;
  const before = outbound.evidence.sessionSendInvocationsBefore;
  const after = outbound.evidence.sessionSendInvocationsAfter;
  return (
    outbound.evidence.terminalStatus === "succeeded" &&
    outbound.evidence.authoritativeEchoCount === 1 &&
    typeof before === "number" &&
    typeof after === "number" &&
    after === before + 1
  );
}

const RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("free_form")],
  ["/tier", field("enum", ["P4"])],
  ["/provenance/captureSite", field("enum", ["run-a-proof-run-start"])],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("hash")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  ["/provenance/command", field("enum", ["pnpm proof:run-a < /dev/null"])],
  ["/provenance/observationStoreSha256", field("digest")],
  ["/matrix/*/id", field("enum", MATRIX_IDS)],
  ["/matrix/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  [
    "/matrix/*/captureSite",
    field("enum", [
      "subject-runtime-events",
      "client-live-upsert",
      "client-stored-page",
      "client-message-record",
      "client-media-read",
      "android-client-operation-and-authoritative-echo",
      "subject-client-runtime-backend-close",
      "replacement-child-result",
      "run-stage-verdict",
    ]),
  ],
  [
    "/matrix/*/evidence/stage",
    field("enum", [
      "subject-open",
      "inbound-text",
      "inbound-document",
      "outbound-durable-send",
      "subject-close",
      "cold-replacement",
      "durable-comparison",
    ]),
  ],
  ["/matrix/*/evidence/linkMode", field("enum", ["resumed", "paired"])],
  ["/matrix/*/evidence/peerLinkMode", field("enum", ["resumed", "paired"])],
  ["/matrix/*/evidence/challengeEventCount", field("count")],
  ["/matrix/*/evidence/challengeProduced", field("boolean")],
  ["/matrix/*/evidence/interactive", field("boolean")],
  ["/matrix/*/evidence/subjectPid", field("count")],
  ["/matrix/*/evidence/peerPid", field("count")],
  ["/matrix/*/evidence/replacementPid", field("count")],
  ["/matrix/*/evidence/observedVia", field("enum", ["live-upsert", "stored-page"])],
  ["/matrix/*/evidence/nonceSha256", field("digest")],
  ["/matrix/*/evidence/nonceLength", field("length")],
  ["/matrix/*/evidence/chatsList", field("boolean")],
  ["/matrix/*/evidence/messagesGet", field("boolean")],
  ["/matrix/*/evidence/kind", field("enum", ["document"])],
  ["/matrix/*/evidence/mediaState", field("enum", ["stored"])],
  ["/matrix/*/evidence/byteLength", field("length")],
  ["/matrix/*/evidence/byteLengthMatches", field("boolean")],
  ["/matrix/*/evidence/sentSha256", field("digest")],
  ["/matrix/*/evidence/storedSha256", field("digest")],
  ["/matrix/*/evidence/equal", field("boolean")],
  ["/matrix/*/evidence/targetKind", field("enum", ["allowlisted-group"])],
  ["/matrix/*/evidence/bodySha256", field("digest")],
  ["/matrix/*/evidence/bodyLength", field("length")],
  ["/matrix/*/evidence/idempotencyKeySha256", field("digest")],
  ["/matrix/*/evidence/idempotencyKeyLength", field("length")],
  ["/matrix/*/evidence/operationIdSha256", field("digest")],
  ["/matrix/*/evidence/operationIdLength", field("length")],
  [
    "/matrix/*/evidence/statusTimeline/*",
    field("enum", ["queued", "claimed", "executing", "succeeded"]),
  ],
  ["/matrix/*/evidence/terminalStatus", field("enum", ["succeeded"])],
  ["/matrix/*/evidence/messageRefIdSha256", field("digest")],
  ["/matrix/*/evidence/messageRefIdLength", field("length")],
  ["/matrix/*/evidence/messageRefFromMe", field("boolean")],
  ["/matrix/*/evidence/messageRefChatMatchesTarget", field("boolean")],
  ["/matrix/*/evidence/authoritativeEchoCount", field("count")],
  ["/matrix/*/evidence/sessionSendInvocationsBefore", field("count")],
  ["/matrix/*/evidence/sessionSendInvocationsAfter", field("count")],
  ["/matrix/*/evidence/closeOrder/*", field("enum", ["client", "runtime", "backend"])],
  ["/matrix/*/evidence/durableDigest/chats", field("digest")],
  ["/matrix/*/evidence/durableDigest/contacts", field("digest")],
  ["/matrix/*/evidence/durableDigest/groups", field("digest")],
  ["/matrix/*/evidence/durableDigest/orderedIds", field("digest")],
  ["/matrix/*/evidence/durableDigest/media", field("digest")],
  ["/matrix/*/evidence/distinctPid", field("boolean")],
  ["/matrix/*/evidence/durableDigestEqual", field("boolean")],
  ["/matrix/*/evidence/componentMatches/chats", field("boolean")],
  ["/matrix/*/evidence/componentMatches/contacts", field("boolean")],
  ["/matrix/*/evidence/componentMatches/groups", field("boolean")],
  ["/matrix/*/evidence/componentMatches/orderedIds", field("boolean")],
  ["/matrix/*/evidence/componentMatches/media", field("boolean")],
  ["/matrix/*/evidence/stableProofStateEqual", field("boolean")],
  ["/matrix/*/evidence/collectionFloorsSatisfied", field("boolean")],
  ["/matrix/*/evidence/credentialIdentityMatchesOriginal", field("boolean")],
  ["/matrix/*/evidence/sessionAttached", field("boolean")],
  ["/matrix/*/evidence/liveSocketResumed", field("boolean")],
  ["/matrix/*/evidence/durableReconstructedWhileNoLive", field("boolean")],
  ["/matrix/*/evidence/connectionPresent", field("boolean")],
  ["/matrix/*/evidence/identityPresent", field("boolean")],
  ["/matrix/*/evidence/presenceObservationsRestored", field("count")],
  ["/matrix/*/evidence/lastConnectedAtPresent", field("boolean")],
  ["/matrix/*/evidence/lastDisconnectedAtPresent", field("boolean")],
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

export function captureRunAProofRunStart(root: string): RunAProofRunStart {
  return {
    captureSite: "run-a-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

export function scanRunAProofReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, RECEIPT_SCHEMA);
}

function validateStore(store: RunAProofObservationStore, current: CurrentRepoState): void {
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

  const rows = new Map(store.rows.map((row) => [row.id, row]));
  if (rows.size !== MATRIX_IDS.length || MATRIX_IDS.some((id) => !rows.has(id)))
    throw new Error("refusing receipt: every required matrix row must be present exactly once");

  const observedPids = store.rows.flatMap((row) => {
    const evidence = row.evidence;
    return ["subjectPid", "peerPid", "replacementPid"].flatMap((key) =>
      typeof evidence[key] === "number" ? [evidence[key] as number] : [],
    );
  });
  if (new Set(observedPids).size !== observedPids.length)
    throw new Error("refusing receipt: observed proof processes are not distinct");

  const outbound = rows.get("outbound-durable-send")!;
  if (
    outbound.verdict === "observed" &&
    (outbound.evidence.targetKind !== "allowlisted-group" ||
      outbound.evidence.terminalStatus !== "succeeded" ||
      outbound.evidence.authoritativeEchoCount !== 1 ||
      outbound.evidence.sessionSendInvocationsAfter !==
        (outbound.evidence.sessionSendInvocationsBefore as number) + 1)
  )
    throw new Error("refusing receipt: the outbound send observation is incomplete");

  const replacement = rows.get("process-replacement")!;
  if (
    replacement.verdict === "observed" &&
    (typeof replacement.evidence.replacementPid !== "number" ||
      replacement.evidence.distinctPid !== true ||
      replacement.evidence.stableProofStateEqual !== true ||
      replacement.evidence.collectionFloorsSatisfied !== true ||
      replacement.evidence.credentialIdentityMatchesOriginal !== true ||
      replacement.evidence.sessionAttached !== true ||
      replacement.evidence.liveSocketResumed !== false ||
      replacement.evidence.durableReconstructedWhileNoLive !== true)
  )
    throw new Error("refusing receipt: the replacement observation is incomplete");
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

export function assertRunAReceiptSanitizationDescribesFinalObject(
  receipt: Record<string, unknown>,
  knownValues: readonly string[],
): void {
  const sanitization = receipt.sanitization;
  if (typeof sanitization !== "object" || sanitization === null)
    throw new Error("receipt sanitization block is missing");
  if (Object.hasOwn(sanitization, "receiptByteLength")) {
    const actual = Buffer.byteLength(JSON.stringify(receipt));
    if (Reflect.get(sanitization, "receiptByteLength") !== actual)
      throw new Error("receiptByteLength does not describe the final serialized receipt");
    throw new Error("Run A receipt must omit receiptByteLength to avoid a self-reference");
  }
  const scan = scanRunAProofReceipt(receipt, knownValues);
  for (const [key, value] of Object.entries(scanMetricsWithoutByteLength(scan))) {
    if (Reflect.get(sanitization, key) !== value)
      throw new Error(`embedded sanitization metric ${key} does not describe the final receipt`);
  }
}

export function buildRunAProofReceipt(
  store: RunAProofObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  validateStore(store, current);
  const observationStoreSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        runStart: store.runStart,
        finalizedAt: store.finalizedAt,
        rows: store.rows,
      }),
    )
    .digest("hex");
  const withoutSanitization = {
    schemaVersion: 1,
    issue: 111,
    scope: "Run A exact-head linked Client path",
    tier: "P4",
    provenance: {
      ...store.runStart,
      finalizedAt: store.finalizedAt,
      command: "pnpm proof:run-a < /dev/null",
      observationStoreSha256,
    },
    matrix: store.rows,
  };
  const preEmbedding = scanRunAProofReceipt(withoutSanitization, store.knownValues);
  const receipt = {
    ...withoutSanitization,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      ...scanMetricsWithoutByteLength(preEmbedding),
      knownValueControlCount: store.knownValues.length,
    },
  };
  assertRunAReceiptSanitizationDescribesFinalObject(receipt, store.knownValues);
  const finalScan = scanRunAProofReceipt(receipt, store.knownValues);
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

export function writeRunAProofReceipt(
  root: string,
  store: RunAProofObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildRunAProofReceipt(store, current);
  const directory = path.join(root, ".proof-receipts");
  mkdirSync(directory, { recursive: true });
  const runNumber =
    1 + readdirSync(directory).filter((name) => name.startsWith("issue111-p4.run")).length;
  const file = path.join(
    directory,
    `issue111-p4.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  const formatted = execFileSync(
    path.join(root, "node_modules", ".bin", "vp"),
    ["fmt", "--stdin-filepath=.proof-receipts/receipt.json"],
    {
      cwd: root,
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
  assertRunAReceiptSanitizationDescribesFinalObject(written, store.knownValues);
  return { file, scan: scanRunAProofReceipt(written, store.knownValues) };
}
