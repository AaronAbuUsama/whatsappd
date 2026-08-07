import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  receiptField as field,
  scanSchemaDrivenReceipt,
  type ReceiptFieldSchema,
  type ReceiptScanReport,
} from "./proof-receipt-scan.ts";

const RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("free_form")],
  ["/tier", field("enum", ["P4"])],
  ["/provenance/captureSite", field("enum", ["live-send-proof-run-start"])],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("hash")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  ["/provenance/command", field("enum", ["pnpm proof:live-send < /dev/null"])],
  [
    "/matrix/*/id",
    field("enum", ["real-account-durable-send-once", "allowlist-fails-closed-after-live-send"]),
  ],
  ["/matrix/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  [
    "/matrix/*/captureSite",
    field("enum", ["android-client-operation-and-retained-messages", "ios-peer-client-live-inbox"]),
  ],
  ["/matrix/*/evidence/subjectLinkMode", field("enum", ["resumed", "paired"])],
  ["/matrix/*/evidence/peerLinkMode", field("enum", ["resumed", "paired"])],
  ["/matrix/*/evidence/targetKind", field("enum", ["allowlisted-group"])],
  ["/matrix/*/evidence/bodySha256", field("digest")],
  ["/matrix/*/evidence/bodyLength", field("length")],
  ["/matrix/*/evidence/replayLabelSha256", field("digest")],
  ["/matrix/*/evidence/replayLabelLength", field("length")],
  ["/matrix/*/evidence/operationIdSha256", field("digest")],
  ["/matrix/*/evidence/operationIdLength", field("length")],
  [
    "/matrix/*/evidence/statusTimeline/*",
    field("enum", ["queued", "claimed", "executing", "succeeded"]),
  ],
  ["/matrix/*/evidence/operationCountForKey", field("count")],
  ["/matrix/*/evidence/replayReturnedSameOperation", field("boolean")],
  ["/matrix/*/evidence/messageRefPresent", field("boolean")],
  ["/matrix/*/evidence/messageRefIdSha256", field("digest")],
  ["/matrix/*/evidence/messageRefIdLength", field("length")],
  ["/matrix/*/evidence/messageRefFromMe", field("boolean")],
  ["/matrix/*/evidence/subjectMatchingMessages", field("count")],
  ["/matrix/*/evidence/subjectMessageRefMatches", field("boolean")],
  ["/matrix/*/evidence/peerMatchingMessages", field("count")],
  ["/matrix/*/evidence/peerInboxBeforeSend", field("count")],
  ["/matrix/*/evidence/peerInboxAfterSend", field("count")],
  ["/matrix/*/evidence/peerInboxAfterReplay", field("count")],
  ["/matrix/*/evidence/replaySentNothingFurther", field("boolean")],
  ["/matrix/*/evidence/targetSha256", field("digest")],
  ["/matrix/*/evidence/targetLength", field("length")],
  ["/matrix/*/evidence/refusalReason", field("enum", ["target_not_allowlisted"])],
  ["/matrix/*/evidence/peerInboxBeforeRefusal", field("count")],
  ["/matrix/*/evidence/peerInboxAfterRefusal", field("count")],
  ["/matrix/*/evidence/peerInboxUnchanged", field("boolean")],
  ["/sanitization/captureSite", field("enum", ["receipt-writer-in-memory"])],
  ["/sanitization/schemaUnknownFields", field("count")],
  ["/sanitization/schemaInvalidFields", field("count")],
  ["/sanitization/patternHits", field("count")],
  ["/sanitization/knownValueHits", field("count")],
  ["/sanitization/knownValueControlCount", field("count")],
  ["/sanitization/freeFormFields", field("count")],
  ["/sanitization/digestFields", field("count")],
  ["/sanitization/receiptByteLength", field("length")],
  ["/sanitization/nonEmpty", field("boolean")],
  ["/sanitization/floorPassed", field("boolean")],
]);

