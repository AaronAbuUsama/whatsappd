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
import type { CurrentRepoState, RunAProofRunStart } from "./run-a-proof-receipt.ts";

interface ComponentMatches {
  readonly chats: boolean;
  readonly contacts: boolean;
  readonly groups: boolean;
  readonly orderedIds: boolean;
  readonly media: boolean;
}

export interface RunADiagnosisObservationStore {
  readonly runStart: RunAProofRunStart;
  readonly finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly priorOutbound: {
    readonly sourceReceiptSha256: string;
    readonly sourceGitHead: string;
    readonly sourceTreeHash: string;
    readonly currentSourceTreeHash: string;
    readonly sourceTreeMatches: true;
    readonly terminalStatus: "succeeded";
    readonly authoritativeEchoCount: 1;
    readonly sessionSendInvocations: 1;
    readonly observedThisRun: false;
  };
  readonly liveDriftControl: {
    readonly subjectPid: number;
    readonly intervalMs: number;
    readonly noSendInvocations: 0;
    readonly componentMatches: ComponentMatches;
    readonly stableProofStateEqual: true;
    readonly collectionFloorsSatisfied: true;
  };
  readonly unnormalizedReplacement: {
    readonly replacementPid: number;
    readonly distinctPid: true;
    readonly noSendInvocations: 0;
    readonly componentMatches: ComponentMatches;
    readonly stableProofStateEqual: false;
    readonly collectionFloorsSatisfied: true;
    readonly credentialIdentityMatchesOriginal: true;
    readonly sessionAttached: true;
    readonly liveSocketResumed: false;
    readonly durableReconstructedWhileNoLive: true;
  };
  readonly replacement: {
    readonly replacementPid: number;
    readonly distinctPid: true;
    readonly noSendInvocations: 0;
    readonly componentMatches: ComponentMatches;
    readonly stableProofStateEqual: true;
    readonly collectionFloorsSatisfied: true;
    readonly credentialIdentityMatchesOriginal: true;
    readonly sessionAttached: true;
    readonly liveSocketResumed: false;
    readonly durableReconstructedWhileNoLive: true;
  };
  readonly conclusion: "proof-chat-window-asymmetry";
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
  ["/provenance/command", field("enum", ["pnpm proof:run-a:diagnose < /dev/null"])],
  ["/provenance/observationStoreSha256", field("digest")],
  ["/priorOutbound/captureSite", field("enum", ["carried-from-run2-receipt"])],
  ["/priorOutbound/sourceReceiptSha256", field("digest")],
  ["/priorOutbound/sourceGitHead", field("git_sha")],
  ["/priorOutbound/sourceTreeHash", field("hash")],
  ["/priorOutbound/currentSourceTreeHash", field("hash")],
  ["/priorOutbound/sourceTreeMatches", field("boolean")],
  ["/priorOutbound/terminalStatus", field("enum", ["succeeded"])],
  ["/priorOutbound/authoritativeEchoCount", field("count")],
  ["/priorOutbound/sessionSendInvocations", field("count")],
  ["/priorOutbound/observedThisRun", field("boolean")],
  ["/liveDriftControl/captureSite", field("enum", ["same-process-read-only-snapshots"])],
  ["/liveDriftControl/subjectPid", field("count")],
  ["/liveDriftControl/intervalMs", field("count")],
  ["/liveDriftControl/noSendInvocations", field("count")],
  ["/liveDriftControl/componentMatches/chats", field("boolean")],
  ["/liveDriftControl/componentMatches/contacts", field("boolean")],
  ["/liveDriftControl/componentMatches/groups", field("boolean")],
  ["/liveDriftControl/componentMatches/orderedIds", field("boolean")],
  ["/liveDriftControl/componentMatches/media", field("boolean")],
  ["/liveDriftControl/stableProofStateEqual", field("boolean")],
  ["/liveDriftControl/collectionFloorsSatisfied", field("boolean")],
  ["/unnormalizedReplacement/captureSite", field("enum", ["replacement-child-result"])],
  ["/unnormalizedReplacement/replacementPid", field("count")],
  ["/unnormalizedReplacement/distinctPid", field("boolean")],
  ["/unnormalizedReplacement/noSendInvocations", field("count")],
  ["/unnormalizedReplacement/componentMatches/chats", field("boolean")],
  ["/unnormalizedReplacement/componentMatches/contacts", field("boolean")],
  ["/unnormalizedReplacement/componentMatches/groups", field("boolean")],
  ["/unnormalizedReplacement/componentMatches/orderedIds", field("boolean")],
  ["/unnormalizedReplacement/componentMatches/media", field("boolean")],
  ["/unnormalizedReplacement/stableProofStateEqual", field("boolean")],
  ["/unnormalizedReplacement/collectionFloorsSatisfied", field("boolean")],
  ["/unnormalizedReplacement/credentialIdentityMatchesOriginal", field("boolean")],
  ["/unnormalizedReplacement/sessionAttached", field("boolean")],
  ["/unnormalizedReplacement/liveSocketResumed", field("boolean")],
  ["/unnormalizedReplacement/durableReconstructedWhileNoLive", field("boolean")],
  ["/replacement/captureSite", field("enum", ["replacement-child-result"])],
  ["/replacement/replacementPid", field("count")],
  ["/replacement/distinctPid", field("boolean")],
  ["/replacement/noSendInvocations", field("count")],
  ["/replacement/componentMatches/chats", field("boolean")],
  ["/replacement/componentMatches/contacts", field("boolean")],
  ["/replacement/componentMatches/groups", field("boolean")],
  ["/replacement/componentMatches/orderedIds", field("boolean")],
  ["/replacement/componentMatches/media", field("boolean")],
  ["/replacement/stableProofStateEqual", field("boolean")],
  ["/replacement/collectionFloorsSatisfied", field("boolean")],
  ["/replacement/credentialIdentityMatchesOriginal", field("boolean")],
  ["/replacement/sessionAttached", field("boolean")],
  ["/replacement/liveSocketResumed", field("boolean")],
  ["/replacement/durableReconstructedWhileNoLive", field("boolean")],
  ["/conclusion", field("enum", ["proof-chat-window-asymmetry"])],
  [
    "/assertionChange",
    field("enum", ["normalize-proof-chat-window-stable-exact-collections-relative-floor"]),
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

function metrics(scan: ReceiptScanReport): Record<string, unknown> {
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

export function scanRunADiagnosisReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, RECEIPT_SCHEMA);
}

export function buildRunADiagnosisReceipt(
  store: RunADiagnosisObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  if (!store.runStart.treeClean || !current.treeClean)
    throw new Error("refusing diagnosis receipt: the run or current worktree is dirty");
  if (store.runStart.gitHead !== current.gitHead)
    throw new Error("refusing diagnosis receipt: current head does not match the run head");
  if (!store.finalizedAt) throw new Error("refusing diagnosis receipt: the run is not finalized");
  if (store.knownValues.length < 3)
    throw new Error("refusing diagnosis receipt: known-value controls are incomplete");
  if (
    store.priorOutbound.observedThisRun !== false ||
    store.priorOutbound.sourceTreeMatches !== true
  )
    throw new Error("refusing diagnosis receipt: outbound evidence must be carried from run2");
  if (
    store.liveDriftControl.noSendInvocations !== 0 ||
    store.unnormalizedReplacement.noSendInvocations !== 0 ||
    store.replacement.noSendInvocations !== 0
  )
    throw new Error("refusing diagnosis receipt: the read-only run invoked a send");
  if (
    store.liveDriftControl.subjectPid === store.unnormalizedReplacement.replacementPid ||
    store.liveDriftControl.subjectPid === store.replacement.replacementPid ||
    store.unnormalizedReplacement.replacementPid === store.replacement.replacementPid
  )
    throw new Error("refusing diagnosis receipt: replacement pid is not distinct");
  if (
    store.unnormalizedReplacement.stableProofStateEqual !== false ||
    (store.unnormalizedReplacement.componentMatches.orderedIds &&
      store.unnormalizedReplacement.componentMatches.media)
  )
    throw new Error("refusing diagnosis receipt: unnormalized proof-chat asymmetry is absent");
  if (!store.replacement.stableProofStateEqual)
    throw new Error("refusing diagnosis receipt: stable proof-chat state changed");

  const observationStoreSha256 = createHash("sha256")
    .update(JSON.stringify({ ...store, knownValues: undefined }))
    .digest("hex");
  const withoutSanitization = {
    schemaVersion: 1,
    issue: 111,
    scope: "Run A non-sending process-replacement diagnosis",
    tier: "P4",
    provenance: {
      ...store.runStart,
      finalizedAt: store.finalizedAt,
      command: "pnpm proof:run-a:diagnose < /dev/null",
      observationStoreSha256,
    },
    priorOutbound: {
      captureSite: "carried-from-run2-receipt",
      ...store.priorOutbound,
    },
    liveDriftControl: {
      captureSite: "same-process-read-only-snapshots",
      ...store.liveDriftControl,
    },
    unnormalizedReplacement: {
      captureSite: "replacement-child-result",
      ...store.unnormalizedReplacement,
    },
    replacement: {
      captureSite: "replacement-child-result",
      ...store.replacement,
    },
    conclusion: store.conclusion,
    assertionChange: "normalize-proof-chat-window-stable-exact-collections-relative-floor",
  };
  const preEmbedding = scanRunADiagnosisReceipt(withoutSanitization, store.knownValues);
  const receipt = {
    ...withoutSanitization,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      ...metrics(preEmbedding),
      knownValueControlCount: store.knownValues.length,
    },
  };
  const finalScan = scanRunADiagnosisReceipt(receipt, store.knownValues);
  for (const [key, value] of Object.entries(metrics(finalScan))) {
    if (Reflect.get(receipt.sanitization, key) !== value)
      throw new Error(`embedded sanitization metric ${key} does not describe the final receipt`);
  }
  if (
    finalScan.schemaUnknownFields !== 0 ||
    finalScan.schemaInvalidFields !== 0 ||
    finalScan.patternHits !== 0 ||
    finalScan.knownValueHits !== 0 ||
    !finalScan.floorPassed
  )
    throw new Error(`refusing unsanitized diagnosis receipt: ${JSON.stringify(finalScan)}`);
  return receipt;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

export function writeRunADiagnosisReceipt(
  root: string,
  store: RunADiagnosisObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildRunADiagnosisReceipt(store, current);
  const directory = path.join(root, ".proof-receipts");
  mkdirSync(directory, { recursive: true });
  const runNumber =
    1 + readdirSync(directory).filter((name) => name.startsWith("issue111-p4.diagnosis")).length;
  const file = path.join(
    directory,
    `issue111-p4.diagnosis${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
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
  writeFileSync(file, formatted, { flag: "wx" });
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return { file, scan: scanRunADiagnosisReceipt(written, store.knownValues) };
}
