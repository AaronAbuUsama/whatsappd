/**
 * Issue #112 Run B — pairing lifecycle against a throwaway profile.
 *
 * Two phases, because phase 1 costs a human a QR scan and phase 2 does not.
 * A single harness would make any phase-2 defect cost another scan.
 *
 *   pnpm proof:run-b:link      # attended: shows one QR, links, exits LINKED
 *   pnpm proof:run-b:unlink    # unattended: resumes, unlinks, proves the rest
 *
 * The profile is a NEW empty directory under `.proof-private/`. The durable
 * `android` and `ios` profiles are never opened: this process runs under Node's
 * permission model with neither directory in its filesystem allowlist, and the
 * sandbox itself is verified live before anything else runs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import {
  createSession,
  createWhatsAppClient,
  fileMediaStore,
  libsqlBackend,
  type CredentialStore,
  type Status,
  type WhatsAppClient,
  type WhatsAppRuntime,
} from "../src/index.ts";
import { createWhatsAppRuntimeForTesting } from "../src/testing.ts";
import { productionSessionFactory, publicConnectionStatus } from "../src/runtime/lifecycle.ts";
import type { RuntimeSession } from "../src/runtime/runtime-source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const proofRoot = path.join(root, ".proof-private");

// The default logger is unredacted and a pairing challenge rides the protocol
// stream. This harness emits its own count-only observations.
process.env.WA_LOG_LEVEL = "silent";

const SCAN_TIMEOUT_MS = 300_000;
const ONLINE_TIMEOUT_MS = 180_000;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Prove the filesystem sandbox is actually enforcing before trusting any
 * "no durable profile was opened" claim.
 *
 * A violation count of zero under a sandbox that was never enabled reads
 * exactly like a violation count of zero under one that was. So the denial is
 * observed positively: a read that MUST fail is attempted, and the run aborts
 * if it succeeds.
 */
export function assertDurableProfileSandbox(): {
  readonly permissionModelEnabled: boolean;
  readonly deniedProfileReadAttempts: number;
  readonly deniedProfileReadDenials: number;
} {
  if (!process.permission) {
    throw new Error("Run B must execute under --permission; the durable-profile guard is inert");
  }
  let attempts = 0;
  let denials = 0;
  for (const profile of ["android", "ios"] as const) {
    attempts += 1;
    const directory = path.join(proofRoot, profile);
    if (process.permission.has("fs.read", directory)) {
      throw new Error(`Run B was granted read access to the durable ${profile} profile`);
    }
    try {
      readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_ACCESS_DENIED") denials += 1;
      else throw error;
    }
  }
  if (denials !== attempts) {
    throw new Error("a durable profile directory was readable; the sandbox is not enforcing");
  }
  return {
    permissionModelEnabled: true,
    deniedProfileReadAttempts: attempts,
    deniedProfileReadDenials: denials,
  };
}

