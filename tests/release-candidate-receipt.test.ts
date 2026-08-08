import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./_expect.ts";
import {
  EXPECTED_VERSION,
  EXPECTED_PREMODE_CHANGESET_COUNT,
  NODE_MATRIX_IDS,
  RELEASE_CANDIDATE_SCOPE,
  TARBALL_CEILING_BYTES,
  assertReleaseCandidateSanitizationDescribesFinalObject,
  buildReleaseCandidateReceipt,
  deterministicDigestOf,
  missingReleaseCandidateFields,
  scanReleaseCandidateReceipt,
  validateReleaseCandidateStore,
  type CurrentRepoState,
  type NodeLegObservation,
  type ReleaseCandidateObservationStore,
} from "./release-candidate-receipt.ts";
import {
  ACCOUNT_SHAPED_SOURCE,
  FORBIDDEN_TARBALL_ENTRY_SOURCES,
  INTENDED_ROOT_FILES,
  PACKED_ALLOWLISTED_ACCOUNT_IDS,
  PLANTED_LEAK_CANARY,
  scanPackedCorpus,
} from "./release-candidate-scan.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiptDirectory = path.join(root, ".proof-receipts");
const committedReceipts = readdirSync(receiptDirectory)
  .filter((name) => name.startsWith("issue112-p6.run") && name.endsWith(".json"))
  .sort();

const KNOWN_VALUES = ["Packed consumer", "Packed room", "packed.bin", ".proof-private"] as const;

const digest = (seed: string): string => "a".repeat(63) + seed;
const gitSha = (seed: string): string => "b".repeat(39) + seed;

const leg = (
  id: (typeof NODE_MATRIX_IDS)[number],
  major: number,
  overrides: Partial<NodeLegObservation> = {},
): NodeLegObservation => ({
  id,
  verdict: "observed",
  observedVersion: `v${major}.9.1`,
  observedMajor: major,
  writePid: major * 100 + 1,
  readPid: major * 100 + 2,
  durableDigestEqual: true,
  deterministicDigest: digest("1"),
  pageMessageCount: 2,
  mediaDigest: digest("2"),
  liveConnectionObserved: true,
  liveIdentityObserved: true,
  livePresenceObserved: true,
  connectionPresent: false,
  identityPresent: false,
  presenceRestored: false,
  ...overrides,
});

const store = (
  overrides: Partial<ReleaseCandidateObservationStore> = {},
): ReleaseCandidateObservationStore => ({
  runStart: {
    captureSite: "release-candidate-proof-run-start",
    gitHead: gitSha("0"),
    sourceTreeHash: gitSha("1"),
    treeClean: true,
    startedAt: "2026-08-08T00:00:00Z",
  },
  finalizedAt: "2026-08-08T00:05:00Z",
  knownValues: [...KNOWN_VALUES],
  version: {
    packageVersion: EXPECTED_VERSION,
    pendingChangesetCount: EXPECTED_PREMODE_CHANGESET_COUNT,
    consumedChangesetCount: EXPECTED_PREMODE_CHANGESET_COUNT,
    changelogSectionPresent: true,
    changelogSectionLineCount: 180,
    changesetFixedGroupCount: 0,
    changesetLinkedGroupCount: 0,
  },
  tarball: {
    byteLength: 98_398,
    sha256: digest("3"),
    entries: [
      { path: "CHANGELOG.md", byteLength: 16_016 },
      { path: "LICENSE", byteLength: 1071 },
      { path: "README.md", byteLength: 8340 },
      { path: "dist/index.mjs", byteLength: 138_006 },
      { path: "package.json", byteLength: 3670 },
    ],
    unexpectedEntryCount: 0,
    missingRequiredRootFileCount: 0,
    forbiddenPatternHitCount: 0,
  },
  distIdentity: {
    digests: [{ file: "dist/index.mjs", sha256: digest("4") }],
    packedMatchesFreshBuild: true,
  },
  leakScan: {
    filesScanned: 10,
    hiddenFilesInCorpus: 0,
    accountShapedHits: 0,
    allowlistedSyntheticHits: 2,
    privatePathHits: 0,
    plantedControlHits: 1,
    plantedControlHiddenFileHits: 1,
  },
  nodeMatrix: [leg("node22", 22), leg("node24", 24)],
  releaseSideEffects: {
    localReleaseTagCount: 2,
    candidateTag: `v${EXPECTED_VERSION}`,
    candidateTagPresent: false,
    tagListingSawKnownTag: true,
  },
  ...overrides,
});

