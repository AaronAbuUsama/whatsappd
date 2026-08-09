/**
 * Proves the send guard's type-level half by making it fail on purpose.
 *
 *   pnpm proof:client:guard
 *
 * `proofs/support/send-guard-types.ts` carries three `@ts-expect-error` directives: one
 * for a caller-controlled allowlist at resolution, one for a raw `chatId:
 * string` at the send site, and one for a hand-forged brand. `pnpm check` being
 * green with them there says the lines beneath them are type errors *today*.
 * It does not say the guard is what makes them errors — an unused directive is
 * itself an error, so a green run is consistent with the guard having been
 * weakened and something unrelated failing in its place.
 *
 * So this script removes each directive, one at a time, and requires `pnpm
 * check` to go **red**, naming the fixture's own file and line. A guard nobody
 * has watched fail is an assumption.
 *
 * Three things make the red runs mean what they claim:
 *
 *   - **A scratch worktree.** `git worktree add --detach` plus a *copied*
 *     `node_modules`; never a symlink, which pnpm treats as a modules directory
 *     to purge. The mission tree never goes dirty, so a red run cannot be this
 *     script's own mess.
 *   - **Exactly one error, and it is the fixture's.** A control that goes red
 *     for the wrong reason is not a control. `vite.config.ts` records the
 *     layering rule once being inert while a probe passed clean, and the probe
 *     that "proved" it importing a symbol that did not exist — so the run was
 *     red from TS2459 and said nothing about the rule.
 *   - **A baseline green in the same worktree.** Otherwise a worktree that
 *     cannot typecheck at all would report two convincing red runs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join("proofs", "support", "send-guard-types.ts");

/** The markers in `send-guard-types.ts`, and what each directive is protecting. */
const CASES = [
  {
    marker: "guard-fixture:caller-allowlist",
    what: "a caller-controlled allowlist at production resolution",
  },
  { marker: "guard-fixture:raw-string", what: "a raw chatId string at the send site" },
  { marker: "guard-fixture:forged-brand", what: "a hand-forged brand at the send site" },
] as const;

interface CheckResult {
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Run `pnpm check` in `cwd`.
 *
 * @remarks
 * Never through a pipe. `npm pack` in this repository exits 0 through one, and
 * the mission's coverage gate was once piped into `tail`, which reports tail's
 * always-zero status — a gating command that ends in a bare pipe has stopped
 * gating. The child's environment is an explicit allowlist; inheriting the
 * whole parent environment leaks `NODE_TEST_CONTEXT` into a child, which is PR
 * #94's false green (`AGENTS.md`).
 */
function check(cwd: string): CheckResult {
  try {
    const output = execFileSync("pnpm", ["check"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.SHELL && { SHELL: process.env.SHELL }),
      },
    });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** Deletes the `@ts-expect-error` line that follows `marker`, leaving the rest byte-identical. */
function withoutDirectiveAfter(source: string, marker: string): string {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  assert.notEqual(at, -1, `${FIXTURES} no longer contains the marker ${marker}`);
  const directiveAt = at + 1;
  assert.ok(
    lines[directiveAt]?.includes("@ts-expect-error"),
    `the line after ${marker} is not a @ts-expect-error directive — the fixture has drifted`,
  );
  return [...lines.slice(0, directiveAt), ...lines.slice(directiveAt + 1)].join("\n");
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const scratch = mkdtempSync(path.join(tmpdir(), "whatsappd-guard-proof-"));
const worktree = path.join(scratch, "tree");

try {
  console.log(`send-guard-proof: scratch worktree at ${head.slice(0, 7)}`);
  execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });

  // The fixtures are uncommitted while this lane is in progress, and a worktree
  // at HEAD would not have them. Copy the working-tree files across, so what is
  // proven is what is on disk.
  for (const file of [
    FIXTURES,
    path.join("proofs", "support", "send-guard.ts"),
    path.join("proofs", "tests", "send-guard.test.ts"),
  ]) {
    cpSync(path.join(root, file), path.join(worktree, file));
  }
  // Copied, never symlinked: pnpm treats a symlinked node_modules as a modules
  // directory to purge, prompts, and fails for a reason unrelated to the guard.
  cpSync(path.join(root, "node_modules"), path.join(worktree, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  const fixturePath = path.join(worktree, FIXTURES);
  const original = readFileSync(fixturePath, "utf8");
  assert.ok(
    original.includes("@ts-expect-error"),
    "the copied fixture file carries no directive — nothing would be proven",
  );

  // Baseline. Without it, a worktree that cannot typecheck at all would produce
  // convincing red runs that look exactly like a working guard.
  const baseline = check(worktree);
  assert.ok(
    baseline.ok,
    `the scratch worktree is not green with every directive present, so a red run below would prove nothing:\n${baseline.output}`,
  );
  console.log("  green   every directive present — every fixture really is a type error");

  for (const { marker, what } of CASES) {
    writeFileSync(fixturePath, withoutDirectiveAfter(original, marker), "utf8");
    const red = check(worktree);
    writeFileSync(fixturePath, original, "utf8");

    assert.ok(
      !red.ok,
      `removing the directive for ${what} left \`pnpm check\` GREEN. The guard is not rejecting it:\n${red.output}`,
    );
    // Red for the right reason: the error must be at the fixture, not somewhere
    // this script disturbed. Reported as a count so no source line is printed.
    const errorLines = red.output
      .split("\n")
      .filter((line) => /\berror\b/i.test(line) && !/^\s*pass:/.test(line));
    assert.ok(
      red.output.includes("send-guard-types.ts"),
      `removing the directive for ${what} went red, but not at ${FIXTURES}:\n${red.output}`,
    );
    console.log(`  red     without the directive for ${what} (${errorLines.length} error lines)`);
  }

  // And green again afterwards, so the red runs above were caused by the
  // removal rather than by anything this script left behind.
  const restored = check(worktree);
  assert.ok(
    restored.ok,
    `the worktree did not return to green after restoring:\n${restored.output}`,
  );
  console.log("  green   restored — all red runs were caused by the removal");

  console.log(
    `send-guard-proof: ${CASES.length} fixtures, green with them and red without each one`,
  );
} finally {
  if (existsSync(worktree)) {
    execFileSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      stdio: "ignore",
    });
  }
  rmSync(scratch, { recursive: true, force: true });
}
