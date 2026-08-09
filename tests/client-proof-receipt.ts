import {
  captureProofRunStart,
  writeProofReceipt,
  type ProofReceiptScan,
  type ProofRunStart,
} from "./history-proof-receipt.ts";

export interface ClientProofRunStart extends ProofRunStart {
  readonly captureSite: "client-proof-run-start";
}

export interface ClientGuardProofRunStart extends ProofRunStart {
  readonly captureSite: "client-proof-guard-run-start";
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
  readonly subjectAddressHash: string;
  readonly peerAddressHash: string;
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
    readonly connectionPresent: false;
    readonly addressPresent: false;
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

export const captureClientProofRunStart = (cwd: string): ClientProofRunStart =>
  captureProofRunStart(cwd, "client-proof-run-start") as ClientProofRunStart;

export const captureClientGuardProofRunStart = (cwd: string): ClientGuardProofRunStart =>
  captureProofRunStart(
    cwd,
    "client-proof-guard-run-start",
    "HEAD^{tree}",
  ) as ClientGuardProofRunStart;

function requireSummary(store: ClientProofObservationStore): ClientProofSummary {
  const summary = store.summary;
  if (!store.finalizedAt || !summary?.finalized) {
    throw new Error("refusing receipt: the run is not finalized");
  }
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
    !summary.inboundText.chatsList ||
    !summary.inboundText.messagesGet ||
    !summary.inboundDocument.equal ||
    summary.paging.pageCount < 2 ||
    summary.paging.terminalOlder !== "exhausted" ||
    summary.paging.repeatedAcrossBoundary !== 0 ||
    summary.paging.skippedAcrossBoundary !== 0 ||
    summary.paging.orderedIdDigest !== summary.paging.oracleOrderedIdDigest ||
    !summary.replacement.distinctPid ||
    !summary.replacement.durableDigestEqual
  ) {
    throw new Error("refusing receipt: one or more required observations are missing");
  }
  return summary;
}

export function buildClientProofReceipt(
  store: ClientProofObservationStore,
): Record<string, unknown> {
  const summary = requireSummary(store);
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
          subjectAddressHash: summary.subjectAddressHash,
          peerAddressHash: summary.peerAddressHash,
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
        },
      },
      {
        id: "cold-no-live-state",
        verdict: "observed",
        captureSite: "replacement-client-factory",
        evidence: {
          connectionPresent: summary.replacement.connectionPresent,
          addressPresent: summary.replacement.addressPresent,
          presenceAddressCount: summary.replacement.presenceAddressCount,
          presenceObservationsRestored: summary.replacement.presenceObservationsRestored,
          lastConnectedAtPresent: summary.replacement.lastConnectedAtPresent,
          lastDisconnectedAtPresent: summary.replacement.lastDisconnectedAtPresent,
        },
      },
    ],
  };
}

export function writeClientProofReceipt(
  cwd: string,
  store: ClientProofObservationStore,
): { readonly file: string; readonly scan: ProofReceiptScan } {
  return writeProofReceipt({
    cwd,
    prefix: "issue127-p4.run",
    runStart: store.runStart,
    finalizedAt: store.finalizedAt,
    knownValues: store.knownValues,
    receipt: buildClientProofReceipt(store),
  });
}

export function buildClientGuardProofReceipt(
  store: ClientGuardProofObservationStore,
): Record<string, unknown> {
  if (!store.finalizedAt) throw new Error("refusing receipt: the run is not finalized");
  if (
    store.guard?.refusalReason !== "target_not_allowlisted" ||
    store.guard.sessionSendInvocations !== 0 ||
    store.guard.targetLength === 0
  ) {
    throw new Error("refusing receipt: guard observation is incomplete");
  }
  return {
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
  };
}

export function writeClientGuardProofReceipt(
  cwd: string,
  store: ClientGuardProofObservationStore,
): { readonly file: string; readonly scan: ProofReceiptScan } {
  return writeProofReceipt({
    cwd,
    prefix: "issue127-p1.run",
    runStart: store.runStart,
    finalizedAt: store.finalizedAt,
    knownValues: store.knownValues,
    receipt: buildClientGuardProofReceipt(store),
  });
}