const current: CurrentRepoState = { gitHead: gitSha("0"), treeClean: true };

const refuses = (
  overrides: Partial<ReleaseCandidateObservationStore>,
  expected: RegExp,
  repoState: CurrentRepoState = current,
): void =>
  assert.throws(() => validateReleaseCandidateStore(store(overrides), repoState), expected);

test("the release-candidate receipt is schema-known, sanitary, and non-vacuous", () => {
  const receipt = buildReleaseCandidateReceipt(store(), current);
  const scan = scanReleaseCandidateReceipt(receipt, [...KNOWN_VALUES]);

  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);
  assert.ok(scan.freeFormFields > 0);
  assert.ok(scan.digestFields > 0);
  assert.equal(receipt.tier, "P6", "the run never reaches a linked account");
  assert.equal(receipt.scope, RELEASE_CANDIDATE_SCOPE);
});

test("recorded verdicts are derived from the measurements, not asserted against themselves", () => {
  const built = buildReleaseCandidateReceipt(
    store({ tarball: { ...store().tarball, byteLength: TARBALL_CEILING_BYTES - 1 } }),
    current,
  ) as {
    tarball: { underCeiling: boolean; ceilingBytes: number; byteLength: number };
    version: { matchesExpected: boolean };
    crossVersion: { deterministicDigestsEqual: boolean; distinctMajorCount: number };
    nodeMatrix: readonly { distinctPids: boolean }[];
  };
  assert.equal(built.tarball.underCeiling, true);
  assert.equal(built.tarball.ceilingBytes, TARBALL_CEILING_BYTES);
  assert.equal(built.version.matchesExpected, true);
  assert.equal(built.crossVersion.distinctMajorCount, 2);
  assert.equal(built.crossVersion.deterministicDigestsEqual, true);
  assert.deepEqual(
    built.nodeMatrix.map((entry) => entry.distinctPids),
    [true, true],
  );

  const diverged = buildReleaseCandidateReceipt(
    store({
      nodeMatrix: [leg("node22", 22), leg("node24", 24, { deterministicDigest: digest("9") })],
    }),
    current,
  ) as { crossVersion: { deterministicDigestsEqual: boolean } };
  assert.equal(
    diverged.crossVersion.deterministicDigestsEqual,
    false,
    "two legs with different digests must not report equal",
  );
});

test("the writer refuses a dirty tree, a moved head, and an unfinalized run", () => {
  refuses({}, /current head does not match/u, { gitHead: gitSha("5"), treeClean: true });
  refuses({}, /worktree is dirty/u, { gitHead: gitSha("0"), treeClean: false });
  refuses({ runStart: { ...store().runStart, treeClean: false } }, /worktree is dirty/u);
  refuses({ finalizedAt: undefined }, /not finalized/u);
  refuses({ knownValues: ["only", "two"] }, /known-value negative control/u);
});

test("the writer refuses a version that is not the current alpha pre-mode candidate", () => {
  refuses({ version: { ...store().version, packageVersion: "0.2.2" } }, /is not 0\.3\.0/u);
  refuses(
    { version: { ...store().version, pendingChangesetCount: 1 } },
    /pre-mode changeset set is incomplete/u,
  );
  refuses(
    { version: { ...store().version, consumedChangesetCount: 0 } },
    /not bound to the pre-mode changesets/u,
  );
  refuses({ version: { ...store().version, changelogSectionPresent: false } }, /absent or a stub/u);
  refuses({ version: { ...store().version, changelogSectionLineCount: 1 } }, /absent or a stub/u);
  refuses({ version: { ...store().version, changesetFixedGroupCount: 1 } }, /fixed\/linked/u);
  refuses({ version: { ...store().version, changesetLinkedGroupCount: 1 } }, /fixed\/linked/u);
});

test("the writer refuses a tarball at the ceiling or carrying an unintended entry", () => {
  refuses(
    { tarball: { ...store().tarball, byteLength: TARBALL_CEILING_BYTES } },
    /at or above the ceiling/u,
  );
  refuses({ tarball: { ...store().tarball, entries: [] } }, /manifest is empty/u);
  refuses({ tarball: { ...store().tarball, unexpectedEntryCount: 1 } }, /intended file set/u);
  refuses(
    { tarball: { ...store().tarball, missingRequiredRootFileCount: 1 } },
    /intended file set/u,
  );
  refuses({ tarball: { ...store().tarball, forbiddenPatternHitCount: 1 } }, /intended file set/u);
  refuses(
    {
      tarball: {
        ...store().tarball,
        entries: [{ path: "dist/index.mjs", byteLength: 0 }],
      },
    },
    /measured zero bytes/u,
  );
});

