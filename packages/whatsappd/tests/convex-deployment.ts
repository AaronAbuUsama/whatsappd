/**
 * One throwaway local Convex deployment, for proving the Convex backend against
 * the same conformance suites libSQL answers.
 *
 * @remarks
 * The deployment is the real `convex-local-backend`: SQLite on disk, file
 * storage in a directory, the same binary `npx convex dev` runs against a local
 * deployment. Nothing here mocks Convex — a fake would agree with whatever the
 * adapter believes, which is the belief under test.
 *
 * The binary is not vendored. It is looked up where the Convex CLI already
 * caches it, or wherever `CONVEX_LOCAL_BACKEND` points. With neither, this
 * answers `undefined` and the suite skips loudly rather than passing without
 * having run.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "convex-app");

/** How the child processes see the world. Never the parent's whole environment:
 * a spawned `node --test` that inherits NODE_TEST_CONTEXT skips every file and
 * exits 0, which is a green run that executed nothing. */
const childEnvironment = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "",
  ...extra,
});

/** A port the operating system just confirmed is free. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
    });
  });

/** The newest backend the Convex CLI has already downloaded, if any. */
async function backendBinary(): Promise<string | undefined> {
  const named = process.env.CONVEX_LOCAL_BACKEND;
  if (named) return named;
  const binaries = path.join(process.env.HOME ?? "", ".cache", "convex", "binaries");
  const versions = await readdir(binaries).catch(() => []);
  const newest = versions.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).at(-1);
  return newest === undefined ? undefined : path.join(binaries, newest, "convex-local-backend");
}

const reachable = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(`${url}/version`)).ok;
  } catch {
    return false;
  }
};

/** Wait for the backend to answer, failing the suite rather than hanging it. */
async function awaitBackend(url: string, backend: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null)
      throw new Error(`the Convex backend exited with code ${backend.exitCode}`);
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the Convex backend at ${url} never became reachable`);
}

export interface ConvexDeployment {
  readonly url: string;
  /** Empty every table, so each conformance fixture starts from nothing. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot a local Convex deployment and push this package's functions to it.
 *
 * @returns The running deployment, or `undefined` when no backend binary is
 * available on this machine.
 */
export async function startConvexDeployment(): Promise<ConvexDeployment | undefined> {
  const binary = await backendBinary();
  if (binary === undefined) return undefined;

  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-convex-"));
  const instance = "whatsappd-test";
  const secret = randomBytes(32).toString("hex");
  let backend: ChildProcess | undefined;
  const stop = async (): Promise<void> => {
    if (backend && backend.exitCode === null) {
      const exited = new Promise((resolve) => backend?.once("exit", resolve));
      backend.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const key = await run(
      binary,
      ["keygen", "admin-key", "--instance-name", instance, "--instance-secret", secret],
      { env: childEnvironment({}) },
    );
    const adminKey = key.stdout.trim();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    backend = spawn(
      binary,
      [
        "--port",
        String(port),
        "--site-proxy-port",
        String(await freePort()),
        "--instance-name",
        instance,
        "--instance-secret",
        secret,
        "--local-storage",
        path.join(directory, "storage"),
        "--disable-beacon",
        "--do-not-require-ssl",
        path.join(directory, "convex.sqlite3"),
      ],
      { cwd: directory, env: childEnvironment({}), stdio: "ignore" },
    );
    await awaitBackend(url, backend);

    const cli = path.join(
      path.dirname(createRequire(import.meta.url).resolve("convex/package.json")),
      "bin",
      "main.js",
    );
    await run(process.execPath, [cli, "deploy", "-y", "--typecheck", "disable"], {
      cwd: fixture,
      env: childEnvironment({
        CONVEX_SELF_HOSTED_URL: url,
        CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      }),
    });

    const { ConvexHttpClient } = await import("convex/browser");
    const client = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: false });
    return {
      url,
      reset: () => client.mutation("testing:reset" as never, {}),
      close: stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
