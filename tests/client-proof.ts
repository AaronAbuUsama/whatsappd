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
import pino from "pino";
import {
  createSession,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  type CredentialStore,
  type ContactRecord,
  type MediaStore,
  type MessageRecord,
  type Status,
  type WhatsAppBackend,
  type WhatsAppRuntime,
  type WhatsAppSession,
} from "../src/index.ts";
// #107 moves this public factory to the package root. Until that surface cut,
// this source-public Client factory is the one seam #127 is proving.
import { createWhatsAppClient, type WhatsAppClientCore } from "../src/runtime/client.ts";
import { DEFAULT_ALLOWLIST_PATH, guardedSender, resolveAllowlistedTarget } from "./send-guard.ts";
import {
  captureClientProofRunStart,
  writeClientProofReceipt,
  type ClientProofSummary,
} from "./client-proof-receipt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const CHILD_ARG = "--peer-child";
const PAGING_ARG = "--paging-replacement";
const ONLINE_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 300_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const PAGE_SEED_COUNT = 30;
let proofStage = "startup";
const logger = pino({ level: "silent" });

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
  readonly backend: WhatsAppBackend;
  readonly media: MediaStore;
  readonly runtime: WhatsAppRuntime;
  readonly session: WhatsAppSession;
  readonly link: LinkSummary;
  readonly address: string;
  readonly replaceClient: () => Promise<WhatsAppClientCore>;
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
      const session = createSession({ store: credentials, auth: qrAuth(), logger });
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
    const address = await waitForAccount(
      client,
      () => client?.account.get().identity?.jid,
      "the linked account address",
    );
    if (!liveSession) throw new Error("the linked account opened no session");
    return {
      get client() {
        if (!client) throw new Error("the profile Client is not open");
        return client;
      },
      backend,
      media,
      runtime,
      session: liveSession,
      link: link.summary(),
      address,
      async replaceClient() {
        await client?.close();
        client = await createWhatsAppClient(runtime);
        return client;
      },
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

type PeerMode =
  | "profile"
  | "send-text-and-document"
  | "seed-pages"
  | "replacement"
  | "env-probe"
  | "result-then-fail"
  | "hang";

interface EnvProbe {
  readonly proofEnvCanaryPresent: boolean;
  readonly nodeTestContextPresent: boolean;
  readonly unexpectedKeys: readonly string[];
}

export interface PeerProcessResult {
  readonly pid: number;
  readonly addressHash?: string;
  readonly privateKnownValues?: {
    readonly nonce?: string;
    readonly peerAddress: string;
  };
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
      }
    | {
        readonly kind: "page-seed";
        readonly count: number;
        readonly orderedBodyDigest: string;
      };
  readonly documentSent?: {
    readonly kind: "document";
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly replacement?: ReplacementObservation;
}

interface PeerProcessOptions {
  readonly mode?: PeerMode;
  readonly timeoutMs?: number;
  readonly addressHashSalt?: string;
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

function hashAddress(salt: string, address: string): string {
  return createHash("sha256").update(salt).update(address).digest("hex");
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

export interface PagingObservation {
  readonly pageCount: number;
  readonly terminalOlder: "exhausted";
  readonly repeatedAcrossBoundary: 0;
  readonly skippedAcrossBoundary: 0;
  readonly retainedCount: number;
  readonly orderedIdDigest: string;
  readonly oracleOrderedIdDigest: string;
}

interface DurableDigest {
  readonly chats: string;
  readonly contacts: string;
  readonly groups: string;
  readonly orderedIds: string;
  readonly media: string;
}

export interface ReplacementObservation {
  readonly durableDigest: DurableDigest;
  readonly connectionPresent: false;
  readonly addressPresent: false;
  readonly presenceAddressCount: number;
  readonly presenceObservationsRestored: 0;
  readonly lastConnectedAtPresent: true;
  readonly lastDisconnectedAtPresent: true;
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

function digestIds(salt: string, ids: readonly string[]): string {
  const hash = createHash("sha256").update(salt);
  for (const id of ids) hash.update("\0").update(id);
  return hash.digest("hex");
}

function orderedMessages(messages: readonly MessageRecord[]): readonly MessageRecord[] {
  return [...messages].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.messageId.localeCompare(left.messageId),
  );
}

/**
 * Walk the public retained-message seam to exhaustion, then cross-check it
 * against the store. The oracle is deliberately invoked only after the Client
 * has reported an exhausted, duplicate-free run.
 */
export async function proveStoredPaging(input: {
  readonly client: WhatsAppClientCore;
  readonly chatId: string;
  readonly digestSalt: string;
  readonly oracle: () => Promise<readonly MessageRecord[]>;
  readonly timeoutMs?: number;
}): Promise<PagingObservation> {
  const timeoutMs = input.timeoutMs ?? ONLINE_TIMEOUT_MS;
  let pageCount = 0;
  let previousCount = input.client.messages.get(input.chatId).messages.length;
  const seen = new Set<string>();
  const off = input.client.messages.subscribe(() => {});
  try {
    while (input.client.messages.get(input.chatId).older !== "exhausted") {
      const before = input.client.messages.get(input.chatId);
      if (before.older === "loading") {
        const settled = await waitFor(() => {
          const current = input.client.messages.get(input.chatId);
          return current.older === "loading" ? undefined : current;
        }, timeoutMs);
        if (!settled) {
          proofStage = `${proofStage}:loading-timeout`;
          throw new Error("a stored page remained loading past the proof deadline");
        }
        continue;
      }

      input.client.messages.older(input.chatId);
      const landed = await waitFor(() => {
        const current = input.client.messages.get(input.chatId);
        return current.older === "loading" || current.messages.length === previousCount
          ? undefined
          : current;
      }, timeoutMs);
      if (!landed) {
        proofStage = `${proofStage}:landing-timeout`;
        throw new Error("a stored page did not land before the proof deadline");
      }
      pageCount++;
      for (const message of landed.messages) {
        if (
          seen.has(message.messageId) &&
          !before.messages.some((old) => old.messageId === message.messageId)
        ) {
          proofStage = `${proofStage}:repeat`;
          throw new Error("a message id repeated across a stored page boundary");
        }
        seen.add(message.messageId);
      }
      previousCount = landed.messages.length;
    }

    const retained = input.client.messages.get(input.chatId);
    if (pageCount < 2) {
      proofStage = `${proofStage}:page-floor`;
      throw new Error("the Client exhausted the chat in fewer than two pages");
    }
    const retainedIds = retained.messages.map(({ messageId }) => messageId);
    if (new Set(retainedIds).size !== retainedIds.length) {
      proofStage = `${proofStage}:retained-repeat`;
      throw new Error("the Client retained a repeated message id");
    }
    const descendingIds = orderedMessages(retained.messages).map(({ messageId }) => messageId);
    if (retainedIds.some((id, index) => id !== descendingIds[index])) {
      proofStage = `${proofStage}:order`;
      throw new Error("the Client retained messages are not in descending order as emitted");
    }

    // ADR-0017: only now, after the public assertion, consult the store.
    const oracle = orderedMessages(await input.oracle());
    const oracleIds = oracle.map(({ messageId }) => messageId);
    const orderedIdDigest = digestIds(input.digestSalt, retainedIds);
    const oracleOrderedIdDigest = digestIds(input.digestSalt, oracleIds);
    if (
      retainedIds.length !== oracleIds.length ||
      retainedIds.some((id, index) => id !== oracleIds[index])
    ) {
      proofStage = `${proofStage}:oracle-mismatch`;
      throw new Error("the store oracle did not match the Client's contiguous retained run");
    }
    return {
      pageCount,
      terminalOlder: "exhausted",
      repeatedAcrossBoundary: 0,
      skippedAcrossBoundary: 0,
      retainedCount: retainedIds.length,
      orderedIdDigest,
      oracleOrderedIdDigest,
    };
  } finally {
    off();
  }
}

function stableDigest(salt: string, value: unknown): string {
  return sha256(`${salt}\0${JSON.stringify(value)}`);
}

function contactAddresses(contacts: readonly ContactRecord[]): readonly string[] {
  return [
    ...new Set(contacts.flatMap((contact) => [contact.contactId, ...contact.nativeIds])),
  ].sort();
}

async function durableDigest(input: {
  readonly client: WhatsAppClientCore;
  readonly media: Pick<MediaStore, "read">;
  readonly accountId: string;
  readonly chatId: string;
  readonly salt: string;
}): Promise<DurableDigest> {
  const chats = input.client.chats.list();
  const contacts = input.client.contacts.list();
  const groups = input.client.groups.list();
  const messages = orderedMessages(input.client.messages.get(input.chatId).messages);
  const mediaEntries: Array<{ readonly messageId: string; readonly sha256: string }> = [];
  for (const message of messages) {
    if (
      message.kind !== "image" &&
      message.kind !== "video" &&
      message.kind !== "audio" &&
      message.kind !== "document" &&
      message.kind !== "sticker"
    ) {
      continue;
    }
    if (message.media.state !== "stored") continue;
    const bytes = await input.media.read({ accountId: input.accountId, ref: message.media.ref });
    if (!bytes) throw new Error("a Client-surfaced stored media ref could not be read");
    mediaEntries.push({ messageId: message.messageId, sha256: sha256(bytes) });
  }
  return {
    chats: stableDigest(input.salt, chats),
    contacts: stableDigest(input.salt, contacts),
    groups: stableDigest(input.salt, groups),
    orderedIds: digestIds(
      input.salt,
      messages.map(({ messageId }) => messageId),
    ),
    media: stableDigest(input.salt, mediaEntries),
  };
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
  const addressHashSalt = options.addressHashSalt ?? randomBytes(16).toString("hex");

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
          CLIENT_PROOF_HASH_SALT: addressHashSalt,
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
      try {
        // The ios profile has a known teardown race after a complete resume or
        // send. A full result proves the requested property finished before
        // close; gate on that property rather than converting the unrelated
        // teardown exit into a false red.
        resolve(JSON.parse(stdout) as PeerProcessResult);
      } catch {
        reject(
          code === 0
            ? new Error("peer process returned an invalid result")
            : new Error(`peer process exited ${code ?? "without a status"}`),
        );
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
  if (mode === "result-then-fail") {
    process.stdout.write(JSON.stringify({ pid: process.pid } satisfies PeerProcessResult));
    throw new Error("deterministic post-result failure");
  }

  const salt = process.env.CLIENT_PROOF_HASH_SALT;
  if (!salt) throw new Error("peer child has no address hash salt");
  if (mode === "replacement") {
    const result: PeerProcessResult = {
      pid: process.pid,
      replacement: await coldReplacement(salt),
    };
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (mode !== "profile" && mode !== "send-text-and-document" && mode !== "seed-pages") {
    throw new Error("unknown peer child mode");
  }

  const peer = await openProfile("ios");
  try {
    let sent: PeerProcessResult["sent"];
    let documentSent: PeerProcessResult["documentSent"];
    let nonce: string | undefined;
    if (mode === "send-text-and-document") {
      nonce = randomBytes(24).toString("base64url");
      const target = resolveAllowlistedTarget(proofGroupId());
      await guardedSender(peer.session).send(target, { text: nonce });
      sent = { kind: "text", sha256: sha256(nonce), byteLength: Buffer.byteLength(nonce) };
      const bytes = randomBytes(256);
      await guardedSender(peer.session).send(target, {
        document: bytes,
        fileName: "whatsappd-proof.bin",
        mimetype: "application/octet-stream",
      });
      documentSent = { kind: "document", sha256: sha256(bytes), byteLength: bytes.byteLength };
    } else if (mode === "seed-pages") {
      const target = resolveAllowlistedTarget(proofGroupId());
      const bodyHashes: string[] = [];
      for (let index = 0; index < PAGE_SEED_COUNT; index++) {
        const body = `whatsappd-page-proof:${randomBytes(24).toString("base64url")}`;
        await guardedSender(peer.session).send(target, { text: body });
        bodyHashes.push(sha256(body));
      }
      sent = {
        kind: "page-seed",
        count: bodyHashes.length,
        orderedBodyDigest: stableDigest(salt, bodyHashes),
      };
    } else if (mode !== "profile") {
      throw new Error("unknown peer child mode");
    }
    const result: PeerProcessResult = {
      pid: process.pid,
      addressHash: hashAddress(salt, peer.address),
      privateKnownValues: {
        ...(nonce && { nonce }),
        peerAddress: peer.address,
      },
      link: peer.link,
      ...(sent && { sent }),
      ...(documentSent && { documentSent }),
    };
    process.stdout.write(JSON.stringify(result));
  } finally {
    await peer.close();
  }
}

async function allStoredMessages(
  backend: WhatsAppBackend,
  accountId: string,
  chatId: string,
): Promise<readonly MessageRecord[]> {
  return await backend.data.read(accountId, async (view) => {
    const messages: MessageRecord[] = [];
    let before: { readonly timestamp: number; readonly messageId: string } | undefined;
    do {
      const page = await view.messages(chatId, before && { before });
      messages.push(...page.messages);
      before = page.nextBefore;
    } while (before);
    return messages;
  });
}

async function coldReplacement(salt: string): Promise<ReplacementObservation> {
  proofStage = "cold-backend-open";
  const directory = profileDirectory("android");
  const media = fileMediaStore({ directory });
  const backend = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: "android",
    media,
  });
  const runtime = createWhatsAppRuntime({
    accountId: "android",
    backend,
    openSession(credentials: CredentialStore) {
      return createSession({ store: credentials, auth: qrAuth(), logger });
    },
  });
  let client: WhatsAppClientCore | undefined;
  try {
    // Do not start the Runtime. Factory resolution must reflect only durable
    // state, before a live session can attach and manufacture current status.
    proofStage = "cold-client-factory";
    client = await createWhatsAppClient(runtime);
    const account = client.account.get();
    const addresses = contactAddresses(client.contacts.list());
    if (addresses.length === 0) {
      throw new Error("the cold presence check had no durable addresses to inspect");
    }
    const presenceObservationsRestored = addresses.filter(
      (address) => client?.contacts.presence(address) !== undefined,
    ).length;
    if (
      account.connection !== undefined ||
      account.identity !== undefined ||
      presenceObservationsRestored !== 0 ||
      account.lastConnectedAt === undefined ||
      account.lastDisconnectedAt === undefined
    ) {
      throw new Error("the cold Client reconstructed live state or lost durable observed instants");
    }

    proofStage = "cold-public-paging";
    const chatId = proofGroupId();
    await proveStoredPaging({
      client,
      chatId,
      digestSalt: salt,
      oracle: () => allStoredMessages(backend, "android", chatId),
    });
    proofStage = "cold-durable-digest";
    return {
      durableDigest: await durableDigest({
        client,
        media,
        accountId: "android",
        chatId,
        salt,
      }),
      connectionPresent: false,
      addressPresent: false,
      presenceAddressCount: addresses.length,
      presenceObservationsRestored: 0,
      lastConnectedAtPresent: true,
      lastDisconnectedAtPresent: true,
    };
  } finally {
    await client?.close().catch(() => {});
    await runtime.stop().catch(() => {});
    await backend.close().catch(() => {});
  }
}

async function pagingReplacementRun(): Promise<void> {
  if (process.stdin.isTTY) {
    throw new Error("client proof refuses an interactive TTY; run it with stdin closed");
  }

  const salt = randomBytes(16).toString("hex");
  let subject: OpenProfile | undefined;
  try {
    proofStage = "subject-open";
    subject = await openProfile("android");
    const subjectLink = subject.link;
    if (subjectLink.linkMode !== "resumed") {
      throw new Error("the durable linked profile entered pairing instead of resuming");
    }

    proofStage = "public-paging";
    const chatId = proofGroupId();
    const subjectBackend = subject.backend;
    const paging = await proveStoredPaging({
      client: subject.client,
      chatId,
      digestSalt: salt,
      oracle: () => allStoredMessages(subjectBackend, "android", chatId),
    });
    const seededMessageCount = subject.client.messages
      .get(chatId)
      .messages.filter(
        (message) => message.kind === "text" && message.text.startsWith("whatsappd-page-proof:"),
      ).length;
    if (seededMessageCount < 26) {
      throw new Error("the public Client did not retain more than one page of proof seed messages");
    }
    const durableBeforeReplacement = await durableDigest({
      client: subject.client,
      media: subject.media,
      accountId: "android",
      chatId,
      salt,
    });

    proofStage = "subject-close";
    await subject.close();
    subject = undefined;
    proofStage = "cold-replacement";
    const replacementProcess = await runPeerProcess({
      mode: "replacement",
      addressHashSalt: salt,
      timeoutMs: 120_000,
    });
    const replacement = replacementProcess.replacement;
    if (!replacement || replacementProcess.pid === process.pid) {
      throw new Error("the durable replacement did not run in a distinct OS process");
    }
    proofStage = "durable-comparison";
    if (JSON.stringify(replacement.durableDigest) !== JSON.stringify(durableBeforeReplacement)) {
      throw new Error("the replacement process reconstructed a different durable digest");
    }

    proofStage = "summary";
    process.stdout.write(
      `${JSON.stringify({
        finalized: true,
        interactive: false,
        linkMode: subjectLink.linkMode,
        challengeEventCount: subjectLink.challengeEventCount,
        qrDisplayed: subjectLink.qrDisplayed,
        subjectPid: process.pid,
        replacementPid: replacementProcess.pid,
        pageSeed: {
          seededMessageCount,
          source: "allowlisted-peer-process",
        },
        paging,
        replacement: {
          distinctPid: true,
          durableDigestEqual: true,
          durableDigest: replacement.durableDigest,
          connectionPresent: replacement.connectionPresent,
          addressPresent: replacement.addressPresent,
          presenceAddressCount: replacement.presenceAddressCount,
          presenceObservationsRestored: replacement.presenceObservationsRestored,
          lastConnectedAtPresent: replacement.lastConnectedAtPresent,
          lastDisconnectedAtPresent: replacement.lastDisconnectedAtPresent,
        },
      })}\n`,
    );
  } finally {
    await subject?.close();
  }
}

async function subjectRun(): Promise<void> {
  if (process.stdin.isTTY) {
    throw new Error("client proof refuses an interactive TTY; run it with stdin closed");
  }

  const runStart = captureClientProofRunStart(root);
  if (!runStart.treeClean) {
    throw new Error("client proof refuses a dirty tree before opening either linked account");
  }
  const salt = randomBytes(16).toString("hex");
  let subject: OpenProfile | undefined;
  try {
    proofStage = "subject-open";
    subject = await openProfile("android");
    const chatId = proofGroupId();
    let textPeer: PeerProcessResult | undefined;
    proofStage = "inbound-text";
    const text = await observeInboundText({
      client: subject.client,
      chatId,
      async send() {
        textPeer = await runPeerProcess({ mode: "send-text-and-document", addressHashSalt: salt });
        if (textPeer.sent?.kind !== "text" || !textPeer.documentSent) {
          throw new Error("the peer returned no text-and-document send proof");
        }
        return textPeer.sent;
      },
    });
    const documentPeer = textPeer;
    proofStage = "inbound-document";
    const document = await observeInboundDocument({
      accountId: "android",
      client: subject.client,
      media: subject.media,
      chatId,
      async send() {
        if (documentPeer?.documentSent?.kind !== "document") {
          throw new Error("the peer returned no document-send proof");
        }
        return documentPeer.documentSent;
      },
    });
    proofStage = "page-seed";
    await subject.replaceClient();
    subject.client.messages.older(chatId);
    const firstPublicPage = await waitFor(() => {
      const current = subject?.client.messages.get(chatId);
      return current?.older === "loading" || current?.messages.length === 0 ? undefined : current;
    }, ONLINE_TIMEOUT_MS);
    if (!firstPublicPage) throw new Error("the first public store page did not land");
    let pageSeedPeer: PeerProcessResult | undefined;
    let seededThisRun = 0;
    let seedBodyDigest: string | undefined;
    if (firstPublicPage.older === "exhausted") {
      pageSeedPeer = await runPeerProcess({
        mode: "seed-pages",
        addressHashSalt: salt,
        timeoutMs: 120_000,
      });
      if (pageSeedPeer.sent?.kind !== "page-seed" || pageSeedPeer.sent.count < 26) {
        throw new Error("the peer did not seed more than one default store page");
      }
      seededThisRun = pageSeedPeer.sent.count;
      seedBodyDigest = pageSeedPeer.sent.orderedBodyDigest;
      proofStage = "page-seed-observation";
      const seedObserved = await waitFor(() => {
        const observed = subject?.client.messages
          .get(chatId)
          .messages.filter(
            (message) =>
              message.kind === "text" && message.text.startsWith("whatsappd-page-proof:"),
          ).length;
        return observed !== undefined && observed >= 26 ? observed : undefined;
      }, ONLINE_TIMEOUT_MS);
      if (!seedObserved)
        throw new Error("the seeded page messages did not reach the subject Client");
    }

    // Begin the paging assertion from no retained rows. The durable mirror now
    // contains the seeded run, while this new Client has not read a store page.
    proofStage = "public-paging";
    await subject.replaceClient();
    const subjectBackend = subject.backend;
    const paging = await proveStoredPaging({
      client: subject.client,
      chatId,
      digestSalt: salt,
      oracle: () => allStoredMessages(subjectBackend, "android", chatId),
    });
    const durableBeforeReplacement = await durableDigest({
      client: subject.client,
      media: subject.media,
      accountId: "android",
      chatId,
      salt,
    });

    if (!textPeer || !documentPeer) throw new Error("the peer process returned no address proof");
    const subjectAddressHash = hashAddress(salt, subject.address);
    const subjectLink = subject.link;
    const peerAddressHash = textPeer.addressHash;
    if (
      textPeer.pid === process.pid ||
      documentPeer.pid === process.pid ||
      pageSeedPeer?.pid === process.pid ||
      pageSeedPeer?.pid === textPeer.pid ||
      peerAddressHash === undefined ||
      documentPeer.addressHash !== peerAddressHash ||
      (pageSeedPeer?.addressHash !== undefined && pageSeedPeer.addressHash !== peerAddressHash) ||
      peerAddressHash === subjectAddressHash
    ) {
      throw new Error("subject and peer were not distinct linked accounts in distinct processes");
    }
    if (
      subjectLink.linkMode !== "resumed" ||
      textPeer.link?.linkMode !== "resumed" ||
      documentPeer.link?.linkMode !== "resumed" ||
      (pageSeedPeer?.link !== undefined && pageSeedPeer.link.linkMode !== "resumed")
    ) {
      throw new Error("a durable linked profile entered pairing instead of resuming");
    }

    // Release the account-owned resources before the replacement process opens
    // the same files. Two processes on one profile would be a lease conflict,
    // not a replacement proof.
    proofStage = "subject-close";
    await subject.close();
    subject = undefined;
    proofStage = "cold-replacement";
    const replacementProcess = await runPeerProcess({
      mode: "replacement",
      addressHashSalt: salt,
      timeoutMs: 120_000,
    });
    const replacement = replacementProcess.replacement;
    if (!replacement || replacementProcess.pid === process.pid) {
      throw new Error("the durable replacement did not run in a distinct OS process");
    }
    proofStage = "durable-comparison";
    if (JSON.stringify(replacement.durableDigest) !== JSON.stringify(durableBeforeReplacement)) {
      throw new Error("the replacement process reconstructed a different durable digest");
    }

    proofStage = "summary";
    const summary = {
      finalized: true,
      interactive: false,
      composition: [
        "fileMediaStore",
        "libsqlBackend",
        "createWhatsAppRuntime",
        "createWhatsAppClient",
      ],
      subjectImports: ["package-root", "runtime-client-public-factory"],
      linkMode: subjectLink.linkMode,
      challengeEventCount: subjectLink.challengeEventCount,
      qrDisplayed: subjectLink.qrDisplayed,
      stdoutContainedChallenge: false,
      subjectPid: process.pid,
      peerPid: textPeer.pid,
      documentPeerPid: documentPeer.pid,
      ...(pageSeedPeer && { pageSeedPeerPid: pageSeedPeer.pid }),
      replacementPid: replacementProcess.pid,
      subjectAddressHash,
      peerAddressHash,
      peer: {
        mode: "second-account-own-process",
        linkMode: textPeer.link.linkMode,
        challengeEventCount:
          textPeer.link.challengeEventCount + (pageSeedPeer?.link?.challengeEventCount ?? 0),
        qrDisplayed: textPeer.link.qrDisplayed || (pageSeedPeer?.link?.qrDisplayed ?? false),
      },
      inboundText: text,
      inboundDocument: document,
      pageSeed: {
        sentThisRun: seededThisRun,
        retainedBeforeWalk: paging.retainedCount,
        ...(seedBodyDigest && { orderedBodyDigest: seedBodyDigest }),
      },
      paging,
      replacement: {
        distinctPid: true,
        durableDigestEqual: true,
        durableDigest: replacement.durableDigest,
        connectionPresent: replacement.connectionPresent,
        addressPresent: replacement.addressPresent,
        presenceAddressCount: replacement.presenceAddressCount,
        presenceObservationsRestored: replacement.presenceObservationsRestored,
        lastConnectedAtPresent: replacement.lastConnectedAtPresent,
        lastDisconnectedAtPresent: replacement.lastDisconnectedAtPresent,
      },
    } satisfies ClientProofSummary;
    const nonce = textPeer.privateKnownValues?.nonce;
    const peerAddress = textPeer.privateKnownValues?.peerAddress;
    if (!nonce || !peerAddress) {
      throw new Error("the receipt negative control is missing an in-memory known value");
    }
    const receipt = writeClientProofReceipt(root, {
      runStart,
      finalizedAt: new Date().toISOString(),
      summary,
      knownValues: [nonce, peerAddress, chatId],
    });
    process.stderr.write(
      `${JSON.stringify({
        receipt: path.relative(root, receipt.file),
        patternHits: receipt.scan.patternHits,
        knownValueHits: receipt.scan.knownValueHits,
        nonEmpty: receipt.scan.nonEmpty,
      })}\n`,
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
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
    else if (process.argv.includes(PAGING_ARG)) await pagingReplacementRun();
    else await subjectRun();
  } catch {
    process.stderr.write(`client proof failed at ${proofStage}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardTimeout);
  }
}
