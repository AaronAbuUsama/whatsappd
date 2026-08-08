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
import {
  assertDurableReplayTeardownObservation,
  assertSyntheticTeardownControl,
  type TeardownProofSummary,
} from "./teardown-proof-summary.ts";

const RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("free_form")],
  ["/tier", field("enum", ["P1", "P4"])],
  [
    "/provenance/captureSite",
    field("enum", [
      "client-proof-run-start",
      "client-proof-guard-run-start",
      "pairing-proof-run-start",
      "teardown-proof-run-start",
    ]),
  ],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("hash")],
  ["/provenance/proofHarnessSha256", field("digest")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  [
    "/provenance/command",
    field("enum", [
      "pnpm proof:client < /dev/null",
      "pnpm proof:client:guard",
      "pnpm proof:pairing < /dev/null",
      "pnpm proof:teardown < /dev/null",
    ]),
  ],
  [
    "/matrix/*/id",
    field("enum", [
      "public-seams-compose",
      "resume-unattended",
      "peer-process",
      "inbound-text",
      "inbound-document",
      "attachment-bytes",
      "stored-paging",
      "page-boundary",
      "cold-process",
      "cold-no-live-state",
      "allowlist-unlisted-target-refused",
      "fresh-needs-pairing-no-socket",
      "linked-challenge-observer-synthetic-control",
      "linked-resume-no-challenge",
      "linked-pair-rejected",
      "synthetic-teardown-regression-control",
      "clean-stop-durable-replay",
      "lease-loss-guard",
      "history-sync-limitation",
    ]),
  ],
  ["/matrix/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  [
    "/matrix/*/captureSite",
    field("enum", [
      "subject-run-composition",
      "subject-runtime-events",
      "peer-child-result",
      "client-live-upsert",
      "client-stored-page",
      "client-message-record",
      "client-media-read",
      "client-stored-pages",
      "client-pages-then-store-oracle",
      "replacement-child-result",
      "replacement-client-factory",
      "recorded-session-command-log",
      "runtime-client-and-diagnostics",
      "client-account-observer",
      "client-account-observer-synthetic-control",
      "operation-store-and-diagnostics",
      "session-pipeline-empty-control",
      "ios-durable-row-replay",
      "renewal-loss-and-libsql-revision",
      "socket-history-delivery-limitation",
    ]),
  ],
  [
    "/matrix/*/evidence/composition/*",
    field("enum", [
      "fileMediaStore",
      "libsqlBackend",
      "createWhatsAppRuntime",
      "createWhatsAppClient",
    ]),
  ],
  [
    "/matrix/*/evidence/subjectImports/*",
    field("enum", ["package-root", "runtime-client-public-factory"]),
  ],
  ["/matrix/*/evidence/interactive", field("boolean")],
  ["/matrix/*/evidence/linkMode", field("enum", ["resumed", "paired"])],
  ["/matrix/*/evidence/challengeEventCount", field("count")],
  ["/matrix/*/evidence/nonChallengeEventCount", field("count")],
  ["/matrix/*/evidence/liveChallengeEventCount", field("count")],
  ["/matrix/*/evidence/qrDisplayed", field("boolean")],
  ["/matrix/*/evidence/stdoutContainedChallenge", field("boolean")],
  ["/matrix/*/evidence/subjectPid", field("count")],
  ["/matrix/*/evidence/peerPid", field("count")],
  ["/matrix/*/evidence/documentPeerPid", field("count")],
  ["/matrix/*/evidence/pageSeedPeerPid", field("count")],
  ["/matrix/*/evidence/replacementPid", field("count")],
  ["/matrix/*/evidence/subjectIdentityHash", field("digest")],
  ["/matrix/*/evidence/peerIdentityHash", field("digest")],
  [
    "/matrix/*/evidence/mode",
    field("enum", ["second-account-own-process", "allowlisted-peer-process"]),
  ],
  ["/matrix/*/evidence/observedVia", field("enum", ["live-upsert", "stored-page"])],
  ["/matrix/*/evidence/nonceSha256", field("digest")],
  ["/matrix/*/evidence/nonceLength", field("length")],
  ["/matrix/*/evidence/chatsList", field("boolean")],
  ["/matrix/*/evidence/messagesGet", field("boolean")],
  ["/matrix/*/evidence/mediaState", field("enum", ["stored"])],
  ["/matrix/*/evidence/byteLength", field("length")],
  ["/matrix/*/evidence/byteLengthMatches", field("boolean")],
  ["/matrix/*/evidence/sentSha256", field("digest")],
  ["/matrix/*/evidence/storedSha256", field("digest")],
  ["/matrix/*/evidence/equal", field("boolean")],
  ["/matrix/*/evidence/pageCount", field("count")],
  ["/matrix/*/evidence/terminalOlder", field("enum", ["exhausted"])],
  ["/matrix/*/evidence/repeatedAcrossBoundary", field("count")],
  ["/matrix/*/evidence/skippedAcrossBoundary", field("count")],
  ["/matrix/*/evidence/retainedCount", field("count")],
  ["/matrix/*/evidence/orderedIdDigest", field("digest")],
  ["/matrix/*/evidence/oracleOrderedIdDigest", field("digest")],
  ["/matrix/*/evidence/seededMessageCount", field("count")],
  ["/matrix/*/evidence/source", field("enum", ["allowlisted-peer-process"])],
  ["/matrix/*/evidence/distinctPid", field("boolean")],
  ["/matrix/*/evidence/durableDigestEqual", field("boolean")],
  ["/matrix/*/evidence/durableDigest/chats", field("digest")],
  ["/matrix/*/evidence/durableDigest/contacts", field("digest")],
  ["/matrix/*/evidence/durableDigest/groups", field("digest")],
  ["/matrix/*/evidence/durableDigest/orderedIds", field("digest")],
  ["/matrix/*/evidence/durableDigest/media", field("digest")],
  ["/matrix/*/evidence/credentialIdentityDigest", field("digest")],
  ["/matrix/*/evidence/credentialIdentityMatchesOriginal", field("boolean")],
  ["/matrix/*/evidence/sessionAttached", field("boolean")],
  ["/matrix/*/evidence/liveSocketResumed", field("boolean")],
  ["/matrix/*/evidence/durableReconstructedWhileNoLive", field("boolean")],
  ["/matrix/*/evidence/connectionPresent", field("boolean")],
  ["/matrix/*/evidence/identityPresent", field("boolean")],
  ["/matrix/*/evidence/presenceAddressCount", field("count")],
  ["/matrix/*/evidence/presenceObservationsRestored", field("count")],
  ["/matrix/*/evidence/lastConnectedAtPresent", field("boolean")],
  ["/matrix/*/evidence/lastDisconnectedAtPresent", field("boolean")],
  ["/matrix/*/evidence/targetSha256", field("digest")],
  ["/matrix/*/evidence/targetLength", field("length")],
  ["/matrix/*/evidence/refusalReason", field("enum", ["target_not_allowlisted"])],
  ["/matrix/*/evidence/sessionSendInvocations", field("count")],
  ["/matrix/*/evidence/freshLinkState", field("enum", ["needs_pairing"])],
  ["/matrix/*/evidence/observationMs", field("count")],
  ["/matrix/*/evidence/netSocketCount", field("count")],
  ["/matrix/*/evidence/tlsSocketCount", field("count")],
  ["/matrix/*/evidence/netControlCount", field("count")],
  ["/matrix/*/evidence/tlsControlCount", field("count")],
  ["/matrix/*/evidence/deterministicOpenCalls", field("count")],
  ["/matrix/*/evidence/synthetic", field("boolean")],
  ["/matrix/*/evidence/resumeMs", field("count")],
  ["/matrix/*/evidence/challengeProduced", field("boolean")],
  ["/matrix/*/evidence/pairOperationCount", field("count")],
  ["/matrix/*/evidence/secondSocketCount", field("count")],
  ["/matrix/*/evidence/sessionStillOnline", field("boolean")],
  [
    "/matrix/*/evidence/kind",
    field("enum", ["document", "synthetic_regression_control", "durable_replay_observation"]),
  ],
  ["/matrix/*/evidence/attemptBudget", field("count")],
  ["/matrix/*/evidence/qualifyingStops", field("count")],
  ["/matrix/*/evidence/unqualifiedStops", field("count")],
  ["/matrix/*/evidence/stopFailures", field("count")],
  ["/matrix/*/evidence/inFlightAtStop/*", field("count")],
  ["/matrix/*/evidence/stopPendingWhileHeld", field("count")],
  ["/matrix/*/evidence/syncAcceptances", field("count")],
  ["/matrix/*/evidence/leaseHeldWhileDraining", field("count")],
  ["/matrix/*/evidence/leaseFreeAfterStop", field("count")],
  ["/matrix/*/evidence/countsTowardNativeFloor", field("boolean")],
  ["/matrix/*/evidence/countsTowardReplacementFloor", field("boolean")],
  ["/matrix/*/evidence/durableRowsReplayed/*", field("count")],
  ["/matrix/*/evidence/historySyncOriginObserved", field("boolean")],
  ["/matrix/*/evidence/lossKind", field("enum", ["renewal_lost"])],
  ["/matrix/*/evidence/rejectionObserved", field("boolean")],
  ["/matrix/*/evidence/mirrorRevisionBefore", field("count")],
  ["/matrix/*/evidence/mirrorRevisionAfter", field("count")],
  ["/matrix/*/evidence/mirrorUnchanged", field("boolean")],
  ["/matrix/*/evidence/limitation", field("free_form")],
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

export function scanClientProofReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  return scanSchemaDrivenReceipt(receipt, knownValues, RECEIPT_SCHEMA);
}