export interface ThrowawayProfile {
  readonly accountId: string;
  readonly directory: string;
  readonly client: WhatsAppClient;
  readonly runtime: WhatsAppRuntime;
  readonly backend: ReturnType<typeof libsqlBackend>;
  readonly sessionFactoryOpenCalls: () => number;
  readonly reconnectCount: () => number;
  readonly statuses: () => readonly Status[];
  readonly conversationSyncBatches: () => number;
  readonly conversationSyncChats: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Open the throwaway profile with a counting Session factory.
 *
 * `sessionFactoryOpenCalls` is what distinguishes "the Session that carried the
 * challenge became the linked Session" from "a second Session was opened after
 * pairing". It counts every `open()`, so the expected 515 `restart_required`
 * reconnect has to show up as a reconnect inside one Session rather than as a
 * second open.
 */
export async function openThrowawayProfile(input: {
  readonly accountId: string;
  readonly directory: string;
  /**
   * Display-only status tap. The live Session hands it the raw challenge so a
   * refreshed QR can be shown to a human; nothing it receives is ever asserted
   * on or recorded.
   */
  readonly onSessionStatus?: (status: Status) => void;
}): Promise<ThrowawayProfile> {
  const media = fileMediaStore({ directory: input.directory });
  const backend = libsqlBackend({
    url: `file:${path.join(input.directory, "whatsapp.db")}`,
    accountId: input.accountId,
    media,
  });
  let sessionFactoryOpenCalls = 0;
  let reconnectCount = 0;
  let conversationSyncBatches = 0;
  let conversationSyncChats = 0;
  // Statuses are recorded with the raw challenge stripped exactly as
  // publicConnectionStatus() does, because this array becomes part of a scanned
  // corpus: recording the raw value here would fail the very scan it feeds.
  const statuses: Status[] = [];
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: input.accountId, backend },
    {
      registration: (credentials) => productionSessionFactory.registration(credentials),
      async open(credentials: CredentialStore, auth): Promise<RuntimeSession> {
        sessionFactoryOpenCalls += 1;
        const session = createSession({ store: credentials, auth });
        session.subscribe({
          connection(status) {
            statuses.push(publicConnectionStatus(status));
            if (status.phase === "connecting" && status.retryAttempt !== undefined) {
              reconnectCount += 1;
            }
            input.onSessionStatus?.(status);
          },
          conversationSync(batch) {
            conversationSyncBatches += 1;
            conversationSyncChats += batch.chats?.length ?? 0;
          },
        });
        return session as unknown as RuntimeSession;
      },
    },
  );
  let client: WhatsAppClient | undefined;
  try {
    await runtime.start();
    client = await createWhatsAppClient(runtime);
    const opened = client;
    return {
      accountId: input.accountId,
      directory: input.directory,
      get client() {
        return opened;
      },
      runtime,
      backend,
      sessionFactoryOpenCalls: () => sessionFactoryOpenCalls,
      reconnectCount: () => reconnectCount,
      statuses: () => statuses,
      conversationSyncBatches: () => conversationSyncBatches,
      conversationSyncChats: () => conversationSyncChats,
      async close() {
        await opened.close();
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

export interface ChallengeLeakCorpus {
  readonly scannedEntries: number;
  readonly scannedBytes: number;
  readonly hits: readonly string[];
  readonly plantedControlDetected: boolean;
}

/**
 * Search a corpus for the raw challenge value.
 *
 * Two things make this more than a formality. A planted copy of the value is
 * injected into a synthetic entry, so the scan proves it can find what it
 * claims not to have found; and the corpus size is reported, so an empty
 * corpus cannot pass as a clean one.
 */
export function scanForChallengeValue(
  challengeValue: string,
  corpus: ReadonlyMap<string, string>,
): ChallengeLeakCorpus {
  if (challengeValue.length === 0) throw new Error("refusing to scan for an empty value");
  const hits: string[] = [];
  let scannedBytes = 0;
  for (const [label, text] of corpus) {
    scannedBytes += Buffer.byteLength(text);
    if (text.includes(challengeValue)) hits.push(label);
  }
  if (corpus.size === 0 || scannedBytes === 0) {
    throw new Error("the challenge leak scan looked at an empty corpus");
  }
  const planted = new Map(corpus);
  planted.set("planted-control", `prefix ${challengeValue} suffix`);
  const plantedHits = [...planted].filter(([, text]) => text.includes(challengeValue));
  return {
    scannedEntries: corpus.size,
    scannedBytes,
    hits,
    plantedControlDetected: plantedHits.some(([label]) => label === "planted-control"),
  };
}

export interface PhaseOneHandoff {
  readonly runId: string;
  readonly accountId: string;
  readonly directory: string;
  readonly salt: string;
  readonly linkedAt: string;
  readonly gitHead: string;
  readonly challengeValueLength: number;
  readonly sessionFactoryOpenCalls: number;
  readonly reconnectCount: number;
  readonly durable: {
    readonly chats: number;
    readonly contacts: number;
    readonly groups: number;
  };
  readonly conversationSyncBatches: number;
  readonly conversationSyncChats: number;
}

export function handoffPath(runId: string): string {
  return path.join(proofRoot, `run-b-${runId}.json`);
}

export function readHandoff(runId: string): PhaseOneHandoff {
  return JSON.parse(readFileSync(handoffPath(runId), "utf8")) as PhaseOneHandoff;
}

export function writeHandoff(handoff: PhaseOneHandoff): string {
  const file = handoffPath(handoff.runId);
  // `wx` — a handoff is written once. A rerun that silently replaced the
  // record of which slot phase 2 owns is exactly the mistake that unlinks the
  // wrong device.
  writeFileSync(file, `${JSON.stringify(handoff, null, 2)}\n`, { flag: "wx" });
  return file;
}

export { sha256, sleep, SCAN_TIMEOUT_MS, ONLINE_TIMEOUT_MS, proofRoot, root, qrcode, assert };