test("the writer refuses a dist that is not this tree's build and a vacuous leak scan", () => {
  refuses(
    { distIdentity: { digests: [], packedMatchesFreshBuild: true } },
    /no packed dist digests/u,
  );
  refuses(
    { distIdentity: { ...store().distIdentity, packedMatchesFreshBuild: false } },
    /not this tree's fresh build/u,
  );
  refuses({ leakScan: { ...store().leakScan, filesScanned: 0 } }, /empty corpus/u);
  refuses({ leakScan: { ...store().leakScan, accountShapedHits: 1 } }, /account or private-path/u);
  refuses({ leakScan: { ...store().leakScan, privatePathHits: 1 } }, /account or private-path/u);
  refuses({ leakScan: { ...store().leakScan, plantedControlHits: 0 } }, /planted positive/u);
  refuses(
    { leakScan: { ...store().leakScan, plantedControlHiddenFileHits: 0 } },
    /planted positive/u,
  );
});

test("the writer refuses a Node matrix that did not observe two distinct majors", () => {
  refuses({ nodeMatrix: [leg("node22", 22)] }, /exactly two Node legs/u);
  refuses({ nodeMatrix: [leg("node22", 22), leg("node22", 22)] }, /present exactly once/u);
  refuses(
    { nodeMatrix: [leg("node22", 24), leg("node24", 24)] },
    /leg node22 observed Node 24|same Node major/u,
  );
  refuses(
    { nodeMatrix: [leg("node22", 22, { observedVersion: "v20.11.0" }), leg("node24", 24)] },
    /leg node22 reported v20\.11\.0/u,
  );
  refuses(
    { nodeMatrix: [leg("node22", 22, { readPid: 2201 }), leg("node24", 24)] },
    /reused one OS process/u,
  );
  refuses(
    { nodeMatrix: [leg("node22", 22), leg("node24", 24, { writePid: 2201 })] },
    /not distinct/u,
  );
  refuses(
    { nodeMatrix: [leg("node22", 22, { durableDigestEqual: false }), leg("node24", 24)] },
    /did not reconstruct its durable digest/u,
  );
  refuses(
    { nodeMatrix: [leg("node22", 22, { pageMessageCount: 0 }), leg("node24", 24)] },
    /paged no durable messages/u,
  );
});

test("the writer refuses a run that tagged the release or proved no absence", () => {
  refuses(
    { releaseSideEffects: { ...store().releaseSideEffects, candidateTagPresent: true } },
    /tagging is owner-held/u,
  );
  refuses(
    { releaseSideEffects: { ...store().releaseSideEffects, tagListingSawKnownTag: false } },
    /proves no absence/u,
  );
  refuses(
    { releaseSideEffects: { ...store().releaseSideEffects, candidateTag: "v9.9.9" } },
    /does not name the packaged version/u,
  );
});

test("a leg must observe the live state before its absence means anything", () => {
  for (const absent of [
    { liveConnectionObserved: false },
    { liveIdentityObserved: false },
    { livePresenceObserved: false },
  ])
    refuses(
      { nodeMatrix: [leg("node22", 22, absent), leg("node24", 24)] },
      /never observed the live state it denies/u,
    );

  for (const reconstructed of [
    { connectionPresent: true },
    { identityPresent: true },
    { presenceRestored: true },
  ])
    refuses(
      { nodeMatrix: [leg("node22", 22, reconstructed), leg("node24", 24)] },
      /reconstructed live state/u,
    );
});

test("a not_observed leg is never presented as success", () => {
  const receipt = buildReleaseCandidateReceipt(
    store({ nodeMatrix: [leg("node22", 22, { verdict: "not_observed" }), leg("node24", 24)] }),
    current,
  ) as { crossVersion: { legCount: number; deterministicDigestsEqual: boolean } };
  assert.equal(receipt.crossVersion.legCount, 1, "an unobserved leg must not count as a leg");
  assert.equal(
    receipt.crossVersion.deterministicDigestsEqual,
    false,
    "one observed leg cannot agree with a leg that never ran",
  );
});

