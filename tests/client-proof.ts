/**
 * Issue #127 Client proof, composition and process-isolation lane.
 *
 * Run from the repository root with stdin closed:
 *
 *   pnpm proof:client < /dev/null
 *
 * The android profile is the subject. The ios profile resumes in a separate
 * process, against its own files, so ADR-0009's one-runtime-per-account rule is
 * preserved. This lane does not send anything. Later #127 lanes extend the
 * same process boundary for inbound observations.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSession,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  type CredentialStore,
  type Status,
} from "../src/index.ts";
// #107 moves this public factory to the package root. Until that surface cut,
// this source-public Client factory is the one seam #127 is proving.
import { createWhatsAppClient, type WhatsAppClientCore } from "../src/runtime/client.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const CHILD_ARG = "--peer-child";
const ONLINE_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 180_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

type LinkMode = "resumed" | "paired";

export interface LinkSummary {
  readonly linkMode: LinkMode;
  readonly challengeEventCount: number;
  readonly qrDisplayed: false;
}

/**
 * Observe whether a run resumed or entered pairing.
 *
 * Credential presence is deliberately not an input. Stored credentials may
 * have been revoked, while an observed `challenge_live` means the run really
 * did require pairing.
 */
export function createLinkObservation(): {
  readonly observe: (status: Status) => void;
  readonly summary: () => LinkSummary;
} {
  let challengeEventCount = 0;
  return {
    observe(status) {
      if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
        challengeEventCount++;
      }
    },
    summary() {
      return {
        linkMode: challengeEventCount === 0 ? "resumed" : "paired",
        challengeEventCount,
        // The harness records a challenge but never renders its secret.
        qrDisplayed: false,
      };
    },
  };
}

interface OpenProfile {
  readonly client: WhatsAppClientCore;
  readonly link: LinkSummary;
  readonly identity: string;
  readonly close: () => Promise<void>;
}

function profileDirectory(profile: "android" | "ios"): string {
  return path.join(root, ".proof-private", profile);
}

async function waitForAccount(
  client: WhatsAppClientCore,
  read: () => string | undefined,
  what: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const sample = (): void => {
      const value = read();
      if (value !== undefined) finish(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error(`timed out waiting for ${what}`));
    }, ONLINE_TIMEOUT_MS);
    const off = client.account.subscribe(sample);
    sample();
  });
}

async function openProfile(profile: "android" | "ios"): Promise<OpenProfile> {
  const directory = profileDirectory(profile);
  const media = fileMediaStore({ directory });
  const backend = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: profile,
    media,
  });
  const link = createLinkObservation();
  const runtime = createWhatsAppRuntime({
    accountId: profile,
    backend,
    openSession(credentials: CredentialStore) {
      const session = createSession({ store: credentials, auth: qrAuth() });
      session.subscribe({ connection: link.observe });
      return session;
    },
  });

  let client: WhatsAppClientCore | undefined;
  try {
    await runtime.start();
    client = await createWhatsAppClient(runtime);
    await waitForAccount(
      client,
      () => (client?.account.get().connection?.phase === "online" ? "online" : undefined),
      "the linked account to become online",
    );
    const identity = await waitForAccount(
      client,
      () => client?.account.get().identity?.jid,
      "the linked account identity",
    );
    return {
      client,
      link: link.summary(),
      identity,
      async close() {
        // Application-owned order: Client, Runtime, Backend.
        await client?.close();
        await runtime.stop();
        await backend.close();
      },
    };
  } catch (error) {
    await client?.close().catch(() => {});
    await runtime.stop().catch(() => {});
    await backend.close().catch(() => {});
    throw error;
  }
}

type PeerMode = "profile" | "env-probe" | "hang";

interface EnvProbe {
  readonly proofEnvCanaryPresent: boolean;
  readonly nodeTestContextPresent: boolean;
  readonly unexpectedKeys: readonly string[];
}

export interface PeerProcessResult {
  readonly pid: number;
  readonly identityHash?: string;
  readonly link?: LinkSummary;
  readonly envProbe?: EnvProbe;
}

interface PeerProcessOptions {
  readonly mode?: PeerMode;
  readonly timeoutMs?: number;
  readonly identityHashSalt?: string;
}

const PEER_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "WA_LOG_LEVEL",
  "CLIENT_PROOF_CHILD_MODE",
  "CLIENT_PROOF_HASH_SALT",
  // Node injects its coverage directory into children of an
  // `--experimental-test-coverage` process. It is runner instrumentation, not
  // inherited application state, and does not carry NODE_TEST_CONTEXT.
  "NODE_V8_COVERAGE",
  // macOS injects this locale hint into a spawned process even when it was not
  // supplied in `env`. It carries no parent/test-runner state.
  "__CF_USER_TEXT_ENCODING",
]);