export interface ClientProofRunStart {
  readonly captureSite: "client-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface ClientGuardProofRunStart {
  readonly captureSite: "client-proof-guard-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface PairingProofRunStart {
  readonly captureSite: "pairing-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly proofHarnessSha256: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface TeardownProofRunStart {
  readonly captureSite: "teardown-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly proofHarnessSha256: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface ClientProofSummary {
  readonly finalized: true;
  readonly interactive: false;
  readonly composition: readonly string[];
  readonly subjectImports: readonly string[];
  readonly linkMode: "resumed" | "paired";
  readonly challengeEventCount: number;
  readonly qrDisplayed: false;
  readonly stdoutContainedChallenge: false;
  readonly subjectPid: number;
  readonly peerPid: number;
  readonly documentPeerPid: number;
  readonly pageSeedPeerPid?: number;
  readonly replacementPid: number;
  readonly subjectIdentityHash: string;
  readonly peerIdentityHash: string;
  readonly peer: {
    readonly mode: "second-account-own-process";
    readonly linkMode: "resumed" | "paired";
    readonly challengeEventCount: number;
    readonly qrDisplayed: boolean;
  };
  readonly inboundText: {
    readonly observedVia: "live-upsert" | "stored-page";
    readonly nonceSha256: string;
    readonly nonceLength: number;
    readonly chatsList: true;
    readonly messagesGet: true;
  };
  readonly inboundDocument: {
    readonly kind: "document";
    readonly mediaState: "stored";
    readonly byteLength: number;
    readonly byteLengthMatches: true;
    readonly sentSha256: string;
    readonly storedSha256: string;
    readonly equal: true;
  };
  readonly pageSeed: {
    readonly sentThisRun: number;
    readonly retainedBeforeWalk: number;
    readonly orderedBodyDigest?: string;
  };
  readonly paging: {
    readonly pageCount: number;
    readonly terminalOlder: "exhausted";
    readonly repeatedAcrossBoundary: 0;
    readonly skippedAcrossBoundary: 0;
    readonly retainedCount: number;
    readonly orderedIdDigest: string;
    readonly oracleOrderedIdDigest: string;
  };
  readonly replacement: {
    readonly distinctPid: true;
    readonly durableDigestEqual: true;
    readonly durableDigest: {
      readonly chats: string;
      readonly contacts: string;
      readonly groups: string;
      readonly orderedIds: string;
      readonly media: string;
    };
    readonly credentialIdentityDigest: string;
    readonly credentialIdentityMatchesOriginal: true;
    readonly sessionAttached: true;
    readonly liveSocketResumed: false;
    readonly durableReconstructedWhileNoLive: true;
    readonly connectionPresent: false;
    readonly identityPresent: false;
    readonly presenceAddressCount: number;
    readonly presenceObservationsRestored: 0;
    readonly lastConnectedAtPresent: true;
    readonly lastDisconnectedAtPresent: true;
  };
}