test("a receipt missing a schema field is refused, not quietly scanned clean", () => {
  const receipt = buildReleaseCandidateReceipt(store(), current) as Record<string, unknown>;
  assert.deepEqual(missingReleaseCandidateFields(receipt), []);

  const stripped = structuredClone(receipt);
  delete (stripped.releaseSideEffects as Record<string, unknown>).candidateTagPresent;
  assert.equal(
    scanReleaseCandidateReceipt(stripped, []).schemaUnknownFields,
    0,
    "the pattern scanner is blind to an absent field, which is why the floor exists",
  );
  assert.deepEqual(missingReleaseCandidateFields(stripped), [
    "/releaseSideEffects/candidateTagPresent",
  ]);

  assert.throws(
    () =>
      buildReleaseCandidateReceipt(
        store({ leakScan: { ...store().leakScan, plantedControlHits: 0 } }),
        current,
      ),
    /planted positive/u,
  );
});

test("the embedded sanitization block must describe the receipt it sits in", () => {
  const receipt = buildReleaseCandidateReceipt(store(), current) as Record<string, unknown>;
  assertReleaseCandidateSanitizationDescribesFinalObject(receipt, [...KNOWN_VALUES]);

  const tampered = structuredClone(receipt);
  (tampered.sanitization as Record<string, unknown>).patternHits = 3;
  assert.throws(
    () => assertReleaseCandidateSanitizationDescribesFinalObject(tampered, [...KNOWN_VALUES]),
    /patternHits does not describe the final receipt/u,
  );

  const selfReferencing = structuredClone(receipt);
  (selfReferencing.sanitization as Record<string, unknown>).receiptByteLength = 10;
  assert.throws(
    () =>
      assertReleaseCandidateSanitizationDescribesFinalObject(selfReferencing, [...KNOWN_VALUES]),
    /self-reference/u,
  );
});

test("the scanner refuses unknown fields, held values, and an empty artifact", () => {
  const receipt = buildReleaseCandidateReceipt(store(), current) as Record<string, unknown>;

  const unknown = structuredClone(receipt);
  unknown.unexpected = "not-schema-owned";
  assert.equal(scanReleaseCandidateReceipt(unknown, []).schemaUnknownFields, 1);

  const invalid = structuredClone(receipt);
  (invalid.provenance as Record<string, unknown>).startedAt = "2026-02-30T00:00:00Z";
  assert.equal(scanReleaseCandidateReceipt(invalid, []).schemaInvalidFields, 1);

  const leaked = structuredClone(receipt);
  (leaked.provenance as Record<string, unknown>).command = ".proof-private/release.log";
  const leakedScan = scanReleaseCandidateReceipt(leaked, [...KNOWN_VALUES]);
  assert.ok(leakedScan.patternHits > 0, "a private path in a free-form field must be a hit");
  assert.equal(leakedScan.knownValueHits, 1, "the held value control must see its own value");

  const empty = scanReleaseCandidateReceipt({}, []);
  assert.equal(empty.nonEmpty, false);
  assert.equal(empty.floorPassed, false);
});

test("the deterministic digest excludes wall-clock account state and refuses an empty input", () => {
  const namespaces = { account: digest("a"), chats: digest("b"), messages: digest("c") };
  assert.equal(
    deterministicDigestOf(namespaces),
    deterministicDigestOf({ ...namespaces, account: digest("z") }),
    "a differing account instant must not change the cross-major comparand",
  );
  assert.notEqual(
    deterministicDigestOf(namespaces),
    deterministicDigestOf({ ...namespaces, chats: digest("z") }),
    "a differing chat digest must change the comparand",
  );
  assert.throws(() => deterministicDigestOf({}), /over no namespaces/u);
  assert.throws(() => deterministicDigestOf({ account: digest("a") }), /over no namespaces/u);
});

