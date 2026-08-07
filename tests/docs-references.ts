/**
 * Proves the agent-facing docs still describe this repository.
 *
 *   node --experimental-strip-types tests/docs-references.ts
 *
 * Two failures, both of which have happened here before and neither of which
 * any existing check could see:
 *
 * 1. A doc names a path that has moved or gone. `AGENTS.md` is the entry point
 *    an unattended agent reads first, and every route out of it is a bare
 *    relative path. A stale one sends the agent to read nothing and continue
 *    anyway — the quietest way this repository can lie.
 * 2. A doc names a `pnpm` script that no longer exists. The README's "Proof"
 *    block is the contract for how the repository is verified; a command that
 *    has been renamed makes the proof unrunnable exactly when someone is
 *    following instructions rather than improvising.
 *
 * Deliberately not a link checker for prose: it resolves repository paths and
 * script names, which are the two things that go stale silently. External URLs
 * are left alone — they fail for reasons that have nothing to do with this
 * commit, and a proof that fails for unrelated reasons stops being read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Docs whose references are load-bearing for an agent starting cold. */
const DOCS = [
  "AGENTS.md",
  "CONTEXT.md",
  "README.md",
  "CONTRIBUTING.md",
  "docs/agents/domain.md",
  "docs/agents/handoff-0.3-client-stack.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
  "docs/agents/frontier-execution.md",
  "docs/runbooks/README.md",
  "docs/runbooks/session-faults.md",
  "docs/runbooks/stuck-account-lease.md",
  "docs/runbooks/libsql-recovery.md",
  "docs/runbooks/credential-rotation.md",
  "docs/runbooks/release.md",
  "docs/runbooks/ci-alerts.md",
  "docs/runbooks/real-account-testing.md",
];

const markdownFiles = async (directory: string): Promise<readonly string[]> =>
  (await readdir(path.join(root, directory)))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => `${directory}/${entry}`);

const completeAgentDocs = [
  "AGENTS.md",
  "CONTEXT.md",
  "README.md",
  "CONTRIBUTING.md",
  ...(await markdownFiles("docs/agents")),
  ...(await markdownFiles("docs/runbooks")),
].sort();

const assertCompleteAgentDocs = (documents: readonly string[]): void =>
  assert.deepEqual(
    [...documents].sort(),
    completeAgentDocs,
    "DOCS must cover every root, agent, and runbook document; do not shrink the list to stay green",
  );

assert.throws(
  () =>
    assertCompleteAgentDocs(DOCS.filter((doc) => doc !== "docs/runbooks/real-account-testing.md")),
  /do not shrink the list to stay green/,
);
assertCompleteAgentDocs(DOCS);
assert.ok(
  DOCS.includes("docs/runbooks/real-account-testing.md"),
  "the real-account safety runbook is load-bearing agent documentation",
);

/**
 * Paths inside backticks that look like repository locations: `docs/adr/`,
 * `src/session.ts`, `CONTEXT.md`.
 */
const BACKTICKED_PATH = /`(\.?\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?)`/g;

/** Markdown links to relative targets: [text](docs/runbooks/release.md). */
const RELATIVE_LINK = /\[[^\]]*\]\((?!https?:|#|mailto:)([^)#]+)(?:#[^)]*)?\)/g;

/** `pnpm <script>` mentions, which must exist in package.json. */
const PNPM_SCRIPT = /\bpnpm (?:run )?([a-z][a-z0-9:-]*)\b/g;

/** pnpm's own subcommands — not repository scripts, so not our business. */
const PNPM_BUILTINS = new Set([
  "add",
  "changeset",
  "config",
  "dlx",
  "exec",
  "install",
  "pack",
  "publish",
  "remove",
  "run",
  "update",
  "why",
]);

/**
 * Entries git tracks at the repository root. A backticked path counts as a
 * repository reference only when its first segment is one of these.
 *
 * Anchoring on tracked names is what separates a reference from an example.
 * `docs/adr/` and `CONTEXT.md` are things this repository has, so a stale one
 * is drift worth failing on. `kebab-case.ts`, `AaronAbuUsama/whatsappd`, and
 * `CONTEXT-MAP.md` (which `docs/agents/domain.md` names precisely to forbid it)
 * are not paths at all — a checker that flagged them would be disabled within a
 * week, and then it would catch nothing.
 */
const trackedRootEntries = new Set(
  execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((tracked) => tracked.split("/")[0] ?? ""),
);

const isRepositoryReference = (value: string): boolean => {
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  const [first] = normalized.split("/");
  return first !== undefined && trackedRootEntries.has(first);
};

const failures: string[] = [];
const record = (doc: string, message: string): void => {
  failures.push(`${doc}: ${message}`);
};

const scripts = new Set(
  Object.keys(
    (
      JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts,
  ),
);

for (const doc of DOCS) {
  const absolute = path.join(root, doc);
  if (!existsSync(absolute)) {
    record(doc, "listed in this proof but missing from the repository");
    continue;
  }

  const text = await readFile(absolute, "utf8");
  const directory = path.dirname(absolute);

  for (const [, reference] of text.matchAll(BACKTICKED_PATH)) {
    if (!reference || !isRepositoryReference(reference)) continue;
    // A path is written either from the repository root or beside the doc that
    // names it; both conventions appear here, and both are legitimate.
    if (existsSync(path.join(root, reference)) || existsSync(path.join(directory, reference))) {
      continue;
    }
    record(doc, `names \`${reference}\`, which does not exist`);
  }

  for (const [, target] of text.matchAll(RELATIVE_LINK)) {
    if (!target) continue;
    if (existsSync(path.join(directory, target))) continue;
    record(doc, `links to "${target}", which does not exist`);
  }

  for (const [, script] of text.matchAll(PNPM_SCRIPT)) {
    if (!script || PNPM_BUILTINS.has(script) || scripts.has(script)) continue;
    record(doc, `documents \`pnpm ${script}\`, which is not a script in package.json`);
  }
}

assert.deepEqual(
  failures,
  [],
  `Agent-facing documentation references things that do not exist:\n\n${failures
    .map((line) => `  - ${line}`)
    .join("\n")}\n`,
);

console.log(`docs-references: ${DOCS.length} documents, every path and pnpm script resolves`);