export interface ClientProofObservationStore {
  readonly runStart: ClientProofRunStart;
  readonly finalizedAt?: string;
  readonly summary?: ClientProofSummary;
  readonly knownValues: readonly string[];
}

export interface ClientGuardProofObservationStore {
  readonly runStart: ClientGuardProofRunStart;
  readonly finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly guard?: {
    readonly targetSha256: string;
    readonly targetLength: number;
    readonly refusalReason: "target_not_allowlisted" | "allowlist_file_absent";
    readonly sessionSendInvocations: number;
  };
}

export interface PairingProofObservationStore {
  readonly runStart: PairingProofRunStart;
  readonly finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly summary?: {
    readonly interactive: false;
    readonly freshLinkState: "needs_pairing";
    readonly observationMs: number;
    readonly netSocketCount: 0;
    readonly netControlCount: number;
    readonly deterministicOpenCalls: 0;
    readonly syntheticChallengeObserverControl: {
      readonly kind: "synthetic";
      readonly nonChallengeEventCount: number;
      readonly liveChallengeEventCount: number;
    };
    readonly linkMode: "resumed";
    readonly resumeMs: number;
    readonly challengeEventCount: 0;
    readonly challengeProduced: false;
    readonly pairOperationCount: 0;
    readonly secondSocketCount: 0;
    readonly sessionStillOnline: true;
  };
}