function hashIdentity(salt: string, identity: string): string {
  return createHash("sha256").update(salt).update(identity).digest("hex");
}

/**
 * Run the peer as a separate OS process with a deliberately tiny environment.
 *
 * Never spread `process.env` here. Doing so leaks `NODE_TEST_CONTEXT` into a
 * child launched by `node --test`, which can make the child skip its work and
 * still exit zero.
 */
export function runPeerProcess(options: PeerProcessOptions = {}): Promise<PeerProcessResult> {
  const mode = options.mode ?? "profile";
  const timeoutMs = options.timeoutMs ?? ONLINE_TIMEOUT_MS;
  const identityHashSalt = options.identityHashSalt ?? randomBytes(16).toString("hex");

  return new Promise<PeerProcessResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url), CHILD_ARG],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.HOME && { HOME: process.env.HOME }),
          WA_LOG_LEVEL: "silent",
          CLIENT_PROOF_CHILD_MODE: mode,
          CLIENT_PROOF_HASH_SALT: identityHashSalt,
        },
      },
    );
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_CHILD_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`peer process exceeded ${timeoutMs}ms wall-clock timeout`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`peer process exited ${code ?? "without a status"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PeerProcessResult);
      } catch {
        reject(new Error("peer process returned an invalid result"));
      }
    });
  });
}

async function peerChild(): Promise<void> {
  const mode = process.env.CLIENT_PROOF_CHILD_MODE as PeerMode | undefined;
  if (mode === "hang") {
    setInterval(() => {}, 60_000);
    return;
  }
  if (mode === "env-probe") {
    const result: PeerProcessResult = {
      pid: process.pid,
      envProbe: {
        proofEnvCanaryPresent: process.env.PROOF_ENV_CANARY !== undefined,
        nodeTestContextPresent: process.env.NODE_TEST_CONTEXT !== undefined,
        unexpectedKeys: Object.keys(process.env)
          .filter((key) => !PEER_ENV_KEYS.has(key))
          .sort(),
      },
    };
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (mode !== "profile") throw new Error("unknown peer child mode");

  const salt = process.env.CLIENT_PROOF_HASH_SALT;
  if (!salt) throw new Error("peer child has no identity hash salt");
  const peer = await openProfile("ios");
  try {
    const result: PeerProcessResult = {
      pid: process.pid,
      identityHash: hashIdentity(salt, peer.identity),
      link: peer.link,
    };
    process.stdout.write(JSON.stringify(result));
  } finally {
    await peer.close();
  }
}

async function subjectRun(): Promise<void> {
  if (process.stdin.isTTY) {
    throw new Error("client proof refuses an interactive TTY; run it with stdin closed");
  }

  const salt = randomBytes(16).toString("hex");
  const peerPromise = runPeerProcess({ identityHashSalt: salt });
  let subject: OpenProfile | undefined;
  try {
    subject = await openProfile("android");
    const peer = await peerPromise;
    const subjectIdentityHash = hashIdentity(salt, subject.identity);
    if (
      peer.pid === process.pid ||
      peer.identityHash === undefined ||
      peer.identityHash === subjectIdentityHash
    ) {
      throw new Error("subject and peer were not distinct linked accounts in distinct processes");
    }
    if (subject.link.linkMode !== "resumed" || peer.link?.linkMode !== "resumed") {
      throw new Error("a durable linked profile entered pairing instead of resuming");
    }

    process.stdout.write(
      `${JSON.stringify({
        finalized: true,
        interactive: false,
        composition: [
          "fileMediaStore",
          "libsqlBackend",
          "createWhatsAppRuntime",
          "createWhatsAppClient",
        ],
        subjectImports: ["package-root", "runtime-client-public-factory"],
        linkMode: subject.link.linkMode,
        challengeEventCount: subject.link.challengeEventCount,
        qrDisplayed: subject.link.qrDisplayed,
        stdoutContainedChallenge: false,
        subjectPid: process.pid,
        peerPid: peer.pid,
        subjectIdentityHash,
        peerIdentityHash: peer.identityHash,
        peer: {
          mode: "second-account-own-process",
          linkMode: peer.link.linkMode,
          challengeEventCount: peer.link.challengeEventCount,
          qrDisplayed: peer.link.qrDisplayed,
        },
      })}\n`,
    );
  } finally {
    await subject?.close();
    await peerPromise.catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hardTimeout = setTimeout(() => {
    process.stderr.write("client proof exceeded its hard wall-clock timeout\n");
    process.exit(1);
  }, RUN_TIMEOUT_MS);

  try {
    if (process.argv.includes(CHILD_ARG)) await peerChild();
    else await subjectRun();
  } catch {
    process.stderr.write("client proof failed\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(hardTimeout);
  }
}