test("the packed corpus scan sees a planted account id and a planted private path", () => {
  const clean = scanPackedCorpus([
    { path: "dist/index.mjs", contents: `const example = "${PACKED_ALLOWLISTED_ACCOUNT_IDS[0]}";` },
    { path: "README.md", contents: "no ids here" },
  ]);
  assert.equal(clean.filesScanned, 2);
  assert.equal(clean.accountShapedHits, 0);
  assert.equal(clean.allowlistedSyntheticHits, 1, "a clean scan must still have looked at an id");
  assert.equal(clean.privatePathHits, 0);
  assert.equal(clean.hiddenFiles, 0);

  const planted = scanPackedCorpus([
    { path: "dist/index.mjs", contents: `const example = "${PACKED_ALLOWLISTED_ACCOUNT_IDS[0]}";` },
    { path: "README.md", contents: "no ids here" },
    { path: ".hidden-receipt.json", contents: PLANTED_LEAK_CANARY },
  ]);
  assert.equal(planted.hiddenFiles, 1, "the scan must count the dotfile it is asked to read");
  assert.equal(planted.accountShapedHits, 1);
  assert.equal(planted.hitsInHiddenFiles, 1, "the hit must be attributed to the hidden file");
  assert.equal(planted.privatePathHits, 1);
  assert.equal(
    planted.accountShapedHits - clean.accountShapedHits,
    1,
    "the control is the difference the plant makes, not an absolute count",
  );
});

test("every account-shaped pattern and forbidden entry pattern still matches its target", () => {
  const targets = ["15551234567@s.whatsapp.net", "100000000000000@lid", "120363042384062365@g.us"];
  assert.equal(ACCOUNT_SHAPED_SOURCE.length, targets.length);
  for (const [index, source] of ACCOUNT_SHAPED_SOURCE.entries())
    assert.equal(
      new RegExp(source, "u").test(targets[index] ?? ""),
      true,
      `account pattern ${source} is blind to ${targets[index]}`,
    );

  const forbiddenTargets = [
    "tests/packed-imports.ts",
    ".proof-receipts/issue112-p6.run1-abcdef0.json",
    ".proof-private/packed.log",
    ".changeset/config.json",
    "docs/runbooks/release.md",
    "dist/index.mjs.map",
    "scenario/whatsapp.db",
  ];
  assert.equal(FORBIDDEN_TARBALL_ENTRY_SOURCES.length, forbiddenTargets.length);
  for (const [index, source] of FORBIDDEN_TARBALL_ENTRY_SOURCES.entries()) {
    assert.equal(
      new RegExp(source, "u").test(forbiddenTargets[index] ?? ""),
      true,
      `forbidden pattern ${source} is blind to ${forbiddenTargets[index]}`,
    );
    for (const intended of INTENDED_ROOT_FILES)
      assert.equal(
        new RegExp(source, "u").test(intended),
        false,
        `forbidden pattern ${source} rejects the intended file ${intended}`,
      );
  }
});

test("every committed release-candidate receipt is sanitary and head-bound to its filename", () => {
  assert.ok(committedReceipts.length > 0, "no release-candidate receipt is committed");
  for (const name of committedReceipts) {
    const receipt = JSON.parse(readFileSync(path.join(receiptDirectory, name), "utf8")) as {
      readonly provenance: { readonly gitHead: string; readonly sourceTreeHash: string };
      readonly tier: string;
      readonly tarball: { readonly byteLength: number; readonly underCeiling: boolean };
      readonly nodeMatrix: readonly { readonly observedMajor: number }[];
    };
    const scan = scanReleaseCandidateReceipt(receipt, [...KNOWN_VALUES]);
    assert.deepEqual(
      missingReleaseCandidateFields(receipt),
      [],
      `${name} is missing schema fields; the scanner alone cannot see an absent observation`,
    );
    assert.equal(scan.schemaUnknownFields, 0, `${name} has fields outside its schema`);
    assert.equal(scan.schemaInvalidFields, 0, `${name} has schema-invalid fields`);
    assert.equal(scan.patternHits, 0, `${name} free-form fields contain a leak pattern`);
    assert.equal(scan.knownValueHits, 0, `${name} contains a held scenario value`);
    assert.equal(scan.floorPassed, true, `${name} did not pass the sanitization floor`);
    assert.equal(receipt.tier, "P6", `${name} claims a rung the run did not reach`);
    assert.ok(
      name.includes(receipt.provenance.gitHead.slice(0, 7)),
      `${name} is not named for the head it records`,
    );
    assert.ok(
      receipt.tarball.byteLength < TARBALL_CEILING_BYTES && receipt.tarball.underCeiling,
      `${name} records a tarball at or above the ceiling`,
    );
    assert.deepEqual(
      receipt.nodeMatrix.map((entry) => entry.observedMajor).sort((left, right) => left - right),
      [22, 24],
      `${name} does not carry both Node legs`,
    );
    assertReleaseCandidateSanitizationDescribesFinalObject(
      receipt as unknown as Record<string, unknown>,
      [...KNOWN_VALUES],
    );
  }
});
