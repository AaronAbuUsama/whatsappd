/**
 * The 0.3.0 final-gates proof.
 *
 *   pnpm proof:final-gates
 *
 * The last gate of the 0.3.0 mission. It asserts what this mission must *not*
 * have done — tagged, published, pushed, or moved the release trigger — and
 * re-asserts every regression floor, the executed test plan, artifact safety,
 * and the review history, at the exact head it runs on.
 *
 * It never tags, never publishes, never pushes, and never opens a WhatsApp
 * connection. The linked profiles are read through a copy; the originals are
 * never opened for writing.
 *
 * **Every absence here is paired with a control that proves the query works.**
 * A tag query that returns nothing because git changed its flags looks exactly
 * like a tag that is not there, so each absence is asked twice: once for the
 * candidate and once for something this repository is known to have.
 *
 * `npm view` is deliberately not the registry oracle. It fails on this
 * repository with `EBADDEVENGINES` — for versions that *do* exist — and it
 * exits 0 through a pipe. Both exit codes are recorded as the false-green they
 * are, and the registry is asked over HTTP instead.
 */
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CANDIDATE_VERSION,
  ROUND_CEILING,
  captureFinalGatesRunStart,
  writeFinalGatesReceipt,
  type CoverageFileDrop,
  type ProfileObservation,
  type PullRequestObservation,
  type RedProbeObservation,
  type TrapObservation,
  type Verdict,
} from "./final-gates-receipt.ts";
import { compareCoverage } from "./coverage-comparison.ts";
import { parseLedgerRounds } from "./ledger-rounds.ts";
import {
  CHILD_ENV_ALLOWLIST,
  childEnvironment,
  forbiddenChildEnvironmentLeaks,
} from "./child-environment.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runStart = captureFinalGatesRunStart(root);

const log = (message: string): void => {
  process.stderr.write(`final-gates: ${message}\n`);
};

/**
 * The planted positive for the `--hidden` control.
 *
 * Taken from the repository's checked-in known-synthetic set rather than being
 * a new literal: this file is scanned by `tests/account-fixture-scan.ts`, and
 * inventing a fresh account-shaped value here would either fail that gate or
 * push a value into the allowlist for no reason. Written as one literal — a
 * value split so the scanner stops matching it is the exact edit that would let
 * a real id survive every check in this mission.
 */
const HIDDEN_CONTROL_JID = "15551234567@s.whatsapp.net";

interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a command and return its exit code with its output.
 *
 * Never a pipe: a pipe reports the exit code of the last stage, which is the
 * false-green shape this mission is built around. The output is captured and
 * filtered in-process instead.
 *
 * Never `process.env` either — see `CHILD_ENV_ALLOWLIST`.
 */
