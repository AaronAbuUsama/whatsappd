/**
 * The 0.3.0 release-candidate proof.
 *
 *   pnpm proof:release
 *
 * Measures the version, the packed tarball, and the packed reconstruction
 * scenario on **two Node majors**, then writes a head-bound P6 receipt.
 *
 * What this deliberately does not do:
 *
 * - It never tags and never publishes. Those are owner-held (#113). It records
 *   the local release-tag count so the receipt says which side effects were
 *   absent rather than leaving it to be assumed.
 * - It never touches a linked account. The scenario is the deterministic
 *   `whatsappd/testing` driver over a fresh libSQL file, so the tier is P6.
 *
 * Every number in the receipt is measured here at runtime. Nothing is copied
 * from a constant that the assertion then compares against itself — the defect
 * class this mission keeps finding. The one deliberate exception is the ceiling,
 * which is a policy value and is recorded beside the measurement it bounds.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  EXPECTED_VERSION,
  NODE_MATRIX_IDS,
  TARBALL_CEILING_BYTES,
  captureReleaseCandidateRunStart,
  deterministicDigestOf,
  writeReleaseCandidateReceipt,
  type DistDigest,
  type LeakScanObservation,
  type NodeLegObservation,
  type NodeMatrixId,
  type TarballEntry,
} from "./release-candidate-receipt.ts";
import {
  ACCOUNT_SHAPED_SOURCE,
  FORBIDDEN_TARBALL_ENTRY_SOURCES,
  INTENDED_ROOT_FILES,
  PLANTED_LEAK_CANARY,
  scanPackedCorpus,
  type PackedCorpusFile,
} from "./release-candidate-scan.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runStart = captureReleaseCandidateRunStart(root);

/**
 * Node binaries for the two matrix legs, discovered rather than assumed.
 *
 * `WA_NODE22` / `WA_NODE24` override the search. Each candidate is asked for
 * its own `process.version` before it is accepted, so a leg can never claim a
 * major that the binary did not report from inside its own run.
 */
const NODE_CANDIDATES: Readonly<Record<NodeMatrixId, readonly string[]>> = {
  node22: [
    ...(process.env.WA_NODE22 ? [process.env.WA_NODE22] : []),
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@22/bin/node",
    `${process.env.HOME ?? ""}/.nvm/versions/node/v22.12.0/bin/node`,
  ],
  node24: [
    ...(process.env.WA_NODE24 ? [process.env.WA_NODE24] : []),
    `${process.env.HOME ?? ""}/.nvm/versions/node/v24.18.0/bin/node`,
    "/opt/homebrew/opt/node@24/bin/node",
  ],
};

