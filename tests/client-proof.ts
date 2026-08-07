/**
 * Issue #127 Client proof, composition and process-isolation lane.
 *
 * Run from the repository root with stdin closed:
 *
 *   pnpm proof:client < /dev/null
 *
 * The android profile is the subject. The ios profile resumes in a separate
 * process, against its own files, so ADR-0009's one-runtime-per-account rule is
 * preserved. Every peer send resolves the shared proof group through the
 * fail-closed allowlist guard.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSession,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  type CredentialStore,
  type MediaStore,
  type MessageRecord,
  type Status,
  type WhatsAppSession,
} from "../src/index.ts";
// #107 moves this public factory to the package root. Until that surface cut,
// this source-public Client factory is the one seam #127 is proving.
import { createWhatsAppClient, type WhatsAppClientCore } from "../src/runtime/client.ts";
import { DEFAULT_ALLOWLIST_PATH, guardedSender, resolveAllowlistedTarget } from "./send-guard.ts";

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
  readonly media: MediaStore;
  readonly session: WhatsAppSession;
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
  let liveSession: WhatsAppSession | undefined;
  const runtime = createWhatsAppRuntime({
    accountId: profile,
    backend,
    openSession(credentials: CredentialStore) {
      const session = createSession({ store: credentials, auth: qrAuth() });
      session.subscribe({ connection: link.observe });
      liveSession = session;
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
    if (!liveSession) throw new Error("the linked account opened no session");
    return {
      client,
      media,
      session: liveSession,
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

type PeerMode = "profile" | "send-text" | "send-document" | "env-probe" | "hang";

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
  readonly sent?:
    | {
        readonly kind: "text";
        readonly sha256: string;
        readonly byteLength: number;
      }
    | {
        readonly kind: "document";
        readonly sha256: string;
        readonly byteLength: number;
      };
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

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function proofGroupId(): string {
  const parsed = JSON.parse(readFileSync(DEFAULT_ALLOWLIST_PATH, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the send allowlist is not an object");
  }
  const groups = (parsed as { groups?: unknown }).groups;
  if (
    !Array.isArray(groups) ||
    groups.length !== 1 ||
    typeof groups[0] !== "string" ||
    groups[0].length === 0
  ) {
    throw new Error("the send allowlist must contain exactly one proof group");
  }
  // Resolution is deliberately performed even on the subject, so the same
  // exact-id authority selects the chat the peer is permitted to send to.
  resolveAllowlistedTarget(groups[0]);
  return groups[0];
}

interface SentPayload {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface InboundTextObservation {
  readonly observedVia: "live-upsert" | "stored-page";
  readonly nonceSha256: string;
  readonly nonceLength: number;
  readonly chatsList: true;
  readonly messagesGet: true;
}

export interface InboundDocumentObservation {
  readonly kind: "document";
  readonly mediaState: "stored";
  readonly byteLength: number;
  readonly byteLengthMatches: true;
  readonly sentSha256: string;
  readonly storedSha256: string;
  readonly equal: true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  return undefined;
}

function textObservation(
  client: WhatsAppClientCore,
  chatId: string,
  sent: SentPayload,
): Omit<InboundTextObservation, "observedVia"> | undefined {
  const message = client.messages
    .get(chatId)
    .messages.find(
      (candidate): candidate is Extract<MessageRecord, { kind: "text" }> =>
        candidate.kind === "text" &&
        Buffer.byteLength(candidate.text) === sent.byteLength &&
        sha256(candidate.text) === sent.sha256,
    );
  if (!message) return undefined;
  const chat = client.chats.list().find((candidate) => candidate.chatId === chatId);
  if (!chat || chat.lastMessageAt < message.timestamp) return undefined;
  return {
    nonceSha256: sent.sha256,
    nonceLength: sent.byteLength,
    chatsList: true,
    messagesGet: true,
  };
}

/**
 * Subscribe and retain the chat before allowing the peer send to begin.
 *
 * No store page is read unless the live window expires, so the verdict records
 * whether the observation was the live upsert or a later durable page.
 */
export async function observeInboundText(input: {
  readonly client: WhatsAppClientCore;
  readonly chatId: string;
  readonly send: () => Promise<SentPayload>;
  readonly timeoutMs?: number;
}): Promise<InboundTextObservation> {
  const timeoutMs = input.timeoutMs ?? ONLINE_TIMEOUT_MS;
  input.client.messages.get(input.chatId);
  const offMessages = input.client.messages.subscribe(() => {});
  const offChats = input.client.chats.subscribe(() => {});
  try {
    const sent = await input.send();
    const live = await waitFor(
      () => textObservation(input.client, input.chatId, sent),
      Math.min(timeoutMs, 30_000),
    );
    if (live) return { observedVia: "live-upsert", ...live };

    input.client.messages.older(input.chatId);
    const stored = await waitFor(
      () => textObservation(input.client, input.chatId, sent),
      Math.max(1, timeoutMs - 30_000),
    );
    if (stored) return { observedVia: "stored-page", ...stored };
    throw new Error("the peer text did not surface through both Client read paths");
  } finally {
    offChats();
    offMessages();
  }
}