export interface TeardownProofObservationStore {
  readonly runStart: TeardownProofRunStart;
  readonly finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly limitation: string;
  readonly syntheticRegressionControl?: TeardownProofSummary;
  readonly durableReplayObservation?: TeardownProofSummary;
}

export interface CurrentRepoState {
  readonly gitHead: string;
  readonly treeClean: boolean;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

export function captureClientProofRunStart(root: string): ClientProofRunStart {
  return {
    captureSite: "client-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

export function capturePairingProofRunStart(
  root: string,
  proofHarness: string,
): PairingProofRunStart {
  return {
    captureSite: "pairing-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    proofHarnessSha256: createHash("sha256").update(readFileSync(proofHarness)).digest("hex"),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

export function captureTeardownProofRunStart(
  root: string,
  proofHarness: string,
): TeardownProofRunStart {
  return {
    captureSite: "teardown-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    proofHarnessSha256: createHash("sha256").update(readFileSync(proofHarness)).digest("hex"),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

export function captureClientGuardProofRunStart(root: string): ClientGuardProofRunStart {
  return {
    captureSite: "client-proof-guard-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD^{tree}"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

function requireObservedStore(
  store: ClientProofObservationStore,
  current: CurrentRepoState,
): ClientProofSummary {
  if (!store.runStart.treeClean || !current.treeClean) {
    throw new Error("refusing receipt: the run or current worktree is dirty");
  }
  if (store.runStart.gitHead !== current.gitHead) {
    throw new Error("refusing receipt: current head does not match the captured run head");
  }
  if (!store.finalizedAt || !store.summary?.finalized) {
    throw new Error("refusing receipt: the run is not finalized");
  }
  const summary = store.summary;
  const pids = [
    summary.subjectPid,
    summary.peerPid,
    summary.documentPeerPid,
    ...(summary.pageSeedPeerPid === undefined ? [] : [summary.pageSeedPeerPid]),
    summary.replacementPid,
  ];
  if (new Set(pids).size !== pids.length) {
    throw new Error("refusing receipt: proof processes are not distinct");
  }
  if (
    summary.linkMode !== "resumed" ||
    summary.peer.linkMode !== "resumed" ||
    summary.inboundText.chatsList !== true ||
    summary.inboundText.messagesGet !== true ||
    summary.inboundDocument.equal !== true ||
    summary.paging.pageCount < 2 ||
    summary.paging.terminalOlder !== "exhausted" ||
    summary.paging.repeatedAcrossBoundary !== 0 ||
    summary.paging.skippedAcrossBoundary !== 0 ||
    summary.paging.orderedIdDigest !== summary.paging.oracleOrderedIdDigest ||
    summary.replacement.distinctPid !== true ||
    summary.replacement.durableDigestEqual !== true ||
    summary.replacement.credentialIdentityMatchesOriginal !== true ||
    summary.replacement.sessionAttached !== true ||
    summary.replacement.liveSocketResumed !== false ||
    summary.replacement.durableReconstructedWhileNoLive !== true
  ) {
    throw new Error("refusing receipt: one or more required observations are missing");
  }
  return summary;
}

function baseReceipt(
  store: ClientProofObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  const summary = requireObservedStore(store, current);
  return {
    schemaVersion: 1,
    issue: 127,
    scope: "Live Runtime and friendly Client read-path verification",
    tier: "P4",
    provenance: {
      ...store.runStart,
      finalizedAt: store.finalizedAt,
      command: "pnpm proof:client < /dev/null",
    },
    matrix: [
      {
        id: "public-seams-compose",
        verdict: "observed",
        captureSite: "subject-run-composition",
        evidence: {
          composition: summary.composition,
          subjectImports: summary.subjectImports,
        },
      },
      {
        id: "resume-unattended",
        verdict: "observed",
        captureSite: "subject-runtime-events",
        evidence: {
          interactive: summary.interactive,
          linkMode: summary.linkMode,
          challengeEventCount: summary.challengeEventCount,
          qrDisplayed: summary.qrDisplayed,
          stdoutContainedChallenge: summary.stdoutContainedChallenge,
        },
      },
      {
        id: "peer-process",
        verdict: "observed",
        captureSite: "peer-child-result",
        evidence: {
          subjectPid: summary.subjectPid,
          peerPid: summary.peerPid,
          documentPeerPid: summary.documentPeerPid,
          ...(summary.pageSeedPeerPid === undefined
            ? {}
            : { pageSeedPeerPid: summary.pageSeedPeerPid }),
          replacementPid: summary.replacementPid,
          subjectIdentityHash: summary.subjectIdentityHash,
          peerIdentityHash: summary.peerIdentityHash,
          mode: summary.peer.mode,
          linkMode: summary.peer.linkMode,
          challengeEventCount: summary.peer.challengeEventCount,
          qrDisplayed: summary.peer.qrDisplayed,
        },
      },
      {
        id: "inbound-text",
        verdict: "observed",
        captureSite:
          summary.inboundText.observedVia === "live-upsert"
            ? "client-live-upsert"
            : "client-stored-page",
        evidence: summary.inboundText,
      },
      {
        id: "inbound-document",
        verdict: "observed",
        captureSite: "client-message-record",
        evidence: {
          kind: summary.inboundDocument.kind,
          mediaState: summary.inboundDocument.mediaState,
          byteLength: summary.inboundDocument.byteLength,
          byteLengthMatches: summary.inboundDocument.byteLengthMatches,
        },
      },
      {
        id: "attachment-bytes",
        verdict: "observed",
        captureSite: "client-media-read",
        evidence: {
          sentSha256: summary.inboundDocument.sentSha256,
          storedSha256: summary.inboundDocument.storedSha256,
          equal: summary.inboundDocument.equal,
        },
      },
      {
        id: "stored-paging",
        verdict: "observed",
        captureSite: "client-stored-pages",
        evidence: {
          pageCount: summary.paging.pageCount,
          terminalOlder: summary.paging.terminalOlder,
          retainedCount: summary.paging.retainedCount,
        },
      },
      {
        id: "page-boundary",
        verdict: "observed",
        captureSite: "client-pages-then-store-oracle",
        evidence: {
          repeatedAcrossBoundary: summary.paging.repeatedAcrossBoundary,
          skippedAcrossBoundary: summary.paging.skippedAcrossBoundary,
          orderedIdDigest: summary.paging.orderedIdDigest,
          oracleOrderedIdDigest: summary.paging.oracleOrderedIdDigest,
        },
      },
      {
        id: "cold-process",
        verdict: "observed",
        captureSite: "replacement-child-result",
        evidence: {
          subjectPid: summary.subjectPid,
          replacementPid: summary.replacementPid,
          distinctPid: summary.replacement.distinctPid,
          durableDigestEqual: summary.replacement.durableDigestEqual,
          durableDigest: summary.replacement.durableDigest,
          credentialIdentityDigest: summary.replacement.credentialIdentityDigest,
          credentialIdentityMatchesOriginal: summary.replacement.credentialIdentityMatchesOriginal,
          sessionAttached: summary.replacement.sessionAttached,
          liveSocketResumed: summary.replacement.liveSocketResumed,
          durableReconstructedWhileNoLive: summary.replacement.durableReconstructedWhileNoLive,
        },
      },
      {
        id: "cold-no-live-state",
        verdict: "observed",
        captureSite: "replacement-client-factory",
        evidence: {
          connectionPresent: summary.replacement.connectionPresent,
          identityPresent: summary.replacement.identityPresent,
          presenceAddressCount: summary.replacement.presenceAddressCount,
          presenceObservationsRestored: summary.replacement.presenceObservationsRestored,
          lastConnectedAtPresent: summary.replacement.lastConnectedAtPresent,
          lastDisconnectedAtPresent: summary.replacement.lastDisconnectedAtPresent,
        },
      },
    ],
  };
}

export function buildClientProofReceipt(
  store: ClientProofObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  return sanitizedReceipt(baseReceipt(store, current), store.knownValues);
}

function validateKnownValues(knownValues: readonly string[]): void {
  if (
    knownValues.length < 3 ||
    knownValues.some((value) => value.length === 0) ||
    new Set(knownValues).size !== knownValues.length
  ) {
    throw new Error("refusing receipt: known-value negative control is incomplete");
  }
}

function sanitizedReceipt(
  base: Record<string, unknown>,
  knownValues: readonly string[],
): Record<string, unknown> {
  validateKnownValues(knownValues);
  const receipt = {
    ...base,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      schemaUnknownFields: 0,
      schemaInvalidFields: 0,
      patternHits: 0,
      knownValueHits: 0,
      knownValueControlCount: knownValues.length,
      freeFormFields: 0,
      digestFields: 0,
      nonEmpty: true,
      floorPassed: true,
    },
  };
  const firstScan = scanClientProofReceipt(receipt, knownValues);
  receipt.sanitization = {
    captureSite: "receipt-writer-in-memory",
    schemaUnknownFields: firstScan.schemaUnknownFields,
    schemaInvalidFields: firstScan.schemaInvalidFields,
    patternHits: firstScan.patternHits,
    knownValueHits: firstScan.knownValueHits,
    knownValueControlCount: knownValues.length,
    freeFormFields: firstScan.freeFormFields,
    digestFields: firstScan.digestFields,
    nonEmpty: firstScan.nonEmpty,
    floorPassed: firstScan.floorPassed,
  };
  const finalScan = scanClientProofReceipt(receipt, knownValues);
  if (
    finalScan.schemaUnknownFields !== 0 ||
    finalScan.schemaInvalidFields !== 0 ||
    finalScan.patternHits !== 0 ||
    finalScan.knownValueHits !== 0 ||
    !finalScan.floorPassed
  ) {
    throw new Error(`refusing unsanitized receipt: ${JSON.stringify(finalScan)}`);
  }
  return receipt;
}

export function buildClientGuardProofReceipt(
  store: ClientGuardProofObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  if (!store.runStart.treeClean || !current.treeClean) {
    throw new Error("refusing receipt: the run or current worktree is dirty");
  }
  if (store.runStart.gitHead !== current.gitHead) {
    throw new Error("refusing receipt: current head does not match the captured run head");
  }
  if (!store.finalizedAt) {
    throw new Error("refusing receipt: the run is not finalized");
  }
  if (
    store.guard?.refusalReason !== "target_not_allowlisted" ||
    store.guard.sessionSendInvocations !== 0 ||
    store.guard.targetLength === 0
  ) {
    throw new Error("refusing receipt: guard observation is incomplete");
  }
  return sanitizedReceipt(
    {
      schemaVersion: 1,
      issue: 127,
      scope: "Allowlist guard refusal verification with a recorded Session",
      tier: "P1",
      provenance: {
        ...store.runStart,
        finalizedAt: store.finalizedAt,
        command: "pnpm proof:client:guard",
      },
      matrix: [
        {
          id: "allowlist-unlisted-target-refused",
          verdict: "observed",
          captureSite: "recorded-session-command-log",
          evidence: store.guard,
        },
      ],
    },
    store.knownValues,
  );
}

export function buildPairingProofReceipt(
  store: PairingProofObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  if (!store.runStart.treeClean || !current.treeClean)
    throw new Error("refusing receipt: the run or current worktree is dirty");
  if (store.runStart.gitHead !== current.gitHead)
    throw new Error("refusing receipt: current head does not match the captured run head");
  if (!store.finalizedAt || !store.summary)
    throw new Error("refusing receipt: the pairing run is not finalized");
  const summary = store.summary;
  if (
    summary.interactive ||
    summary.freshLinkState !== "needs_pairing" ||
    summary.observationMs < 10_000 ||
    summary.netSocketCount !== 0 ||
    summary.netControlCount < 1 ||
    summary.deterministicOpenCalls !== 0 ||
    summary.syntheticChallengeObserverControl.kind !== "synthetic" ||
    summary.syntheticChallengeObserverControl.nonChallengeEventCount !== 0 ||
    summary.syntheticChallengeObserverControl.liveChallengeEventCount !== 1 ||
    summary.linkMode !== "resumed" ||
    summary.challengeEventCount !== 0 ||
    summary.challengeProduced ||
    summary.pairOperationCount !== 0 ||
    summary.secondSocketCount !== 0 ||
    !summary.sessionStillOnline
  )
    throw new Error("refusing receipt: pairing observation is incomplete");
  return sanitizedReceipt(
    {
      schemaVersion: 1,
      issue: 109,
      scope: "Unattended resume, fresh no-socket classification, and linked pair refusal",
      tier: "P4",
      provenance: {
        ...store.runStart,
        finalizedAt: store.finalizedAt,
        command: "pnpm proof:pairing < /dev/null",
      },
      matrix: [
        {
          id: "fresh-needs-pairing-no-socket",
          verdict: "observed",
          captureSite: "runtime-client-and-diagnostics",
          evidence: {
            interactive: summary.interactive,
            freshLinkState: summary.freshLinkState,
            observationMs: summary.observationMs,
            netSocketCount: summary.netSocketCount,
            netControlCount: summary.netControlCount,
            deterministicOpenCalls: summary.deterministicOpenCalls,
          },
        },
        {
          id: "linked-challenge-observer-synthetic-control",
          verdict: "observed",
          captureSite: "client-account-observer-synthetic-control",
          evidence: {
            synthetic: true,
            nonChallengeEventCount:
              summary.syntheticChallengeObserverControl.nonChallengeEventCount,
            liveChallengeEventCount:
              summary.syntheticChallengeObserverControl.liveChallengeEventCount,
          },
        },
        {
          id: "linked-resume-no-challenge",
          verdict: "observed",
          captureSite: "client-account-observer",
          evidence: {
            linkMode: summary.linkMode,
            resumeMs: summary.resumeMs,
            challengeEventCount: summary.challengeEventCount,
            challengeProduced: summary.challengeProduced,
          },
        },
        {
          id: "linked-pair-rejected",
          verdict: "observed",
          captureSite: "operation-store-and-diagnostics",
          evidence: {
            pairOperationCount: summary.pairOperationCount,
            secondSocketCount: summary.secondSocketCount,
            sessionStillOnline: summary.sessionStillOnline,
          },
        },
      ],
    },
    store.knownValues,
  );
}

const teardownEvidence = (summary: TeardownProofSummary): Record<string, unknown> => ({
  kind: summary.kind,
  attemptBudget: summary.attemptBudget,
  qualifyingStops: summary.qualifyingStops,
  unqualifiedStops: summary.unqualifiedStops,
  stopFailures: summary.stopFailures,
  inFlightAtStop: summary.inFlightAtStop,
  stopPendingWhileHeld: summary.stopPendingWhileHeld,
  syncAcceptances: summary.syncAcceptances,
  leaseHeldWhileDraining: summary.leaseHeldWhileDraining,
  leaseFreeAfterStop: summary.leaseFreeAfterStop,
  challengeProduced: summary.challengeProduced,
  countsTowardNativeFloor: summary.countsTowardNativeFloor,
  countsTowardReplacementFloor: summary.countsTowardReplacementFloor,
  durableRowsReplayed: summary.durableRowsReplayed,
  historySyncOriginObserved: summary.historySyncOriginObserved,
});

export function buildTeardownProofReceipt(
  store: TeardownProofObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  if (!store.runStart.treeClean || !current.treeClean)
    throw new Error("refusing receipt: the run or current worktree is dirty");
  if (store.runStart.gitHead !== current.gitHead)
    throw new Error("refusing receipt: current head does not match the captured run head");
  if (!store.finalizedAt || !store.syntheticRegressionControl || !store.durableReplayObservation)
    throw new Error("refusing receipt: the teardown run is not finalized");
  assertSyntheticTeardownControl(store.syntheticRegressionControl);
  assertDurableReplayTeardownObservation(store.durableReplayObservation);
  const guard = store.durableReplayObservation.leaseLossGuard!;
  if (
    !store.limitation.includes("History-sync-origin in-flight work was not observed") ||
    !store.limitation.includes("not a fresh history sync")
  )
    throw new Error("refusing receipt: the history-sync limitation is missing");
  return sanitizedReceipt(
    {
      schemaVersion: 1,
      issue: 109,
      scope: "Clean-stop draining with real durable iOS mirror rows",
      tier: "P4",
      provenance: {
        ...store.runStart,
        finalizedAt: store.finalizedAt,
        command: "pnpm proof:teardown < /dev/null",
      },
      matrix: [
        {
          id: "synthetic-teardown-regression-control",
          verdict: "observed",
          captureSite: "session-pipeline-empty-control",
          evidence: teardownEvidence(store.syntheticRegressionControl),
        },
        {
          id: "clean-stop-durable-replay",
          verdict: "observed",
          captureSite: "ios-durable-row-replay",
          evidence: teardownEvidence(store.durableReplayObservation),
        },
        {
          id: "lease-loss-guard",
          verdict: "observed",
          captureSite: "renewal-loss-and-libsql-revision",
          evidence: guard,
        },
        {
          id: "history-sync-limitation",
          verdict: "not_observed",
          captureSite: "socket-history-delivery-limitation",
          evidence: { limitation: store.limitation },
        },
      ],
    },
    store.knownValues,
  );
}

export function writeClientProofReceiptExclusive(
  root: string,
  file: string,
  receipt: Record<string, unknown>,
): void {
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite existing receipt ${file}`);
    }
    throw error;
  }
}

export function writePairingProofReceipt(
  root: string,
  store: PairingProofObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildPairingProofReceipt(store, current);
  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber =
    1 + readdirSync(outDir).filter((name) => name.startsWith("issue109-p4.run")).length;
  const file = path.join(
    outDir,
    `issue109-p4.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  writeClientProofReceiptExclusive(root, file, receipt);
  const written = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const scan = scanClientProofReceipt(written, store.knownValues);
  if (
    scan.schemaUnknownFields !== 0 ||
    scan.schemaInvalidFields !== 0 ||
    scan.patternHits !== 0 ||
    scan.knownValueHits !== 0 ||
    !scan.floorPassed
  )
    throw new Error(`written pairing receipt failed sanitization: ${JSON.stringify(scan)}`);
  return { file, scan };
}

export function writeTeardownProofReceipt(
  root: string,
  store: TeardownProofObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildTeardownProofReceipt(store, current);
  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber =
    1 + readdirSync(outDir).filter((name) => name.startsWith("issue109-teardown-p4.run")).length;
  const file = path.join(
    outDir,
    `issue109-teardown-p4.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  writeClientProofReceiptExclusive(root, file, receipt);
  const written = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const scan = scanClientProofReceipt(written, store.knownValues);
  if (
    scan.schemaUnknownFields !== 0 ||
    scan.schemaInvalidFields !== 0 ||
    scan.patternHits !== 0 ||
    scan.knownValueHits !== 0 ||
    !scan.floorPassed
  )
    throw new Error(`written teardown receipt failed sanitization: ${JSON.stringify(scan)}`);
  return { file, scan };
}

export function writeClientProofReceipt(
  root: string,
  store: ClientProofObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildClientProofReceipt(store, current);
  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber =
    1 + readdirSync(outDir).filter((name) => name.startsWith("issue127-p4.run")).length;
  const file = path.join(
    outDir,
    `issue127-p4.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  writeClientProofReceiptExclusive(root, file, receipt);
  const written = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const scan = scanClientProofReceipt(written, store.knownValues);
  if (
    scan.schemaUnknownFields !== 0 ||
    scan.schemaInvalidFields !== 0 ||
    scan.patternHits !== 0 ||
    scan.knownValueHits !== 0 ||
    !scan.floorPassed
  ) {
    throw new Error(`written receipt failed sanitization: ${JSON.stringify(scan)}`);
  }
  return { file, scan };
}

export function writeClientGuardProofReceipt(
  root: string,
  store: ClientGuardProofObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeClean: git(root, ["status", "--porcelain"]).length === 0,
  };
  const receipt = buildClientGuardProofReceipt(store, current);
  const outDir = path.join(root, ".proof-receipts");
  mkdirSync(outDir, { recursive: true });
  const runNumber =
    1 + readdirSync(outDir).filter((name) => name.startsWith("issue127-p1.run")).length;
  const file = path.join(
    outDir,
    `issue127-p1.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
  );
  writeClientProofReceiptExclusive(root, file, receipt);
  const written = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const scan = scanClientProofReceipt(written, store.knownValues);
  if (
    scan.schemaUnknownFields !== 0 ||
    scan.schemaInvalidFields !== 0 ||
    scan.patternHits !== 0 ||
    scan.knownValueHits !== 0 ||
    !scan.floorPassed
  ) {
    throw new Error(`written receipt failed sanitization: ${JSON.stringify(scan)}`);
  }
  return { file, scan };
}