export interface LiveSendProofRunStart {
  readonly captureSite: "live-send-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface LiveSendProofSummary {
  readonly subjectLinkMode: "resumed" | "paired";
  readonly peerLinkMode: "resumed" | "paired";
  readonly bodySha256: string;
  readonly bodyLength: number;
  readonly replayLabelSha256: string;
  readonly replayLabelLength: number;
  readonly operationIdSha256: string;
  readonly operationIdLength: number;
  readonly statusTimeline: readonly ("queued" | "claimed" | "executing" | "succeeded")[];
  readonly operationCountForKey: number;
  readonly replayReturnedSameOperation: boolean;
  readonly messageRefPresent: boolean;
  readonly messageRefIdSha256: string;
  readonly messageRefIdLength: number;
  readonly messageRefFromMe: boolean;
  readonly subjectMatchingMessages: number;
  readonly subjectMessageRefMatches: boolean;
  readonly peerMatchingMessages: number;
  readonly peerInboxBeforeSend: number;
  readonly peerInboxAfterSend: number;
  readonly peerInboxAfterReplay: number;
  readonly replaySentNothingFurther: boolean;
  readonly refusedTargetSha256: string;
  readonly refusedTargetLength: number;
  readonly refusalReason: "target_not_allowlisted";
  readonly peerInboxBeforeRefusal: number;
  readonly peerInboxAfterRefusal: number;
  readonly peerInboxUnchanged: boolean;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

export function captureLiveSendProofRunStart(root: string): LiveSendProofRunStart {
  return {
    captureSite: "live-send-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

function receiptFor(
  runStart: LiveSendProofRunStart,
  finalizedAt: string,
  summary: LiveSendProofSummary,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    issue: 108,
    scope: "durable-live-send",
    tier: "P4",
    provenance: {
      ...runStart,
      finalizedAt,
      command: "pnpm proof:live-send < /dev/null",
    },
    matrix: [
      {
        id: "real-account-durable-send-once",
        verdict: "observed",
        captureSite: "android-client-operation-and-retained-messages",
        evidence: {
          subjectLinkMode: summary.subjectLinkMode,
          peerLinkMode: summary.peerLinkMode,
          targetKind: "allowlisted-group",
          bodySha256: summary.bodySha256,
          bodyLength: summary.bodyLength,
          replayLabelSha256: summary.replayLabelSha256,
          replayLabelLength: summary.replayLabelLength,
          operationIdSha256: summary.operationIdSha256,
          operationIdLength: summary.operationIdLength,
          statusTimeline: summary.statusTimeline,
          operationCountForKey: summary.operationCountForKey,
          replayReturnedSameOperation: summary.replayReturnedSameOperation,
          messageRefPresent: summary.messageRefPresent,
          messageRefIdSha256: summary.messageRefIdSha256,
          messageRefIdLength: summary.messageRefIdLength,
          messageRefFromMe: summary.messageRefFromMe,
          subjectMatchingMessages: summary.subjectMatchingMessages,
          subjectMessageRefMatches: summary.subjectMessageRefMatches,
          peerMatchingMessages: summary.peerMatchingMessages,
          peerInboxBeforeSend: summary.peerInboxBeforeSend,
          peerInboxAfterSend: summary.peerInboxAfterSend,
          peerInboxAfterReplay: summary.peerInboxAfterReplay,
          replaySentNothingFurther: summary.replaySentNothingFurther,
        },
      },
      {
        id: "allowlist-fails-closed-after-live-send",
        verdict: "observed",
        captureSite: "ios-peer-client-live-inbox",
        evidence: {
          targetSha256: summary.refusedTargetSha256,
          targetLength: summary.refusedTargetLength,
          refusalReason: summary.refusalReason,
          peerInboxBeforeRefusal: summary.peerInboxBeforeRefusal,
          peerInboxAfterRefusal: summary.peerInboxAfterRefusal,
          peerInboxUnchanged: summary.peerInboxUnchanged,
        },
      },
    ],
  };
}

export function scanLiveSendProofReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, RECEIPT_SCHEMA);
}

export interface LiveSendProofObservationStore {
  readonly runStart: LiveSendProofRunStart;
  readonly finalizedAt: string;
  readonly summary: LiveSendProofSummary;
  readonly knownValues: readonly string[];
}

export function buildLiveSendProofReceipt(input: LiveSendProofObservationStore): {
  readonly receipt: Record<string, unknown>;
  readonly scan: ReceiptScanReport;
} {
  const withoutScan = receiptFor(input.runStart, input.finalizedAt, input.summary);
  const firstScan = scanLiveSendProofReceipt(withoutScan, input.knownValues);
  const receipt = {
    ...withoutScan,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      ...firstScan,
      knownValueControlCount: input.knownValues.length,
    },
  };
  return { receipt, scan: scanLiveSendProofReceipt(receipt, input.knownValues) };
}

export function writeLiveSendProofReceipt(
  root: string,
  input: LiveSendProofObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const currentHead = git(root, ["rev-parse", "HEAD"]);
  const currentClean = git(root, ["status", "--porcelain"]).length === 0;
  if (!input.runStart.treeClean || !currentClean)
    throw new Error("refusing receipt: the run or current worktree is dirty");
  if (input.runStart.gitHead !== currentHead)
    throw new Error("refusing receipt: current head does not match the captured run head");

  const { receipt, scan } = buildLiveSendProofReceipt(input);
  if (
    scan.schemaUnknownFields !== 0 ||
    scan.schemaInvalidFields !== 0 ||
    scan.patternHits !== 0 ||
    scan.knownValueHits !== 0 ||
    !scan.floorPassed
  ) {
    throw new Error("refusing receipt: sanitization checks did not pass");
  }

  const directory = path.join(root, ".proof-receipts");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `issue108-p4.run1-${input.runStart.gitHead.slice(0, 7)}.json`);
  const formatted = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    writeFileSync(file, formatted, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`refusing to overwrite existing receipt ${file}`);
    throw error;
  }
  return { file, scan };
}