async function documentObservation(
  accountId: string,
  client: WhatsAppClientCore,
  media: Pick<MediaStore, "read">,
  chatId: string,
  sent: SentPayload,
): Promise<InboundDocumentObservation | undefined> {
  for (const message of client.messages.get(chatId).messages) {
    if (message.kind !== "document" || message.media.state !== "stored") continue;
    const bytes = await media.read({ accountId, ref: message.media.ref });
    if (!bytes) continue;
    const storedSha256 = sha256(bytes);
    if (storedSha256 !== sent.sha256) continue;
    if (message.media.byteLength !== sent.byteLength || bytes.byteLength !== sent.byteLength) {
      throw new Error("the stored document length differs from the peer's sent length");
    }
    return {
      kind: "document",
      mediaState: "stored",
      byteLength: message.media.byteLength,
      byteLengthMatches: true,
      sentSha256: sent.sha256,
      storedSha256,
      equal: true,
    };
  }
  return undefined;
}

export async function observeInboundDocument(input: {
  readonly accountId: string;
  readonly client: WhatsAppClientCore;
  readonly media: Pick<MediaStore, "read">;
  readonly chatId: string;
  readonly send: () => Promise<SentPayload>;
  readonly timeoutMs?: number;
}): Promise<InboundDocumentObservation> {
  input.client.messages.get(input.chatId);
  const off = input.client.messages.subscribe(() => {});
  try {
    const sent = await input.send();
    const observed = await waitFor(
      () => documentObservation(input.accountId, input.client, input.media, input.chatId, sent),
      input.timeoutMs ?? ONLINE_TIMEOUT_MS,
    );
    if (!observed) throw new Error("the peer document did not surface with stored media bytes");
    return observed;
  } finally {
    off();
  }
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
  if (mode !== "profile" && mode !== "send-text" && mode !== "send-document") {
    throw new Error("unknown peer child mode");
  }

  const salt = process.env.CLIENT_PROOF_HASH_SALT;
  if (!salt) throw new Error("peer child has no identity hash salt");
  const peer = await openProfile("ios");
  try {
    let sent: PeerProcessResult["sent"];
    if (mode === "send-text") {
      const nonce = randomBytes(24).toString("base64url");
      const target = resolveAllowlistedTarget(proofGroupId());
      await guardedSender(peer.session).send(target, { text: nonce });
      sent = { kind: "text", sha256: sha256(nonce), byteLength: Buffer.byteLength(nonce) };
    } else if (mode === "send-document") {
      const bytes = randomBytes(256);
      const target = resolveAllowlistedTarget(proofGroupId());
      await guardedSender(peer.session).send(target, {
        document: bytes,
        fileName: "whatsappd-proof.bin",
        mimetype: "application/octet-stream",
      });
      sent = { kind: "document", sha256: sha256(bytes), byteLength: bytes.byteLength };
    } else if (mode !== "profile") {
      throw new Error("unknown peer child mode");
    }
    const result: PeerProcessResult = {
      pid: process.pid,
      identityHash: hashIdentity(salt, peer.identity),
      link: peer.link,
      ...(sent && { sent }),
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
  let subject: OpenProfile | undefined;
  try {
    subject = await openProfile("android");
    const chatId = proofGroupId();
    let textPeer: PeerProcessResult | undefined;
    const text = await observeInboundText({
      client: subject.client,
      chatId,
      async send() {
        textPeer = await runPeerProcess({ mode: "send-text", identityHashSalt: salt });
        if (textPeer.sent?.kind !== "text") {
          throw new Error("the peer returned no text-send proof");
        }
        return textPeer.sent;
      },
    });
    let documentPeer: PeerProcessResult | undefined;
    const document = await observeInboundDocument({
      accountId: "android",
      client: subject.client,
      media: subject.media,
      chatId,
      async send() {
        documentPeer = await runPeerProcess({ mode: "send-document", identityHashSalt: salt });
        if (documentPeer.sent?.kind !== "document") {
          throw new Error("the peer returned no document-send proof");
        }
        return documentPeer.sent;
      },
    });
    if (!textPeer || !documentPeer) throw new Error("the peer process returned no identity proof");
    const subjectIdentityHash = hashIdentity(salt, subject.identity);
    const peerIdentityHash = textPeer.identityHash;
    if (
      textPeer.pid === process.pid ||
      documentPeer.pid === process.pid ||
      textPeer.pid === documentPeer.pid ||
      peerIdentityHash === undefined ||
      documentPeer.identityHash !== peerIdentityHash ||
      peerIdentityHash === subjectIdentityHash
    ) {
      throw new Error("subject and peer were not distinct linked accounts in distinct processes");
    }
    if (
      subject.link.linkMode !== "resumed" ||
      textPeer.link?.linkMode !== "resumed" ||
      documentPeer.link?.linkMode !== "resumed"
    ) {
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
        peerPid: textPeer.pid,
        documentPeerPid: documentPeer.pid,
        subjectIdentityHash,
        peerIdentityHash,
        peer: {
          mode: "second-account-own-process",
          linkMode: textPeer.link.linkMode,
          challengeEventCount:
            textPeer.link.challengeEventCount + documentPeer.link.challengeEventCount,
          qrDisplayed: textPeer.link.qrDisplayed || documentPeer.link.qrDisplayed,
        },
        inboundText: text,
        inboundDocument: document,
      })}\n`,
    );
  } finally {
    await subject?.close();
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
