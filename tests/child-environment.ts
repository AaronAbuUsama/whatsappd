/**
 * The environment a spawned proof child is allowed to see.
 *
 * Never `process.env`. The established pattern is `runPeerProcess` in
 * `tests/client-proof.ts`, and the concrete hazard is `NODE_TEST_CONTEXT`:
 * spreading this process's environment into a child launched under
 * `node --test` makes the child believe it is already inside a test run.
 * Measured on this repository's Node — a file containing `assert.equal(1, 2)`
 * exits **1** normally and exits **0** with `NODE_TEST_CONTEXT=child-v8` set,
 * printing `node:test run() is being called recursively within a test file.
 * skipping running files.` The final-gates proof spawns `node --test` children
 * to count tests and to drive its red probes, so an inherited value would make
 * a planted failure read green.
 *
 * Separated from the runner so the unit test drives the same function the real
 * spawns use. A self-test that exercises a different code path certifies a
 * command nobody runs.
 */

/**
 * What a proof child genuinely needs.
 *
 * `PATH` to resolve binaries, `HOME` for the git, gh and npm configuration they
 * read, `TMPDIR` for the temporary files they write, and the proxy, locale and
 * terminal variables that decide whether the network calls work at all.
 */
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "USER",
  "NODE_AUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * The variables that must never reach a child, whatever else does.
 *
 * The allowlist already excludes these; this is what lets a receipt record a
 * measured `0` rather than a claim about a list, and it is the positive control
 * for the allowlist — asked about an environment that carries them, it says so.
 */
export const CHILD_ENV_FORBIDDEN = [
  "NODE_TEST_CONTEXT",
  "NODE_OPTIONS",
  "NODE_V8_COVERAGE",
] as const;

export function childEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...overrides };
}

/** Forbidden variables present in an environment. Empty is the passing shape. */
export function forbiddenChildEnvironmentLeaks(env: NodeJS.ProcessEnv): readonly string[] {
  return CHILD_ENV_FORBIDDEN.filter((key) => env[key] !== undefined);
}