const run = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RunOutcome> => {
  try {
    const { stdout, stderr } = await execFile(command, [...args], {
      cwd: options.cwd ?? root,
      env: options.env ?? childEnvironment(process.env),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const gitOut = (args: readonly string[], cwd = root): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

const COVERAGE_ARGS = [
  "--experimental-strip-types",
  "--experimental-test-module-mocks",
  "--experimental-test-coverage",
  "--test-coverage-exclude=tests/**",
] as const;

const workspace = await mkdtemp(path.join(tmpdir(), "whatsappd-final-gates-"));
const baseWorktree = path.join(workspace, "base");

try {
  // ---------------------------------------------------------------- publication
  log("publication side effects");
  const candidateTag = `v${CANDIDATE_VERSION}`;
  const localTags = gitOut(["tag", "--list", "v*"]).split("\n").filter(Boolean);
  const knownTag = localTags.find((tag) => tag !== candidateTag);
  const tagPresent = (tag: string): boolean => gitOut(["tag", "--list", tag]) === tag;

  const remoteTags = await run("git", ["ls-remote", "--tags", "origin"]);
  const remoteTagRefs = remoteTags.stdout
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .filter(Boolean);
  const remoteTagVerdict: Verdict = remoteTags.code === 0 ? "observed" : "not_observed";
  if (remoteTagVerdict === "not_observed")
    log("remote tag listing unavailable; recording not_observed");

  const remoteHeads = await run("git", ["ls-remote", "--heads", "origin"]);
  const remoteBranches = remoteHeads.stdout
    .split("\n")
    .map((line) => (line.split("\t")[1] ?? "").replace("refs/heads/", ""))
    .filter(Boolean);
  const remoteBranchVerdict: Verdict = remoteHeads.code === 0 ? "observed" : "not_observed";
  const currentBranch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);

  // The registry, asked over HTTP. A 404 only means something because the
  // control returns 200 through the identical code path.
  const registryStatus = async (version: string): Promise<number> => {
    const response = await fetch(`https://registry.npmjs.org/whatsappd/${version}`);
    return response.status;
  };
  let registryCandidateStatus = -1;
  let registryControlStatus = -1;
  let registryVersionCount = 0;
  let candidateInPackument = true;
  let registryVerdict: Verdict = "not_observed";
  try {
    registryCandidateStatus = await registryStatus(CANDIDATE_VERSION);
    registryControlStatus = await registryStatus("0.2.2");
    const packument = (await (await fetch("https://registry.npmjs.org/whatsappd")).json()) as {
      readonly versions: Record<string, unknown>;
    };
    registryVersionCount = Object.keys(packument.versions).length;
    candidateInPackument = Object.hasOwn(packument.versions, CANDIDATE_VERSION);
    registryVerdict = "observed";
  } catch (error) {
    log(`registry unreachable, recording not_observed: ${String(error)}`);
  }

  // Recorded as the false green it is, not used as the oracle.
  const npmViewDirect = await run("npm", ["view", `whatsappd@${CANDIDATE_VERSION}`, "version"]);
  const npmViewControl = await run("npm", ["view", "whatsappd@0.2.2", "version"]);
  const npmViewPiped = await run("sh", [
    "-c",
    `npm view whatsappd@${CANDIDATE_VERSION} version 2>/dev/null | tail -1`,
  ]);

  const workflow = ".github/workflows/release.yml";
  const workflowDiff = await run("git", ["diff", "origin/master", "--", workflow]);
  // The same diff invocation, aimed at a file this branch is known to have
  // changed. If it comes back empty the query is broken and the workflow's
  // clean diff would be an artifact of the tool.
  const workflowDiffControl = await run("git", ["diff", "origin/master", "--", "package.json"]);

  let releaseRunsOnCandidateBranch = 0;
  let releaseRunQuerySawAKnownRun = false;
  let releaseRunVerdict: Verdict = "not_observed";
  const releaseRuns = await run("gh", [
    "run",
    "list",
    "--workflow=release.yml",
    "--limit",
    "100",
    "--json",
    "headBranch,databaseId",
  ]);
  if (releaseRuns.code === 0) {
    const runs = JSON.parse(releaseRuns.stdout) as readonly { readonly headBranch: string }[];
    releaseRunsOnCandidateBranch = runs.filter(
      (entry) => entry.headBranch === currentBranch,
    ).length;
    releaseRunQuerySawAKnownRun = runs.length > 0;
    releaseRunVerdict = "observed";
  } else {
    log("gh unavailable for workflow runs; recording not_observed");
  }

  // ------------------------------------------------------------------ coverage
  log("per-file coverage, base and head in this session");
  const baseRef = "origin/master";
  const baseSha = gitOut(["rev-parse", baseRef]);
  await run("git", ["worktree", "add", "--detach", baseWorktree, baseRef]);
  // Copied, never symlinked: a symlinked node_modules resolves back into this
  // checkout and the base leg would measure head's sources.
  await run("cp", ["-R", path.join(root, "node_modules"), path.join(baseWorktree, "node_modules")]);

  const baseLcov = path.join(workspace, "base.lcov");
  const headLcov = path.join(workspace, "head.lcov");
  const measure = async (cwd: string, destination: string): Promise<number> => {
    const outcome = await run(
      process.execPath,
      [
        ...COVERAGE_ARGS,
        "--test-reporter=lcov",
        `--test-reporter-destination=${destination}`,
        "--test",
        "tests/*.test.ts",
      ],
      { cwd },
    );
    return outcome.code;
  };
  await measure(baseWorktree, baseLcov);
  await measure(root, headLcov);

  const comparison = compareCoverage(
    readFileSync(baseLcov, "utf8"),
    readFileSync(headLcov, "utf8"),
  );
  const regressions: readonly CoverageFileDrop[] = comparison.regressions.map((entry) => ({
    path: entry.path,
    metric: entry.metric,
    baseHundredths: entry.baseHundredths,
    headHundredths: entry.headHundredths,
    baseUncovered: entry.baseUncovered,
    headUncovered: entry.headUncovered,
  }));
  const regressedFileCount = new Set(regressions.map((entry) => entry.path)).size;

  // The configured gate, and the same gate with the line floor raised above the
  // measured value. A floor that cannot fail is not a floor.
  const realGate = await run(process.execPath, [
    ...COVERAGE_ARGS,
    "--test-coverage-lines=94",
    "--test-coverage-branches=85",
    "--test-coverage-functions=88",
    "--test",
    "tests/*.test.ts",
  ]);
  // Node **truncates** a fractional coverage threshold: `--test-coverage-lines=96.74`
  // is enforced as 96, and the suite's 96.24 clears it. Measured, not assumed —
  // a floor computed as "measured + 0.5" therefore exits 0 and would have
  // certified the gate inert. The raised floor must be the next whole integer
  // above the measured value.
  const raisedFloorHundredths = Math.min(
    10_000,
    (Math.floor(comparison.aggregateHead.lines / 100) + 1) * 100,
  );
  const raisedFloor = await run(process.execPath, [
    ...COVERAGE_ARGS,
    `--test-coverage-lines=${raisedFloorHundredths / 100}`,
    "--test-coverage-branches=85",
    "--test-coverage-functions=88",
    "--test",
    "tests/*.test.ts",
  ]);

  const baseText = readFileSync(baseLcov, "utf8");
  const headText = readFileSync(headLcov, "utf8");
  const selfTestBaseVsBase = compareCoverage(baseText, baseText).regressions.length;
  const selfTestInverted = compareCoverage(headText, baseText).regressions.length;
  let selfTestEmptyCorpusRefused = false;
  try {
    compareCoverage("", "");
  } catch {
    selfTestEmptyCorpusRefused = true;
  }

  // --------------------------------------------------------------------- suite
  log("executed suite");
  const report = await run("pnpm", ["test:report"]);
  const tap = readFileSync(path.join(root, "test-results.tap"), "utf8");
  const tapNumber = (label: string): number =>
    Number(new RegExp(`^# ${label} (\\d+)$`, "mu").exec(tap)?.[1] ?? -1);
  const planMatch = /^1\.\.(\d+)$/mu.exec(tap);

  const testFiles = execFileSync("find", ["tests", "-name", "*.test.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
  let perFileTotal = 0;
  let perFileZeroCount = 0;
  for (const file of testFiles) {
    const outcome = await run(process.execPath, [
      "--experimental-strip-types",
      "--experimental-test-module-mocks",
      "--test-reporter=tap",
      "--test",
      file,
    ]);
    const count = Number(/^# tests (\d+)$/mu.exec(outcome.stdout)?.[1] ?? 0);
    perFileTotal += count;
    if (count === 0) perFileZeroCount++;
  }

  // --------------------------------------------------------------------- traps
  log("verified traps");
  const emptyGlob = await run(process.execPath, ["--test", "nope/*.test.ts"]);
  const emptyGlobCoverage = await run(process.execPath, [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-lines=94",
    "nope/*.test.ts",
  ]);
  const flatGlobCount = readdirSync(path.join(root, "tests")).filter((name) =>
    name.endsWith(".test.ts"),
  ).length;

  const traps: readonly TrapObservation[] = [
    {
      id: "empty-glob-exits-zero-with-no-tests",
      // `node --test` over a glob that matches nothing exits 0 and reports
      // `tests 0`. A gate that only reads the exit code passes for ever.
      verdict:
        emptyGlob.code === 0 &&
        Number(/^.?.?\btests (\d+)$/mu.exec(emptyGlob.stdout)?.[1] ?? -1) === 0 &&
        !/^1\.\.\d+$/mu.test(emptyGlob.stdout)
          ? "observed"
          : "failed",
      exitCode: emptyGlob.code,
      observedCount: 0,
      controlCount: perFileTotal,
    },
    {
      id: "empty-glob-still-exits-zero-under-coverage-floor",
      // 100% of nothing clears every floor, so a coverage threshold does not
      // rescue the trap above.
      verdict: emptyGlobCoverage.code === 0 ? "observed" : "failed",
      exitCode: emptyGlobCoverage.code,
      observedCount: 0,
      controlCount: 94,
    },
    {
      id: "suite-glob-is-non-recursive",
      // `tests/*.test.ts` cannot see `tests/sub/x.test.ts`. Today the tree is
      // flat, so the numbers agree — this records that the blind spot is a
      // property of the tree, not of the glob.
      verdict: flatGlobCount <= testFiles.length ? "observed" : "failed",
      exitCode: 0,
      observedCount: flatGlobCount,
      controlCount: testFiles.length,
    },
  ];

  // ---------------------------------------------------------------- red probes
  log("deliberate failures");
  const probeDirectory = path.join(workspace, "red-probes");
  mkdirSync(probeDirectory, { recursive: true });
  writeFileSync(
    path.join(probeDirectory, "failing.test.ts"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("planted failure", () => assert.equal(1, 2));\n',
  );
  writeFileSync(
    path.join(probeDirectory, "passing.test.ts"),
    'import test from "node:test";\ntest("planted pass", () => {});\n',
  );
  const suiteGreen = await run(process.execPath, [
    "--experimental-strip-types",
    "--test",
    path.join(probeDirectory, "passing.test.ts"),
  ]);
  const suiteRed = await run(process.execPath, [
    "--experimental-strip-types",
    "--test",
    path.join(probeDirectory, "failing.test.ts"),
  ]);

  // The child-environment control, run through the same planted failure the
  // probe above uses. A child handed NODE_TEST_CONTEXT skips its work and
  // exits 0; the same child under the constructed allowlist exits non-zero.
  // Both legs are measured here rather than asserted, because the exact
  // behaviour is a Node version's, not this repository's.
  const failingProbe = path.join(probeDirectory, "failing.test.ts");
  const contaminatedChild = await run(
    process.execPath,
    ["--experimental-strip-types", "--test", failingProbe],
    { env: { ...childEnvironment(process.env), NODE_TEST_CONTEXT: "child-v8" } },
  );
  const cleanChild = await run(
    process.execPath,
    ["--experimental-strip-types", "--test", failingProbe],
    { env: childEnvironment({ ...process.env, NODE_TEST_CONTEXT: "child-v8" }) },
  );
  // The parent really does carry the variable while the two legs above run, so
  // the allowlist is excluding something that is actually there.
  const parentEnvironmentUnderTest = { ...process.env, NODE_TEST_CONTEXT: "child-v8" };
  const constructedChildEnvironment = childEnvironment(parentEnvironmentUnderTest);

  const redProbes: readonly RedProbeObservation[] = [
    {
      id: "inherited-node-test-context-makes-a-red-child-green",
      // Green leg and red leg are inverted from the others on purpose: what is
      // being proved is that the *contaminated* child is the false green.
      verdict: contaminatedChild.code === 0 && cleanChild.code !== 0 ? "observed" : "failed",
      greenExit: contaminatedChild.code,
      redExit: cleanChild.code,
    },
    {
      id: "coverage-gate-at-a-raised-floor",
      verdict: realGate.code === 0 && raisedFloor.code !== 0 ? "observed" : "failed",
      greenExit: realGate.code,
      redExit: raisedFloor.code,
    },
    {
      id: "test-runner-reports-a-planted-failure",
      verdict: suiteGreen.code === 0 && suiteRed.code !== 0 ? "observed" : "failed",
      greenExit: suiteGreen.code,
      redExit: suiteRed.code,
    },
    {
      id: "coverage-comparator-has-direction",
      verdict: selfTestBaseVsBase === 0 && selfTestInverted > 0 ? "observed" : "failed",
      greenExit: selfTestBaseVsBase,
      redExit: selfTestInverted,
    },
    {
      id: "coverage-comparator-refuses-an-empty-corpus",
      verdict: selfTestEmptyCorpusRefused ? "observed" : "failed",
      greenExit: 0,
      redExit: selfTestEmptyCorpusRefused ? 1 : 0,
    },
  ];

  // ------------------------------------------------------------- static gates
  log("static gates");
  const check = await run("pnpm", ["check"]);
  const checkDocs = await run("pnpm", ["check:docs"]);
  const checkDupes = await run("pnpm", ["check:dupes"]);
  const checkUnused = await run("pnpm", ["check:unused"]);
  const proofPack = await run("pnpm", ["proof:pack"]);
  const dupeReport = `${checkDupes.stdout}\n${checkDupes.stderr}`;
  const duplicationPercent = Number(/(\d+(?:\.\d+)?)%\)/u.exec(dupeReport)?.[1] ?? -1);
  const cloneCount = Number(/Found (\d+) clones?\./u.exec(dupeReport)?.[1] ?? 0);

  // -------------------------------------------------------------------- safety
  log("artifact safety");
  const ACCOUNT_SHAPED = String.raw`[0-9]{7,}@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)`;
  const scanArgs = (cwd: string): readonly string[] => [
    "--hidden",
    "--no-ignore-vcs",
    "-o",
    ACCOUNT_SHAPED,
    "-g",
    "!node_modules",
    "-g",
    "!.git",
    "-g",
    "!dist",
    "-g",
    "!.proof-private",
    cwd,
  ];
  const matchValues = (output: string): ReadonlySet<string> =>
    new Set(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(line.lastIndexOf(":") + 1)),
    );
  const headScan = await run("rg", scanArgs(root));
  const baseScan = await run("rg", scanArgs(baseWorktree));
  const headValues = matchValues(headScan.stdout);
  const baseValues = matchValues(baseScan.stdout);
  const newValues = [...headValues].filter((value) => !baseValues.has(value));
  const knownSynthetic = readFileSync(path.join(root, "tests/account-fixture-scan.ts"), "utf8");
  const newValuesAllKnownSynthetic = newValues.every((value) => knownSynthetic.includes(value));

  // `rg` skips dotfiles unless told otherwise, so the flag the real scan relies
  // on is proved load-bearing by observing 0 without it and 1 with it.
  const hiddenControl = path.join(workspace, "hidden-control");
  mkdirSync(hiddenControl, { recursive: true });
  writeFileSync(
    path.join(hiddenControl, ".hidden-receipt.json"),
    `{"jid":"${HIDDEN_CONTROL_JID}"}\n`,
  );
  writeFileSync(path.join(hiddenControl, "visible.json"), '{"note":"clean"}\n');
  const withoutHidden = await run("rg", ["-o", ACCOUNT_SHAPED, hiddenControl]);
  const withHidden = await run("rg", ["--hidden", "-o", ACCOUNT_SHAPED, hiddenControl]);
  const countLines = (value: string): number => value.split("\n").filter(Boolean).length;

  const corpusFileCount = countLines((await run("git", ["ls-files"])).stdout);
  const proofPrivateTracked = countLines((await run("git", ["ls-files", ".proof-private"])).stdout);
  const proofPrivateIgnored = (await run("git", ["check-ignore", ".proof-private"])).code === 0;
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"]);
  const statusHitCount = status.stdout
    .split("\n")
    .filter((line) => line.includes(".proof-private")).length;
  const controlTrackedPathFileCount = countLines(
    (await run("git", ["ls-files", ".proof-receipts"])).stdout,
  );

  const profiles: ProfileObservation[] = [];
  for (const id of ["android", "ios"] as const) {
    const directory = path.join(root, ".proof-private", id);
    const database = path.join(directory, "whatsapp.db");
    let observation: ProfileObservation = {
      id,
      verdict: "not_observed",
      directoryInode: 0,
      databaseInode: 0,
      databaseByteLength: 0,
      fileCount: 0,
      credentialRowCount: 0,
      hasIdentity: false,
      hasAccount: false,
      hasNoiseKey: false,
    };
    try {
      const directoryStat = statSync(directory);
      const databaseStat = statSync(database);
      // Read through a copy. The linked profiles are never opened for writing,
      // and a WAL database cannot be opened read-only in place without one.
      const copy = path.join(workspace, `${id}.db`);
      copyFileSync(database, copy);
      const query = await run("sqlite3", [
        copy,
        "select count(*), " +
          "max(json_extract(value,'$.me.id') is not null), " +
          "max(json_extract(value,'$.account') is not null), " +
          "max(json_extract(value,'$.noiseKey') is not null) " +
          "from wa_auth where key='creds';",
      ]);
      rmSync(copy, { force: true });
      const [rows, identity, account, noise] = query.stdout.trim().split("|");
      const fileCount = countLines((await run("find", [directory, "-type", "f"])).stdout);
      observation = {
        id,
        verdict: query.code === 0 ? "observed" : "failed",
        directoryInode: directoryStat.ino,
        databaseInode: databaseStat.ino,
        databaseByteLength: databaseStat.size,
        fileCount,
        credentialRowCount: Number(rows ?? 0),
        hasIdentity: identity === "1",
        hasAccount: account === "1",
        hasNoiseKey: noise === "1",
      };
    } catch (error) {
      log(`profile ${id} unreadable, recording not_observed: ${String(error)}`);
    }
    profiles.push(observation);
  }

  // ------------------------------------------------------------------- process
  log("process integrity");
  const MISSION_PULL_REQUESTS = [116, 120, 125, 128, 129, 131, 147] as const;
  const ledgerText = readFileSync(path.join(root, "docs/client-stack-defect-ledger.md"), "utf8");

  interface PullRequestFacts {
    readonly verdict: Verdict;
    readonly headCommit: string;
    readonly headClaimPresent: boolean;
    readonly headClaimMatchesACommit: boolean;
    readonly commitCount: number;
    readonly reviewCount: number;
    readonly commentCount: number;
    readonly distinctCommentAuthorCount: number;
  }
  const facts = new Map<number, PullRequestFacts>();
  const commitsByPullRequest = new Map<number, readonly string[]>();
  for (const number of MISSION_PULL_REQUESTS) {
    const view = await run("gh", [
      "pr",
      "view",
      String(number),
      "--json",
      "body,commits,reviews,comments",
    ]);
    if (view.code !== 0) {
      facts.set(number, {
        verdict: "not_observed",
        headCommit: "",
        headClaimPresent: false,
        headClaimMatchesACommit: false,
        commitCount: 0,
        reviewCount: 0,
        commentCount: 0,
        distinctCommentAuthorCount: 0,
      });
      commitsByPullRequest.set(number, []);
      continue;
    }
    const data = JSON.parse(view.stdout) as {
      readonly body: string;
      readonly commits: readonly { readonly oid: string }[];
      readonly reviews: readonly { readonly author: { readonly login: string } }[];
      readonly comments: readonly { readonly author: { readonly login: string } }[];
    };
    const shas = data.commits.map((commit) => commit.oid);
    const claimed = [...data.body.matchAll(/`([0-9a-f]{7,40})`/gu)].map((match) => match[1] ?? "");
    const headClaimMatchesACommit = claimed.some((claim) =>
      shas.some((sha) => sha.startsWith(claim) || claim.startsWith(sha.slice(0, 7))),
    );
    commitsByPullRequest.set(number, shas);
    facts.set(number, {
      verdict: "observed",
      headCommit: (shas.at(-1) ?? "").slice(0, 7),
      headClaimPresent: claimed.length > 0,
      headClaimMatchesACommit,
      commitCount: shas.length,
      reviewCount: data.reviews.length,
      commentCount: data.comments.length,
      distinctCommentAuthorCount: new Set(data.comments.map((c) => c.author.login)).size,
    });
  }

  // The ceiling is a per-PR rule, so rounds are attributed to the PR whose
  // commits they name rather than maximized over the whole document.
  const rounds = parseLedgerRounds(ledgerText, commitsByPullRequest, ROUND_CEILING);
  const roundsFor = new Map(rounds.pullRequests.map((entry) => [entry.number, entry]));
  const pullRequests: PullRequestObservation[] = MISSION_PULL_REQUESTS.map((number) => {
    const fact = facts.get(number)!;
    const round = roundsFor.get(number)!;
    return {
      number,
      ...fact,
      roundsAttributed: round.roundsAttributed,
      highestRoundNumber: round.highestRoundNumber,
      counterRestartsAtOne: round.counterRestartsAtOne,
      withinCeiling: round.withinCeiling,
      replanRequired: round.replanRequired,
      replanRecorded: round.replanRecorded,
    };
  });

  const maxRoundsRecorded = rounds.headings.reduce(
    (highest, { round }) => Math.max(highest, round),
    0,
  );
  // The grader's independence is asserted in prose by the ledger and confirmed
  // by the owner; no API field records it, so this is `not_observed` as a
  // machine fact rather than a green box.
  const independentGraderVerdict: Verdict = "not_observed";

  // ------------------------------------------------------------------- receipt
  const { file, scan, verdict } = writeFinalGatesReceipt(root, {
    runStart,
    finalizedAt: new Date().toISOString(),
    // The known-value negative control: values this run actually held in
    // memory and which must not reach the artifact. Every account-shaped
    // string the leak scan matched goes in here, so a receipt that quoted one
    // back — in a path, a message, or a diff excerpt — is refused in a shape no
    // pattern had to anticipate.
    knownValues: [...new Set([...headValues, HIDDEN_CONTROL_JID, ".proof-private"])],
    publication: {
      candidateTag,
      candidateTagPresentLocal: tagPresent(candidateTag),
      tagQuerySawKnownTag: knownTag !== undefined && tagPresent(knownTag),
      candidateTagPresentRemote: remoteTagRefs.includes(`refs/tags/${candidateTag}`),
      remoteTagQuerySawKnownTag: remoteTagRefs.length > 0,
      remoteTagVerdict,
      registryCandidateStatus,
      registryControlStatus,
      registryVersionCount,
      candidateInPackument,
      registryVerdict,
      npmViewDirectExit: npmViewDirect.code,
      npmViewPipedExit: npmViewPiped.code,
      npmViewControlDirectExit: npmViewControl.code,
      releaseWorkflowDiffLineCount: workflowDiff.stdout.split("\n").filter(Boolean).length,
      workflowDiffQuerySawAKnownDifference:
        workflowDiffControl.stdout.split("\n").filter(Boolean).length > 0,
      releaseRunsOnCandidateBranch,
      releaseRunQuerySawAKnownRun,
      releaseRunVerdict,
      candidateBranchPresentOnRemote: remoteBranches.includes(currentBranch),
      remoteBranchQuerySawKnownBranch: remoteBranches.includes("master"),
      remoteBranchVerdict,
    },
    coverage: {
      baseRef,
      baseSha,
      headSha: runStart.gitHead,
      measuredInOneSession: true,
      baseFileCount: comparison.baseFileCount,
      headFileCount: comparison.headFileCount,
      comparedFileCount: comparison.comparedFileCount,
      newAtHeadCount: comparison.newAtHead.length,
      removedAtHeadCount: comparison.removedAtHead.length,
      aggregateHeadLinesHundredths: comparison.aggregateHead.lines,
      aggregateHeadBranchesHundredths: comparison.aggregateHead.branches,
      aggregateHeadFunctionsHundredths: comparison.aggregateHead.functions,
      aggregateBaseLinesHundredths: comparison.aggregateBase.lines,
      aggregateBaseBranchesHundredths: comparison.aggregateBase.branches,
      aggregateBaseFunctionsHundredths: comparison.aggregateBase.functions,
      aggregateMeetsFloor: realGate.code === 0,
      regressedFileCount,
      regressions,
      denominatorOnlyFileCount: comparison.denominatorOnly.length,
      realGateExit: realGate.code,
      raisedFloorHundredths,
      raisedFloorExit: raisedFloor.code,
      selfTestBaseVsBaseRegressions: selfTestBaseVsBase,
      selfTestInvertedRegressions: selfTestInverted,
      selfTestEmptyCorpusRefused,
      verdict: regressedFileCount > 0 ? "failed" : "observed",
    },
    suite: {
      planPresent: planMatch !== null,
      planCount: Number(planMatch?.[1] ?? 0),
      testsCount: tapNumber("tests"),
      passCount: tapNumber("pass"),
      failCount: tapNumber("fail"),
      skippedCount: tapNumber("skipped"),
      todoCount: tapNumber("todo"),
      onDiskTestFileCount: testFiles.length,
      perFileTotal,
      perFileZeroCount,
      perFileTotalEqualsPlan: perFileTotal === Number(planMatch?.[1] ?? -1),
      verdict: report.code === 0 ? "observed" : "failed",
    },
    traps,
    redProbes,
    staticGates: {
      check: check.code,
      checkDocs: checkDocs.code,
      checkDupes: checkDupes.code,
      checkUnused: checkUnused.code,
      proofPack: proofPack.code,
    },
    duplicationHundredthsOfPercent: Math.round(duplicationPercent * 100),
    duplicationCeilingHundredthsOfPercent: 30,
    cloneCount,
    leakScan: {
      corpusFileCount,
      baseMatchValueCount: baseValues.size,
      headMatchValueCount: headValues.size,
      newValueCount: newValues.length,
      newValuesAllKnownSynthetic,
      hiddenFlagWithoutHits: countLines(withoutHidden.stdout),
      hiddenFlagWithHits: countLines(withHidden.stdout),
    },
    childEnvironment: {
      allowlistedKeyCount: CHILD_ENV_ALLOWLIST.length,
      parentKeyCount: Object.keys(parentEnvironmentUnderTest).length,
      childKeyCount: Object.keys(constructedChildEnvironment).length,
      forbiddenLeakCount: forbiddenChildEnvironmentLeaks(constructedChildEnvironment).length,
      parentCarriedNodeTestContext: parentEnvironmentUnderTest.NODE_TEST_CONTEXT !== undefined,
      childCarriedNodeTestContext: constructedChildEnvironment.NODE_TEST_CONTEXT !== undefined,
      contaminatedChildExit: contaminatedChild.code,
      cleanChildExit: cleanChild.code,
    },
    proofPrivate: {
      trackedFileCount: proofPrivateTracked,
      ignored: proofPrivateIgnored,
      statusHitCount,
      controlTrackedPathFileCount,
    },
    profiles,
    pullRequests,
    ledger: {
      maxRoundsRecorded,
      roundCeiling: 4,
      withinCeiling: maxRoundsRecorded <= 4,
      replanRecorded: /Replanned rather than patched again/u.test(ledgerText),
      classHistoryDoesNotReset: /this file\s+does not reset|the classes above do not/u.test(
        ledgerText,
      ),
      reviewerSubstitutionRecorded: /substitution recorded on PR #116/u.test(ledgerText),
      ownerConfirmationRecorded: /confirmed by the\s+repository owner/u.test(ledgerText),
      independentGraderVerdict,
      classCount: rounds.classCount,
      classSectionCount: rounds.classSectionCount,
      unattributedRoundCount: rounds.unattributedCommits.length,
      attributedRoundCount: rounds.pullRequests.reduce(
        (sum, entry) => sum + entry.roundsAttributed,
        0,
      ),
    },
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        receipt: path.relative(root, file),
        verdict,
        coverageRegressions: regressions.length,
        regressedFiles: [...new Set(regressions.map((entry) => entry.path))],
        planCount: Number(planMatch?.[1] ?? 0),
        scan,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await run("git", ["worktree", "remove", "--force", baseWorktree]);
  await rm(workspace, { recursive: true, force: true });
}
