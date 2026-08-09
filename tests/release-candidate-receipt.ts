/**
 * Schema, refusals, and writer for the 0.3.0 release-candidate receipt.
 *
 * Same convention as `tests/run-a-proof-receipt.ts`: the runner captures head
 * and cleanliness at source, this module transcribes, and the writer refuses a
 * mismatch. Every recorded verdict is re-derived here from the recorded
 * measurements, so a boolean that disagrees with its own numbers is a refusal
 * rather than a green field nobody can contradict.
 *
 * The tier is **P6**, not P4. This run reaches the packed tarball in a fresh
 * consumer; no linked WhatsApp account participates in it, so a P4 claim would
 * name a rung the run never touched.
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

export const TARBALL_CEILING_BYTES = 120_000;
export const EXPECTED_VERSION = "0.3.0-alpha.1";
export const EXPECTED_PREMODE_CHANGESET_COUNT = 12;
export const EXPECTED_PREMODE = "pre";
export const EXPECTED_PRERELEASE_TAG = "alpha";
export const EXPECTED_INITIAL_VERSION = "0.2.2";
export const RELEASE_CANDIDATE_SCHEMA_VERSION = 2;
export const RELEASE_CANDIDATE_SCOPE =
  "0.3.0 release candidate: version, tarball, and dual-Node packed consumer";
export const NODE_MATRIX_IDS = ["node22", "node24"] as const;

export type NodeMatrixId = (typeof NODE_MATRIX_IDS)[number];
export type MatrixVerdict = "observed" | "not_observed" | "failed";

export interface ReleaseCandidateRunStart {
  readonly captureSite: "release-candidate-proof-run-start";
  readonly gitHead: string;
  readonly sourceTreeHash: string;
  readonly treeHash: string;
  readonly treeClean: boolean;
  readonly startedAt: string;
}

export interface VersionObservation {
  readonly packageVersion: string;
  readonly pendingChangesetCount: number;
  readonly consumedChangesetCount: number;
  readonly changesetMode: string;
  readonly prereleaseTag: string;
  readonly initialVersion: string;
  readonly changelogSectionPresent: boolean;
  readonly changelogSectionLineCount: number;
  readonly changesetFixedGroupCount: number;
  readonly changesetLinkedGroupCount: number;
}

export interface TarballEntry {
  readonly path: string;
  readonly byteLength: number;
}

export interface TarballObservation {
  readonly byteLength: number;
  readonly sha256: string;
  readonly entries: readonly TarballEntry[];
  readonly unexpectedEntryCount: number;
  readonly missingRequiredRootFileCount: number;
  readonly forbiddenPatternHitCount: number;
}

export interface DistDigest {
  readonly file: string;
  readonly sha256: string;
}

export interface DistIdentityObservation {
  readonly digests: readonly DistDigest[];
  readonly packedMatchesFreshBuild: boolean;
}

export interface LeakScanObservation {
  readonly filesScanned: number;
  readonly hiddenFilesInCorpus: number;
  readonly accountShapedHits: number;
  readonly allowlistedSyntheticHits: number;
  readonly privatePathHits: number;
  readonly plantedControlHits: number;
  readonly plantedControlHiddenFileHits: number;
}

export interface NodeLegObservation {
  readonly id: NodeMatrixId;
  readonly verdict: MatrixVerdict;
  readonly observedVersion: string;
  readonly observedMajor: number;
  readonly writePid: number;
  readonly readPid: number;
  readonly durableDigestEqual: boolean;
  readonly deterministicDigest: string;
  readonly pageMessageCount: number;
  readonly mediaDigest: string;
  readonly liveConnectionObserved: boolean;
  readonly liveIdentityObserved: boolean;
  readonly livePresenceObserved: boolean;
  readonly connectionPresent: boolean;
  readonly identityPresent: boolean;
  readonly presenceRestored: boolean;
}

export interface ReleaseCandidateObservationStore {
  readonly runStart: ReleaseCandidateRunStart;
  finalizedAt?: string;
  readonly knownValues: readonly string[];
  readonly version: VersionObservation;
  readonly tarball: TarballObservation;
  readonly distIdentity: DistIdentityObservation;
  readonly leakScan: LeakScanObservation;
  readonly nodeMatrix: readonly NodeLegObservation[];
  readonly releaseSideEffects: ReleaseSideEffectObservation;
}

/**
 * The side effects this feature is forbidden to have produced.
 *
 * `localReleaseTagCount` alone could not disagree with the claim that matters —
 * it counts tags that already existed. The load-bearing field is
 * `candidateTagPresent`, measured by asking git for `v<version>` specifically,
 * with the total recorded beside it so a listing that suddenly sees nothing is
 * visible rather than silently reassuring.
 */
