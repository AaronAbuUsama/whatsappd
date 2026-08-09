/// <reference types="node" />

/**
 * Proves the agent-facing docs still describe this repository.
 *
 *   pnpm check:docs
 *
 * Two failures, both of which have happened here before and neither of which
 * any existing check could see:
 *
 * 1. A doc names a path that has moved or gone. `AGENTS.md` is the entry point
 *    an unattended agent reads first, and every route out of it is a bare
 *    relative path. A stale one sends the agent to read nothing and continue
 *    anyway — the quietest way this repository can lie.
 * 2. A doc names a `pnpm` script that no longer exists. The README's
 *    verification block is the contract for how the repository is checked; a
 *    command that has been renamed makes verification unrunnable exactly when someone is
 *    following instructions rather than improvising.
 *
 * Deliberately not a link checker for prose: it resolves repository paths and
 * script names, which are the two things that go stale silently. External URLs
 * are left alone — they fail for reasons that have nothing to do with this
 * commit, and a check that fails for unrelated reasons stops being read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Docs whose references are load-bearing for an agent starting cold. */
const DOCS = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "docs/standing-decisions.md",
  "docs/runbooks/development/domain.md",
  "docs/runbooks/development/issue-tracker.md",
  "docs/runbooks/development/triage-labels.md",
  "docs/runbooks/README.md",
  "docs/runbooks/operations/session-faults.md",
  "docs/runbooks/operations/stuck-account-lease.md",
  "docs/runbooks/operations/libsql-recovery.md",
  "docs/runbooks/operations/credential-rotation.md",
  "docs/runbooks/delivery/release.md",
  "docs/runbooks/operations/ci-alerts.md",
  "docs/runbooks/development/real-account-testing.md",
];

/**
 * Paths inside backticks that look like repository locations: `docs/adr/`,
 * `src/session.ts`, `CONTEXT.md`.
 */
const BACKTICKED_PATH = /`(\.?\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?)`/g;

/** Markdown links to relative targets: [text](docs/runbooks/delivery/release.md). */
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
 * `CONTEXT-MAP.md` (which the domain runbook names precisely to forbid it)
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

const isIgnored = (value: string): boolean => {
  try {
    execFileSync("git", ["check-ignore", "--quiet", value], { cwd: root });
    return true;
  } catch {
    return false;
  }
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

const readme = await readFile(path.join(root, "README.md"), "utf8");
assert.doesNotMatch(
  readme,
  /client\.chats\.list\(\)\[0\]/,
  "README examples must not infer a real send target from the first chat",
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
    if (reference.replace(/^\.\//, "").startsWith("docs/.scratch")) {
      record(doc, `uses temporary docs path \`${reference}\` as a durable reference`);
      continue;
    }
    // A path is written either from the repository root or beside the doc that
    // names it; both conventions appear here, and both are legitimate.
    if (
      existsSync(path.join(root, reference)) ||
      existsSync(path.join(directory, reference)) ||
      isIgnored(reference)
    ) {
      continue;
    }
    record(doc, `names \`${reference}\`, which does not exist`);
  }

  for (const [, target] of text.matchAll(RELATIVE_LINK)) {
    if (!target) continue;
    if (target.replace(/^\.\//, "").includes("docs/.scratch")) {
      record(doc, `links to temporary docs path "${target}"`);
      continue;
    }
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
