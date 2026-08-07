import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type FieldType =
  | "hash"
  | "digest"
  | "count"
  | "length"
  | "boolean"
  | "enum"
  | "iso8601"
  | "git_sha"
  | "free_form";

interface FieldSchema {
  readonly type: FieldType;
  readonly values?: readonly string[];
}

const field = (type: FieldType, values?: readonly string[]): FieldSchema => ({ type, values });

const RECEIPT_SCHEMA = new Map<string, FieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("free_form")],
  ["/tier", field("enum", ["P4"])],
  ["/provenance/captureSite", field("enum", ["client-proof-run-start"])],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("hash")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  ["/provenance/command", field("enum", ["pnpm proof:client < /dev/null"])],
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
  ["/matrix/*/evidence/kind", field("enum", ["document"])],
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
  ["/matrix/*/evidence/connectionPresent", field("boolean")],
  ["/matrix/*/evidence/identityPresent", field("boolean")],
  ["/matrix/*/evidence/presenceAddressCount", field("count")],
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

export interface ReceiptScanReport {
  readonly schemaUnknownFields: number;
  readonly schemaInvalidFields: number;
  readonly patternHits: number;
  readonly knownValueHits: number;
  readonly freeFormFields: number;
  readonly digestFields: number;
  readonly receiptByteLength: number;
  readonly nonEmpty: boolean;
  readonly floorPassed: boolean;
}

interface PrimitiveLeaf {
  readonly path: string;
  readonly value: string | number | boolean | null;
}

function primitiveLeaves(value: unknown, pointer = ""): PrimitiveLeaf[] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [{ path: pointer, value }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: pointer, value: null }];
    return value.flatMap((entry, index) => primitiveLeaves(entry, `${pointer}/${index}`));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ path: pointer, value: null }];
    return entries.flatMap(([key, entry]) =>
      primitiveLeaves(entry, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
    );
  }
  return [{ path: pointer, value: null }];
}

function schemaPath(pointer: string): string {
  return pointer.replace(/\/\d+(?=\/|$)/g, "/*");
}

function validIso8601(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function fieldIsValid(schema: FieldSchema, value: PrimitiveLeaf["value"]): boolean {
  switch (schema.type) {
    case "hash":
      return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
    case "digest":
      return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    case "count":
    case "length":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && schema.values?.includes(value) === true;
    case "iso8601":
      return typeof value === "string" && validIso8601(value);
    case "git_sha":
      return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
    case "free_form":
      return typeof value === "string";
  }
}

function freeFormPatternHits(value: string): number {
  let hits = 0;
  if (/\d{7,}/u.test(value.replace(/[\s\-().+]/gu, ""))) hits++;
  if (/@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)/u.test(value)) hits++;
  if (/[A-Za-z0-9+/_-]{32,}={0,2}/u.test(value)) hits++;
  if (/(?:[A-Za-z0-9+/_-]+={0,2},){2,}[A-Za-z0-9+/_-]+={0,2}/u.test(value)) hits++;
  if (value.includes(".proof-private")) hits++;
  return hits;
}

export function scanClientProofReceipt(
  receipt: unknown,
  knownValues: readonly string[],
): ReceiptScanReport {
  const serialized = JSON.stringify(receipt);
  const leaves = primitiveLeaves(receipt);
  let schemaUnknownFields = 0;
  let schemaInvalidFields = 0;
  let patternHits = 0;
  let freeFormFields = 0;
  let digestFields = 0;

  for (const leaf of leaves) {
    const schema = RECEIPT_SCHEMA.get(schemaPath(leaf.path));
    if (!schema) {
      schemaUnknownFields++;
      continue;
    }
    if (!fieldIsValid(schema, leaf.value)) schemaInvalidFields++;
    if (schema.type === "free_form") {
      freeFormFields++;
      if (typeof leaf.value === "string") patternHits += freeFormPatternHits(leaf.value);
    }
    if (schema.type === "digest") digestFields++;
  }

  const knownValueHits = knownValues.filter(
    (value) => value.length > 0 && serialized.includes(value),
  ).length;
  const receiptByteLength = Buffer.byteLength(serialized);
  const nonEmpty = receiptByteLength > 2 && leaves.length > 0;
  const floorPassed = nonEmpty && freeFormFields > 0 && digestFields > 0;
  return {
    schemaUnknownFields,
    schemaInvalidFields,
    patternHits,
    knownValueHits,
    freeFormFields,
    digestFields,
    receiptByteLength,
    nonEmpty,
    floorPassed,
  };
}

export interface ClientProofRunStart {
  readonly captureSite: "client-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
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
    summary.replacement.durableDigestEqual !== true
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
  if (
    store.knownValues.length < 3 ||
    store.knownValues.some((value) => value.length === 0) ||
    new Set(store.knownValues).size !== store.knownValues.length
  ) {
    throw new Error("refusing receipt: known-value negative control is incomplete");
  }
  const receipt = {
    ...baseReceipt(store, current),
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      schemaUnknownFields: 0,
      schemaInvalidFields: 0,
      patternHits: 0,
      knownValueHits: 0,
      knownValueControlCount: store.knownValues.length,
      freeFormFields: 0,
      digestFields: 0,
      nonEmpty: true,
      floorPassed: true,
    },
  };
  const firstScan = scanClientProofReceipt(receipt, store.knownValues);
  receipt.sanitization = {
    captureSite: "receipt-writer-in-memory",
    schemaUnknownFields: firstScan.schemaUnknownFields,
    schemaInvalidFields: firstScan.schemaInvalidFields,
    patternHits: firstScan.patternHits,
    knownValueHits: firstScan.knownValueHits,
    knownValueControlCount: store.knownValues.length,
    freeFormFields: firstScan.freeFormFields,
    digestFields: firstScan.digestFields,
    nonEmpty: firstScan.nonEmpty,
    floorPassed: firstScan.floorPassed,
  };
  const finalScan = scanClientProofReceipt(receipt, store.knownValues);
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