export interface ReleaseSideEffectObservation {
  readonly localReleaseTagCount: number;
  readonly candidateTag: string;
  readonly candidateTagPresent: boolean;
  readonly tagListingSawKnownTag: boolean;
}

export interface CurrentRepoState {
  readonly gitHead: string;
  readonly treeHash: string;
  readonly treeClean: boolean;
}

const RECEIPT_SCHEMA = new Map<string, ReceiptFieldSchema>([
  ["/schemaVersion", field("count")],
  ["/issue", field("count")],
  ["/scope", field("enum", [RELEASE_CANDIDATE_SCOPE])],
  ["/tier", field("enum", ["P6"])],

  ["/provenance/captureSite", field("enum", ["release-candidate-proof-run-start"])],
  ["/provenance/gitHead", field("git_sha")],
  ["/provenance/sourceTreeHash", field("git_sha")],
  ["/provenance/treeHash", field("git_sha")],
  ["/provenance/treeClean", field("boolean")],
  ["/provenance/startedAt", field("iso8601")],
  ["/provenance/finalizedAt", field("iso8601")],
  ["/provenance/command", field("free_form")],
  ["/provenance/observationStoreSha256", field("digest")],

  ["/version/captureSite", field("enum", ["package-json-and-changeset-directory"])],
  ["/version/packageVersion", field("free_form")],
  ["/version/expectedVersion", field("free_form")],
  ["/version/matchesExpected", field("boolean")],
  ["/version/pendingChangesetCount", field("count")],
  ["/version/consumedChangesetCount", field("count")],
  ["/version/changesetMode", field("enum", [EXPECTED_PREMODE])],
  ["/version/prereleaseTag", field("enum", [EXPECTED_PRERELEASE_TAG])],
  ["/version/initialVersion", field("free_form")],
  ["/version/changelogSectionPresent", field("boolean")],
  ["/version/changelogSectionLineCount", field("count")],
  ["/version/changesetFixedGroupCount", field("count")],
  ["/version/changesetLinkedGroupCount", field("count")],

  ["/tarball/captureSite", field("enum", ["pnpm-pack-output"])],
  ["/tarball/byteLength", field("count")],
  ["/tarball/ceilingBytes", field("count")],
  ["/tarball/underCeiling", field("boolean")],
  ["/tarball/sha256", field("digest")],
  ["/tarball/entryCount", field("count")],
  ["/tarball/unexpectedEntryCount", field("count")],
  ["/tarball/missingRequiredRootFileCount", field("count")],
  ["/tarball/forbiddenPatternHitCount", field("count")],
  ["/tarball/entries/*/path", field("free_form")],
  ["/tarball/entries/*/byteLength", field("count")],

  ["/distIdentity/captureSite", field("enum", ["packed-versus-fresh-build"])],
  ["/distIdentity/fileCount", field("count")],
  ["/distIdentity/packedMatchesFreshBuild", field("boolean")],
  ["/distIdentity/digests/*/file", field("free_form")],
  ["/distIdentity/digests/*/sha256", field("digest")],

  ["/leakScan/captureSite", field("enum", ["extracted-tarball-corpus"])],
  ["/leakScan/filesScanned", field("count")],
  ["/leakScan/hiddenFilesInCorpus", field("count")],
  ["/leakScan/accountShapedHits", field("count")],
  ["/leakScan/allowlistedSyntheticHits", field("count")],
  ["/leakScan/privatePathHits", field("count")],
  ["/leakScan/plantedControlHits", field("count")],
  ["/leakScan/plantedControlHiddenFileHits", field("count")],

  ["/nodeMatrix/*/id", field("enum", [...NODE_MATRIX_IDS])],
  ["/nodeMatrix/*/verdict", field("enum", ["observed", "not_observed", "failed"])],
  ["/nodeMatrix/*/captureSite", field("enum", ["packed-consumer-child-stdout"])],
  ["/nodeMatrix/*/observedVersion", field("free_form")],
  ["/nodeMatrix/*/observedMajor", field("count")],
  ["/nodeMatrix/*/writePid", field("count")],
  ["/nodeMatrix/*/readPid", field("count")],
  ["/nodeMatrix/*/distinctPids", field("boolean")],
  ["/nodeMatrix/*/durableDigestEqual", field("boolean")],
  ["/nodeMatrix/*/deterministicDigest", field("digest")],
  ["/nodeMatrix/*/pageMessageCount", field("count")],
  ["/nodeMatrix/*/mediaDigest", field("digest")],
  ["/nodeMatrix/*/liveConnectionObserved", field("boolean")],
  ["/nodeMatrix/*/liveIdentityObserved", field("boolean")],
  ["/nodeMatrix/*/livePresenceObserved", field("boolean")],
  ["/nodeMatrix/*/connectionPresent", field("boolean")],
  ["/nodeMatrix/*/identityPresent", field("boolean")],
  ["/nodeMatrix/*/presenceRestored", field("boolean")],

  ["/crossVersion/captureSite", field("enum", ["node-matrix-comparison"])],
  ["/crossVersion/legCount", field("count")],
  ["/crossVersion/distinctMajorCount", field("count")],
  ["/crossVersion/deterministicDigestsEqual", field("boolean")],

  ["/releaseSideEffects/captureSite", field("enum", ["local-git-tag-listing"])],
  ["/releaseSideEffects/localReleaseTagCount", field("count")],
  ["/releaseSideEffects/candidateTag", field("free_form")],
  ["/releaseSideEffects/candidateTagPresent", field("boolean")],
  ["/releaseSideEffects/tagListingSawKnownTag", field("boolean")],

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

export function captureReleaseCandidateRunStart(root: string): ReleaseCandidateRunStart {
  return {
    captureSite: "release-candidate-proof-run-start",
    gitHead: git(root, ["rev-parse", "HEAD"]),
    sourceTreeHash: git(root, ["rev-parse", "HEAD:src"]),
    treeHash: git(root, ["rev-parse", "HEAD^{tree}"]),
    treeClean: git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0,
    startedAt: new Date().toISOString(),
  };
}

export function scanReleaseCandidateReceipt(
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
 * The scanner counts *unknown* fields; it is silent about *missing* ones, so a
 * receipt that simply dropped half its observations passes every sanitization
 * check ever written. This is the other half: an unschema'd field is a refusal,
 * and so is a schema'd field that never arrived.
 */
export function missingReleaseCandidateFields(receipt: unknown): readonly string[] {
  const present = new Set(
    leafPointers(receipt).map((pointer) => pointer.replace(/\/\d+(?=\/|$)/gu, "/*")),
  );
  const version = Number(
    (typeof receipt === "object" && receipt !== null && Reflect.get(receipt, "schemaVersion")) || 0,
  );
  const version2 =
    /^\/(provenance\/treeHash|version\/(changesetMode|prereleaseTag|initialVersion))$/u;
  return [...RECEIPT_SCHEMA.keys()]
    .filter((key) => !present.has(key))
    .filter((key) => version >= 2 || !version2.test(key))
    .sort();
}

/**
 * The deterministic half of one leg's cross-major comparand.
 *
 * `account` is deliberately excluded: it carries `lastConnectedAt` and
 * `lastDisconnectedAt`, which are wall-clock instants the write leg stamps, so
 * it differs between two runs of the same code on the same runtime. Comparing
 * it across majors would fail on a correct implementation.
 */
export function deterministicDigestOf(namespaceDigests: Readonly<Record<string, string>>): string {
  const deterministic = Object.entries(namespaceDigests)
    .filter(([namespace]) => namespace !== "account")
    .sort(([left], [right]) => left.localeCompare(right));
  if (deterministic.length === 0)
    throw new Error("refusing a deterministic digest over no namespaces");
  return createHash("sha256").update(JSON.stringify(deterministic)).digest("hex");
}

export function validateReleaseCandidateStore(
  store: ReleaseCandidateObservationStore,
  current: CurrentRepoState,
): void {
  if (!store.runStart.treeClean || !current.treeClean)
    throw new Error("refusing receipt: the run or current worktree is dirty");
  if (store.runStart.gitHead !== current.gitHead)
    throw new Error("refusing receipt: current head does not match the captured run head");
  if (store.runStart.treeHash !== current.treeHash)
    throw new Error("refusing receipt: current tree does not match the captured candidate tree");
  if (!store.finalizedAt) throw new Error("refusing receipt: the run is not finalized");
  if (
    store.knownValues.length < 3 ||
    store.knownValues.some((value) => value.length === 0) ||
    new Set(store.knownValues).size !== store.knownValues.length
  )
    throw new Error("refusing receipt: known-value negative control is incomplete");

  if (store.version.packageVersion !== EXPECTED_VERSION)
    throw new Error(`refusing receipt: package version is not ${EXPECTED_VERSION}`);
  if (store.version.pendingChangesetCount !== EXPECTED_PREMODE_CHANGESET_COUNT)
    throw new Error("refusing receipt: the alpha pre-mode changeset set is incomplete");
  if (store.version.consumedChangesetCount !== EXPECTED_PREMODE_CHANGESET_COUNT)
    throw new Error("refusing receipt: the alpha receipt is not bound to the pre-mode changesets");
  if (store.version.changesetMode !== EXPECTED_PREMODE)
    throw new Error("refusing receipt: changesets is not in pre mode");
  if (store.version.prereleaseTag !== EXPECTED_PRERELEASE_TAG)
    throw new Error("refusing receipt: the prerelease tag is not alpha");
  if (store.version.initialVersion !== EXPECTED_INITIAL_VERSION)
    throw new Error("refusing receipt: the prerelease initial version is not 0.2.2");
  if (!store.version.changelogSectionPresent || store.version.changelogSectionLineCount < 2)
    throw new Error("refusing receipt: the alpha CHANGELOG section is absent or a stub");
  if (store.version.changesetFixedGroupCount !== 0 || store.version.changesetLinkedGroupCount !== 0)
    throw new Error("refusing receipt: changeset fixed/linked groups must stay empty");

  if (store.tarball.byteLength >= TARBALL_CEILING_BYTES)
    throw new Error("refusing receipt: the tarball is at or above the ceiling");
  if (store.tarball.entries.length === 0)
    throw new Error("refusing receipt: the tarball manifest is empty");
  if (
    store.tarball.unexpectedEntryCount !== 0 ||
    store.tarball.missingRequiredRootFileCount !== 0 ||
    store.tarball.forbiddenPatternHitCount !== 0
  )
    throw new Error("refusing receipt: the tarball manifest is not the intended file set");
  if (store.tarball.entries.reduce((total, entry) => total + entry.byteLength, 0) === 0)
    throw new Error("refusing receipt: every tarball entry measured zero bytes");

  if (store.distIdentity.digests.length === 0)
    throw new Error("refusing receipt: no packed dist digests were recorded");
  if (!store.distIdentity.packedMatchesFreshBuild)
    throw new Error("refusing receipt: the packed dist is not this tree's fresh build");

  if (store.leakScan.filesScanned === 0)
    throw new Error("refusing receipt: the leak scan looked at an empty corpus");
  if (store.leakScan.accountShapedHits !== 0 || store.leakScan.privatePathHits !== 0)
    throw new Error("refusing receipt: the tarball carries account or private-path material");
  if (store.leakScan.plantedControlHits === 0 || store.leakScan.plantedControlHiddenFileHits === 0)
    throw new Error("refusing receipt: the leak scan never proved it can see a planted positive");

  if (store.nodeMatrix.length !== NODE_MATRIX_IDS.length)
    throw new Error("refusing receipt: exactly two Node legs are required");
  const legs = new Map(store.nodeMatrix.map((leg) => [leg.id, leg]));
  if (legs.size !== NODE_MATRIX_IDS.length || NODE_MATRIX_IDS.some((id) => !legs.has(id)))
    throw new Error("refusing receipt: every Node leg must be present exactly once");
  const majors = new Set(store.nodeMatrix.map((leg) => leg.observedMajor));
  if (majors.size !== store.nodeMatrix.length)
    throw new Error("refusing receipt: two legs observed the same Node major");
  for (const leg of store.nodeMatrix) {
    const declaredMajor = Number(leg.id.replace("node", ""));
    if (leg.observedMajor !== declaredMajor)
      throw new Error(`refusing receipt: leg ${leg.id} observed Node ${leg.observedMajor}`);
    if (!leg.observedVersion.startsWith(`v${declaredMajor}.`))
      throw new Error(`refusing receipt: leg ${leg.id} reported ${leg.observedVersion}`);
    if (leg.verdict !== "observed") continue;
    if (leg.writePid === leg.readPid)
      throw new Error(`refusing receipt: leg ${leg.id} reused one OS process`);
    if (!leg.durableDigestEqual)
      throw new Error(`refusing receipt: leg ${leg.id} did not reconstruct its durable digest`);
    if (leg.pageMessageCount === 0)
      throw new Error(`refusing receipt: leg ${leg.id} paged no durable messages`);
    if (!leg.liveConnectionObserved || !leg.liveIdentityObserved || !leg.livePresenceObserved)
      throw new Error(`refusing receipt: leg ${leg.id} never observed the live state it denies`);
    if (leg.connectionPresent || leg.identityPresent || leg.presenceRestored)
      throw new Error(`refusing receipt: leg ${leg.id} reconstructed live state`);
  }
  const pids = store.nodeMatrix.flatMap((leg) => [leg.writePid, leg.readPid]);
  if (new Set(pids).size !== pids.length)
    throw new Error("refusing receipt: observed proof processes are not distinct");

  // Tagging and publishing are owner-held (#113). A tag for this version means
  // this run did something it had no authority to do.
  if (store.releaseSideEffects.candidateTag !== `v${store.version.packageVersion}`)
    throw new Error("refusing receipt: the candidate tag does not name the packaged version");
  if (store.releaseSideEffects.candidateTagPresent)
    throw new Error("refusing receipt: a tag for this version exists; tagging is owner-held");
  if (!store.releaseSideEffects.tagListingSawKnownTag)
    throw new Error("refusing receipt: the tag listing saw no known tag, so it proves no absence");
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

export function assertReleaseCandidateSanitizationDescribesFinalObject(
  receipt: Record<string, unknown>,
  knownValues: readonly string[],
): void {
  const sanitization = receipt.sanitization;
  if (typeof sanitization !== "object" || sanitization === null)
    throw new Error("receipt sanitization block is missing");
  if (Object.hasOwn(sanitization, "receiptByteLength"))
    throw new Error(
      "the release-candidate receipt must omit receiptByteLength: it self-references",
    );
  const scan = scanReleaseCandidateReceipt(receipt, knownValues);
  for (const [key, value] of Object.entries(scanMetricsWithoutByteLength(scan)))
    if (Reflect.get(sanitization, key) !== value)
      throw new Error(`embedded sanitization metric ${key} does not describe the final receipt`);
}

export function buildReleaseCandidateReceipt(
  store: ReleaseCandidateObservationStore,
  current: CurrentRepoState,
): Record<string, unknown> {
  validateReleaseCandidateStore(store, current);
  const observationStoreSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        runStart: store.runStart,
        finalizedAt: store.finalizedAt,
        version: store.version,
        tarball: store.tarball,
        distIdentity: store.distIdentity,
        leakScan: store.leakScan,
        nodeMatrix: store.nodeMatrix,
        releaseSideEffects: store.releaseSideEffects,
      }),
    )
    .digest("hex");
  const observedLegs = store.nodeMatrix.filter((leg) => leg.verdict === "observed");
  const withoutSanitization = {
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    issue: 112,
    scope: RELEASE_CANDIDATE_SCOPE,
    tier: "P6",
    provenance: {
      ...store.runStart,
      finalizedAt: store.finalizedAt,
      command: "pnpm proof:release",
      observationStoreSha256,
    },
    version: {
      captureSite: "package-json-and-changeset-directory",
      ...store.version,
      expectedVersion: EXPECTED_VERSION,
      matchesExpected: store.version.packageVersion === EXPECTED_VERSION,
    },
    tarball: {
      captureSite: "pnpm-pack-output",
      byteLength: store.tarball.byteLength,
      ceilingBytes: TARBALL_CEILING_BYTES,
      underCeiling: store.tarball.byteLength < TARBALL_CEILING_BYTES,
      sha256: store.tarball.sha256,
      entryCount: store.tarball.entries.length,
      unexpectedEntryCount: store.tarball.unexpectedEntryCount,
      missingRequiredRootFileCount: store.tarball.missingRequiredRootFileCount,
      forbiddenPatternHitCount: store.tarball.forbiddenPatternHitCount,
      entries: store.tarball.entries.map((entry) => ({ ...entry })),
    },
    distIdentity: {
      captureSite: "packed-versus-fresh-build",
      fileCount: store.distIdentity.digests.length,
      packedMatchesFreshBuild: store.distIdentity.packedMatchesFreshBuild,
      digests: store.distIdentity.digests.map((digest) => ({ ...digest })),
    },
    leakScan: { captureSite: "extracted-tarball-corpus", ...store.leakScan },
    nodeMatrix: store.nodeMatrix.map((leg) => ({
      id: leg.id,
      verdict: leg.verdict,
      captureSite: "packed-consumer-child-stdout",
      observedVersion: leg.observedVersion,
      observedMajor: leg.observedMajor,
      writePid: leg.writePid,
      readPid: leg.readPid,
      distinctPids: leg.writePid !== leg.readPid,
      durableDigestEqual: leg.durableDigestEqual,
      deterministicDigest: leg.deterministicDigest,
      pageMessageCount: leg.pageMessageCount,
      mediaDigest: leg.mediaDigest,
      liveConnectionObserved: leg.liveConnectionObserved,
      liveIdentityObserved: leg.liveIdentityObserved,
      livePresenceObserved: leg.livePresenceObserved,
      connectionPresent: leg.connectionPresent,
      identityPresent: leg.identityPresent,
      presenceRestored: leg.presenceRestored,
    })),
    crossVersion: {
      captureSite: "node-matrix-comparison",
      legCount: observedLegs.length,
      distinctMajorCount: new Set(observedLegs.map((leg) => leg.observedMajor)).size,
      deterministicDigestsEqual:
        observedLegs.length > 1 &&
        new Set(observedLegs.map((leg) => leg.deterministicDigest)).size === 1,
    },
    releaseSideEffects: { captureSite: "local-git-tag-listing", ...store.releaseSideEffects },
  };
  const preEmbedding = scanReleaseCandidateReceipt(withoutSanitization, store.knownValues);
  const receipt = {
    ...withoutSanitization,
    sanitization: {
      captureSite: "receipt-writer-in-memory",
      ...scanMetricsWithoutByteLength(preEmbedding),
      knownValueControlCount: store.knownValues.length,
    },
  };
  assertReleaseCandidateSanitizationDescribesFinalObject(receipt, store.knownValues);
  const missing = missingReleaseCandidateFields(receipt);
  if (missing.length > 0)
    throw new Error(`refusing incomplete receipt, missing: ${missing.join(", ")}`);
  const finalScan = scanReleaseCandidateReceipt(receipt, store.knownValues);
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

export function writeReleaseCandidateReceipt(
  root: string,
  store: ReleaseCandidateObservationStore,
): { readonly file: string; readonly scan: ReceiptScanReport } {
  const current = {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    treeHash: git(root, ["rev-parse", "HEAD^{tree}"]),
    treeClean: git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0,
  };
  const receipt = buildReleaseCandidateReceipt(store, current);
  const directory = path.join(root, ".proof-receipts");
  mkdirSync(directory, { recursive: true });
  const runNumber =
    1 + readdirSync(directory).filter((name) => name.startsWith("issue112-p6.run")).length;
  const file = path.join(
    directory,
    `issue112-p6.run${runNumber}-${store.runStart.gitHead.slice(0, 7)}.json`,
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
  assertReleaseCandidateSanitizationDescribesFinalObject(written, store.knownValues);
  return { file, scan: scanReleaseCandidateReceipt(written, store.knownValues) };
}