const reportedVersion = async (binary: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFile(binary, ["-p", "process.version"], {
      env: { PATH: "/usr/bin:/bin" },
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
};

const resolveLegBinary = async (
  id: NodeMatrixId,
): Promise<{ readonly binary: string; readonly version: string } | undefined> => {
  const major = Number(id.replace("node", ""));
  for (const binary of NODE_CANDIDATES[id]) {
    if (!binary) continue;
    const version = await reportedVersion(binary);
    if (version?.startsWith(`v${major}.`)) return { binary, version };
  }
  return undefined;
};

const byName = (left: string, right: string): number => left.localeCompare(right);

const sha256 = (bytes: Parameters<ReturnType<typeof createHash>["update"]>[0]): string =>
  createHash("sha256").update(bytes).digest("hex");

const filesUnder = async (directory: string, prefix = ""): Promise<readonly string[]> =>
  (
    await Promise.all(
      (
        await readdir(directory, { withFileTypes: true })
      ).map(async (entry) => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory()
          ? filesUnder(path.join(directory, entry.name), relative)
          : [relative];
      }),
    )
  ).flat();

interface PackedScenarioResult {
  readonly pid: number;
  readonly durableDigest: string;
  readonly durableDigests: Readonly<Record<string, string>>;
  readonly pageMessageCount: number;
  readonly mediaDigest: string;
  readonly connectionPresent: boolean;
  readonly identityPresent: boolean;
  readonly presenceRestored: boolean;
  readonly liveConnectionPresent: boolean;
  readonly liveIdentityPresent: boolean;
  readonly livePresenceObserved: boolean;
  readonly closeOrder: readonly string[];
  readonly envKeys: readonly string[];
  readonly nodeVersion: string;
}

const workspace = await mkdtemp(path.join(tmpdir(), "whatsappd-release-"));
try {
  // 1. Version. Read from disk, never from a constant this file also asserts.
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    readonly version: string;
  };
  const changesetEntries = await readdir(path.join(root, ".changeset"));
  const pendingChangesets = changesetEntries.filter(
    (entry) => entry.endsWith(".md") && entry.toLowerCase() !== "readme.md",
  );
  const changesetConfig = JSON.parse(
    await readFile(path.join(root, ".changeset/config.json"), "utf8"),
  ) as { readonly fixed?: readonly unknown[]; readonly linked?: readonly unknown[] };
  const prerelease = JSON.parse(await readFile(path.join(root, ".changeset/pre.json"), "utf8")) as {
    readonly mode: string;
    readonly tag: string;
    readonly initialVersions: Readonly<Record<string, string>>;
    readonly changesets: readonly string[];
  };
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const changelogLines = changelog.split("\n");
  const sectionStart = changelogLines.findIndex((line) => line === `## ${EXPECTED_VERSION}`);
  const sectionEnd = changelogLines.findIndex(
    (line, index) => index > sectionStart && sectionStart !== -1 && line.startsWith("## "),
  );
  const sectionBody = changelogLines
    .slice(sectionStart + 1, sectionEnd === -1 ? changelogLines.length : sectionEnd)
    .filter((line) => line.trim().length > 0);
  const consumedChangesetCount = prerelease.changesets.length;

  // 2. Pack, from the tree this proof is running in.
  await execFile("pnpm", ["build"], { cwd: root });
  await execFile("pnpm", ["pack", "--pack-destination", workspace], { cwd: root });
  const archive = (await readdir(workspace)).find((entry) => entry.endsWith(".tgz"));
  assert.ok(archive, "pnpm pack produced no archive");
  const archivePath = path.join(workspace, archive);
  const tarballBytes = await readFile(archivePath);
  const tarballByteLength = (await stat(archivePath)).size;
  assert.equal(tarballBytes.byteLength, tarballByteLength, "tarball size disagreed with its bytes");

  const extracted = path.join(workspace, "extracted");
  await execFile("mkdir", ["-p", extracted]);
  await execFile("tar", ["xzf", archivePath, "-C", extracted]);
  const packageRoot = path.join(extracted, "package");
  const entryPaths = [...(await filesUnder(packageRoot))].sort(byName);
  const entries: readonly TarballEntry[] = await Promise.all(
    entryPaths.map(async (entry) => ({
      path: entry,
      byteLength: (await stat(path.join(packageRoot, entry))).size,
    })),
  );
  const unexpectedEntries = entries.filter(
    (entry) => !entry.path.startsWith("dist/") && !INTENDED_ROOT_FILES.includes(entry.path),
  );
  const missingRequiredRootFiles = INTENDED_ROOT_FILES.filter(
    (required) => !entries.some((entry) => entry.path === required),
  );
  const forbiddenPatternHits = entries.filter((entry) =>
    FORBIDDEN_TARBALL_ENTRY_SOURCES.some((source) => new RegExp(source, "u").test(entry.path)),
  );

  // 3. The packed dist is this tree's fresh build. The right-hand digests are
  //    read from a directory removed a line earlier, so a build that wrote
  //    nothing throws instead of comparing two equally stale trees.
  const packedDist: readonly DistDigest[] = await Promise.all(
    entries
      .filter((entry) => entry.path.startsWith("dist/"))
      .map(async (entry) => ({
        file: entry.path,
        sha256: sha256(await readFile(path.join(packageRoot, entry.path))),
      })),
  );
  assert.ok(packedDist.length > 0, "the tarball carries no dist artifacts to digest");
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await execFile("pnpm", ["build"], { cwd: root });
  const freshDist: readonly DistDigest[] = await Promise.all(
    [...(await filesUnder(path.join(root, "dist")))].sort(byName).map(async (file) => ({
      file: `dist/${file}`,
      sha256: sha256(await readFile(path.join(root, "dist", file))),
    })),
  );
  const packedMatchesFreshBuild =
    JSON.stringify([...packedDist].sort((a, b) => a.file.localeCompare(b.file))) ===
    JSON.stringify([...freshDist].sort((a, b) => a.file.localeCompare(b.file)));

  // 4. Leak scan over the extracted tarball, plus a planted positive in a
  //    dotfile — the shape `rg` misses without `--hidden` and the shape a
  //    non-recursive listing misses entirely.
  const corpus: readonly PackedCorpusFile[] = await Promise.all(
    entryPaths.map(async (entry) => ({
      path: entry,
      contents: await readFile(path.join(packageRoot, entry), "utf8"),
    })),
  );
  const realScan = scanPackedCorpus(corpus);
  const plantedCorpus: readonly PackedCorpusFile[] = [
    ...corpus,
    { path: ".hidden-receipt.json", contents: PLANTED_LEAK_CANARY },
  ];
  const plantedScan = scanPackedCorpus(plantedCorpus);
  const leakScan: LeakScanObservation = {
    filesScanned: realScan.filesScanned,
    hiddenFilesInCorpus: realScan.hiddenFiles,
    accountShapedHits: realScan.accountShapedHits,
    allowlistedSyntheticHits: realScan.allowlistedSyntheticHits,
    privatePathHits: realScan.privatePathHits,
    plantedControlHits: plantedScan.accountShapedHits - realScan.accountShapedHits,
    plantedControlHiddenFileHits: plantedScan.hiddenFiles - realScan.hiddenFiles,
  };
  assert.ok(realScan.filesScanned > 0, "the leak scan corpus was empty");
  assert.equal(realScan.accountShapedHits, 0, "the tarball carries an unallowlisted account id");
  assert.equal(realScan.privatePathHits, 0, "the tarball names a private proof path");
  assert.ok(leakScan.plantedControlHits > 0, "the leak scan cannot see a planted account id");
  assert.ok(leakScan.plantedControlHiddenFileHits > 0, "the leak scan cannot see a hidden file");

  // 5. One fresh consumer, installed from the tarball with no workspace link,
  //    driven by both Node majors.
  const consumer = path.join(workspace, "consumer");
  await execFile("mkdir", ["-p", consumer]);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@libsql/client": "0.15.15", whatsappd: `file:${archivePath}` },
    }),
  );
  await execFile("pnpm", ["install", "--ignore-scripts"], { cwd: consumer });
  const resolved = await readFile(
    path.join(consumer, "node_modules/whatsappd/package.json"),
    "utf8",
  );
  assert.equal(
    (JSON.parse(resolved) as { readonly version: string }).version,
    packageJson.version,
    "the consumer installed a different version than this tree packed",
  );
  await writeFile(
    path.join(consumer, "packed-consumer-scenario.mjs"),
    await readFile(path.join(root, "tests/packed-consumer-scenario.mjs")),
  );
  // The scenario reports its own runtime, so a leg's Node major comes out of
  // the child rather than out of the binary path this file chose.
  await writeFile(
    path.join(consumer, "run-leg.mjs"),
    `import { execFileSync } from "node:child_process";
const receipt = execFileSync(process.execPath, ["packed-consumer-scenario.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...(process.env.HOME && { HOME: process.env.HOME }),
    ...(process.env.PATH && { PATH: process.env.PATH }),
    ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
    PACKED_SCENARIO_DIRECTORY: process.env.LEG_DIRECTORY,
    PACKED_SCENARIO_MODE: process.env.LEG_MODE,
    PACKED_SCENARIO_SALT: process.env.LEG_SALT,
  },
});
process.stdout.write(JSON.stringify({ ...JSON.parse(receipt), nodeVersion: process.version }));
`,
  );

  const runLeg = async (
    binary: string,
    directory: string,
    mode: "write" | "read",
    salt: string,
  ): Promise<PackedScenarioResult> => {
    const { stdout, stderr } = await execFile(binary, ["run-leg.mjs"], {
      cwd: consumer,
      env: {
        ...(process.env.HOME && { HOME: process.env.HOME }),
        ...(process.env.PATH && { PATH: process.env.PATH }),
        ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
        LEG_DIRECTORY: directory,
        LEG_MODE: mode,
        LEG_SALT: salt,
      },
    });
    assert.equal(stderr, "", `the ${mode} child wrote diagnostics`);
    return JSON.parse(stdout) as PackedScenarioResult;
  };

  // One salt for both legs: the scenario's digest is salted, so a shared salt
  // is what makes the two majors comparable at all. It is a constant of the
  // comparison, not of the thing being compared.
  const salt = sha256(runStart.gitHead).slice(0, 32);
  const nodeMatrix: NodeLegObservation[] = [];
  for (const id of NODE_MATRIX_IDS) {
    const resolvedBinary = await resolveLegBinary(id);
    if (!resolvedBinary) {
      throw new Error(
        `no Node binary reporting ${id.replace("node", "v")} was found; set WA_${id.toUpperCase()}`,
      );
    }
    const directory = path.join(workspace, `scenario-${id}`);
    const write = await runLeg(resolvedBinary.binary, directory, "write", salt);
    const read = await runLeg(resolvedBinary.binary, directory, "read", salt);
    assert.equal(
      write.nodeVersion,
      read.nodeVersion,
      `leg ${id} ran its two children on different Node versions`,
    );
    assert.equal(
      write.nodeVersion,
      resolvedBinary.version,
      `leg ${id} reported a different version from inside the run than the binary did`,
    );
    assert.deepEqual(write.closeOrder, ["client", "runtime", "backend"]);
    assert.deepEqual(read.closeOrder, ["client", "runtime", "backend"]);
    nodeMatrix.push({
      id,
      verdict: "observed",
      observedVersion: read.nodeVersion,
      observedMajor: Number(read.nodeVersion.slice(1).split(".")[0]),
      writePid: write.pid,
      readPid: read.pid,
      durableDigestEqual: write.durableDigest === read.durableDigest,
      deterministicDigest: deterministicDigestOf(read.durableDigests),
      pageMessageCount: read.pageMessageCount,
      mediaDigest: read.mediaDigest,
      liveConnectionObserved: write.liveConnectionPresent,
      liveIdentityObserved: write.liveIdentityPresent,
      livePresenceObserved: write.livePresenceObserved,
      connectionPresent: read.connectionPresent,
      identityPresent: read.identityPresent,
      presenceRestored: read.presenceRestored,
    });
  }

  // 6. The side effects this feature must NOT have produced. The listing is
  //    proved able to see a tag — by finding the already-released one — before
  //    the absence of the candidate tag is allowed to mean anything.
  const localReleaseTags = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const candidateTag = `v${packageJson.version}`;
  const tagExists = (tag: string): boolean =>
    execFileSync("git", ["tag", "--list", tag], { cwd: root, encoding: "utf8" }).trim() === tag;
  // The same targeted query the candidate is asked through, aimed at a tag this
  // repository already has. If that returns nothing, the query is broken and the
  // candidate's absence would be an artifact of the tool, not a fact.
  const knownTag = localReleaseTags.find((tag) => tag !== candidateTag);
  const tagListingSawKnownTag = knownTag !== undefined && tagExists(knownTag);

  const { file, scan } = writeReleaseCandidateReceipt(root, {
    runStart,
    finalizedAt: new Date().toISOString(),
    knownValues: ["Packed consumer", "Packed room", "packed.bin", ".proof-private"],
    version: {
      packageVersion: packageJson.version,
      pendingChangesetCount: pendingChangesets.length,
      consumedChangesetCount,
      changesetMode: prerelease.mode,
      prereleaseTag: prerelease.tag,
      initialVersion: prerelease.initialVersions.whatsappd ?? "",
      changelogSectionPresent: sectionStart !== -1,
      changelogSectionLineCount: sectionBody.length,
      changesetFixedGroupCount: changesetConfig.fixed?.length ?? 0,
      changesetLinkedGroupCount: changesetConfig.linked?.length ?? 0,
    },
    tarball: {
      byteLength: tarballByteLength,
      sha256: sha256(tarballBytes),
      entries,
      unexpectedEntryCount: unexpectedEntries.length,
      missingRequiredRootFileCount: missingRequiredRootFiles.length,
      forbiddenPatternHitCount: forbiddenPatternHits.length,
    },
    distIdentity: { digests: packedDist, packedMatchesFreshBuild },
    leakScan,
    nodeMatrix,
    releaseSideEffects: {
      localReleaseTagCount: localReleaseTags.length,
      candidateTag,
      candidateTagPresent: tagExists(candidateTag),
      tagListingSawKnownTag,
    },
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        receipt: path.relative(root, file),
        version: packageJson.version,
        tarballByteLength,
        ceilingBytes: TARBALL_CEILING_BYTES,
        nodeVersions: nodeMatrix.map((leg) => leg.observedVersion),
        accountShapedSourcePatternCount: ACCOUNT_SHAPED_SOURCE.length,
        scan,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
