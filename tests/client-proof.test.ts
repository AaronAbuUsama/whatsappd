/**
 * Deterministic guardrails for the real-account Client proof harness.
 *
 * The live behavior is P4 and runs separately. These tests pin the parts most
 * likely to make that run dishonest: deriving resume from observed challenges,
 * isolating the peer child from the test runner's environment, bounding a hung
 * child, and keeping the subject on the agreed composition seams.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaStore, MessageRecord, WhatsAppClient } from "../src/index.ts";
import { test } from "./_expect.ts";
import {
  createLinkObservation,
  observeInboundDocument,
  observeInboundText,
  proveStoredPaging,
  runPeerProcess,
  type PeerProcessResult,
} from "./client-proof.ts";
import { assertTeardownProofSummary, type TeardownProofSummary } from "./teardown-proof-summary.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the teardown proof summary rejects every incomplete observation clause", () => {
  const complete: TeardownProofSummary = {
    stopAttempts: 10,
    totalStops: 11,
    unqualifiedStops: 1,
    stopFailures: 0,
    inFlightAtStop: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    stopPendingWhileHeld: 10,
    syncAcceptances: 10,
    leaseHeldWhileDraining: 10,
    leaseFreeAfterStop: 10,
    challengeProduced: false,
  };
  assert.doesNotThrow(() => assertTeardownProofSummary(complete));
  for (const incomplete of [
    { ...complete, stopAttempts: 9 },
    { ...complete, totalStops: 10 },
    { ...complete, unqualifiedStops: 0 },
    { ...complete, inFlightAtStop: complete.inFlightAtStop.map(() => 0) },
    { ...complete, stopFailures: 1 },
    { ...complete, stopPendingWhileHeld: 9 },
    { ...complete, syncAcceptances: 9 },
    { ...complete, leaseHeldWhileDraining: 9 },
    { ...complete, leaseFreeAfterStop: 9 },
    { ...complete, challengeProduced: true },
  ])
    assert.throws(() => assertTeardownProofSummary(incomplete));
});

test("resume is derived from observed challenge_live events", () => {
  const resumed = createLinkObservation();
  resumed.observe({ phase: "online" });
  assert.deepEqual(resumed.summary(), {
    linkMode: "resumed",
    challengeEventCount: 0,
    qrDisplayed: false,
  });

  const paired = createLinkObservation();
  paired.observe({
    phase: "pairing",
    pairing: {
      step: "challenge_live",
      method: "qr",
      qr: "not-rendered",
      expiresAt: 1,
    },
  });
  assert.deepEqual(paired.summary(), {
    linkMode: "paired",
    challengeEventCount: 1,
    qrDisplayed: false,
  });
});

test("peer child receives an explicit environment allowlist", async () => {
  process.env.PROOF_ENV_CANARY = "must-not-cross";
  let result: PeerProcessResult;
  try {
    result = await runPeerProcess({ mode: "env-probe", timeoutMs: 5_000 });
  } finally {
    delete process.env.PROOF_ENV_CANARY;
  }

  assert.notEqual(result.pid, process.pid);
  assert.equal(result.envProbe?.proofEnvCanaryPresent, false);
  assert.equal(result.envProbe?.nodeTestContextPresent, false);
  assert.deepEqual(result.envProbe?.unexpectedKeys, []);
});

test("peer child is killed when the wall-clock timeout expires", async () => {
  await assert.rejects(
    runPeerProcess({ mode: "hang", timeoutMs: 50 }),
    /peer process exceeded 50ms wall-clock timeout/,
  );
});

test("a complete peer result survives the known post-result teardown failure", async () => {
  const result = await runPeerProcess({ mode: "result-then-fail", timeoutMs: 5_000 });
  assert.notEqual(result.pid, process.pid);
});

test("inbound text is retained before the peer sends and proves both Client surfaces", async () => {
  const chatId = "proof-group@g.us";
  const nonce = "generated-nonce";
  const nonceSha256 = createHash("sha256").update(nonce).digest("hex");
  const message = {
    accountId: "android",
    chatId,
    messageId: "nonce-message",
    sender: { id: "peer@lid", mode: "lid" },
    ref: { id: "nonce-message", chatId, fromMe: false, participant: "peer@lid" },
    fromMe: false,
    timestamp: 123,
    receipts: [],
    reactions: [],
    kind: "text",
    text: nonce,
  } satisfies MessageRecord;
  let retained: readonly MessageRecord[] = [];
  let chatLastMessageAt = 100;
  let messagesGetCalled = false;
  const messageListeners = new Set<() => void>();
  const chatListeners = new Set<() => void>();
  const client = {
    chats: {
      list: () => [
        { accountId: "android", chatId, isGroup: true, lastMessageAt: chatLastMessageAt },
      ],
      subscribe(listener: () => void) {
        chatListeners.add(listener);
        return () => chatListeners.delete(listener);
      },
    },
    messages: {
      get(requested: string) {
        assert.equal(requested, chatId);
        messagesGetCalled = true;
        return { chatId, messages: retained, older: "stored" as const };
      },
      subscribe(listener: () => void) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
    },
  } as unknown as WhatsAppClient;

  const observed = await observeInboundText({
    client,
    chatId,
    timeoutMs: 500,
    async send() {
      assert.equal(messagesGetCalled, true, "messages.get(chatId) must run before the peer sends");
      retained = [message];
      chatLastMessageAt = message.timestamp;
      for (const listener of messageListeners) listener();
      for (const listener of chatListeners) listener();
      return { sha256: nonceSha256, byteLength: Buffer.byteLength(nonce) };
    },
  });

  assert.deepEqual(observed, {
    observedVia: "live-upsert",
    nonceSha256,
    nonceLength: Buffer.byteLength(nonce),
    chatsList: true,
    messagesGet: true,
  });
});

test("inbound document bytes are read through only the Client-surfaced media ref", async () => {
  const chatId = "proof-group@g.us";
  const bytes = Buffer.from("generated document bytes");
  const sentSha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = "media:v1:surfaced";
  const document = {
    accountId: "android",
    chatId,
    messageId: "document-message",
    sender: { id: "peer@lid", mode: "lid" },
    ref: { id: "document-message", chatId, fromMe: false, participant: "peer@lid" },
    fromMe: false,
    timestamp: 124,
    receipts: [],
    reactions: [],
    kind: "document",
    media: {
      state: "stored",
      ref,
      byteLength: bytes.byteLength,
      mimetype: "application/octet-stream",
      fileName: "proof.bin",
    },
  } satisfies MessageRecord;
  let retained: readonly MessageRecord[] = [];
  let messagesGetCalled = false;
  const listeners = new Set<() => void>();
  const client = {
    messages: {
      get: () => {
        messagesGetCalled = true;
        return { chatId, messages: retained, older: "stored" as const };
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as WhatsAppClient;
  const reads: { accountId: string; ref: string }[] = [];
  const media = {
    async read(input) {
      reads.push(input);
      return input.ref === ref ? Uint8Array.from(bytes) : null;
    },
  } as Pick<MediaStore, "read">;

  const observed = await observeInboundDocument({
    accountId: "android",
    client,
    media,
    chatId,
    timeoutMs: 500,
    async send() {
      assert.equal(messagesGetCalled, true, "messages.get(chatId) must run before the peer sends");
      retained = [document];
      for (const listener of listeners) listener();
      return { sha256: sentSha256, byteLength: bytes.byteLength };
    },
  });

  assert.deepEqual(reads, [{ accountId: "android", ref }]);
  assert.deepEqual(observed, {
    kind: "document",
    mediaState: "stored",
    byteLength: bytes.byteLength,
    byteLengthMatches: true,
    sentSha256,
    storedSha256: sentSha256,
    equal: true,
  });
});

test("stored paging walks two pages to exhausted before consulting the oracle", async () => {
  const chatId = "proof-group@g.us";
  const messages = Array.from({ length: 29 }, (_, index) => ({
    accountId: "android",
    chatId,
    messageId: `message-${String(29 - index).padStart(2, "0")}`,
    sender: { id: "peer@lid", mode: "lid" as const },
    ref: {
      id: `message-${String(29 - index).padStart(2, "0")}`,
      chatId,
      fromMe: false,
      participant: "peer@lid",
    },
    fromMe: false,
    timestamp: 10_000 - index,
    receipts: [],
    reactions: [],
    kind: "text" as const,
    text: `seed-${index}`,
  })) satisfies MessageRecord[];
  let retained: readonly MessageRecord[] = [];
  let older: "stored" | "loading" | "exhausted" = "stored";
  let page = 0;
  const listeners = new Set<() => void>();
  const client = {
    messages: {
      get: () => ({ chatId, messages: retained, older }),
      older() {
        older = "loading";
        for (const listener of listeners) listener();
        queueMicrotask(() => {
          page++;
          retained = messages.slice(0, page === 1 ? 25 : 29);
          older = page === 1 ? "stored" : "exhausted";
          for (const listener of listeners) listener();
        });
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as WhatsAppClient;
  let oracleCalledAtPage = 0;

  const result = await proveStoredPaging({
    client,
    chatId,
    digestSalt: "deterministic-test-salt",
    async oracle() {
      oracleCalledAtPage = page;
      return messages;
    },
  });

  assert.equal(oracleCalledAtPage, 2, "the store oracle must run after the public walk");
  assert.deepEqual(result, {
    pageCount: 2,
    terminalOlder: "exhausted",
    repeatedAcrossBoundary: 0,
    skippedAcrossBoundary: 0,
    retainedCount: 29,
    orderedIdDigest: result.orderedIdDigest,
    oracleOrderedIdDigest: result.orderedIdDigest,
  });
});

test("stored paging refuses an oracle mismatch after the public assertion", async () => {
  const chatId = "proof-group@g.us";
  const messages = Array.from({ length: 26 }, (_, index) => ({
    accountId: "android",
    chatId,
    messageId: `message-${String(26 - index).padStart(2, "0")}`,
    sender: { id: "peer@lid", mode: "lid" as const },
    ref: {
      id: `message-${String(26 - index).padStart(2, "0")}`,
      chatId,
      fromMe: false,
      participant: "peer@lid",
    },
    fromMe: false,
    timestamp: 10_000 - index,
    receipts: [],
    reactions: [],
    kind: "text" as const,
    text: `seed-${index}`,
  })) satisfies MessageRecord[];
  let retained: readonly MessageRecord[] = [];
  let older: "stored" | "loading" | "exhausted" = "stored";
  let page = 0;
  const listeners = new Set<() => void>();
  const client = {
    messages: {
      get: () => ({ chatId, messages: retained, older }),
      older() {
        older = "loading";
        queueMicrotask(() => {
          page++;
          retained = messages.slice(0, page === 1 ? 25 : 26);
          older = page === 1 ? "stored" : "exhausted";
          for (const listener of listeners) listener();
        });
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as WhatsAppClient;

  await assert.rejects(
    proveStoredPaging({
      client,
      chatId,
      digestSalt: "deterministic-test-salt",
      oracle: async () => messages.slice(0, -1),
    }),
    /store oracle did not match the Client's contiguous retained run/,
  );
});

test("stored paging refuses an adjacent swap across a page boundary at the order clause", async () => {
  const chatId = "proof-group@g.us";
  const oracleMessages = Array.from({ length: 29 }, (_, index) => ({
    accountId: "android",
    chatId,
    messageId: `message-${String(29 - index).padStart(2, "0")}`,
    sender: { id: "peer@lid", mode: "lid" as const },
    ref: {
      id: `message-${String(29 - index).padStart(2, "0")}`,
      chatId,
      fromMe: false,
      participant: "peer@lid",
    },
    fromMe: false,
    timestamp: 10_000 - index,
    receipts: [],
    reactions: [],
    kind: "text" as const,
    text: `seed-${index}`,
  })) satisfies MessageRecord[];
  const emittedMessages = [...oracleMessages];
  [emittedMessages[24], emittedMessages[25]] = [emittedMessages[25]!, emittedMessages[24]!];
  let retained: readonly MessageRecord[] = [];
  let older: "stored" | "loading" | "exhausted" = "stored";
  let page = 0;
  const listeners = new Set<() => void>();
  const client = {
    messages: {
      get: () => ({ chatId, messages: retained, older }),
      older() {
        older = "loading";
        queueMicrotask(() => {
          page++;
          retained = emittedMessages.slice(0, page === 1 ? 25 : 29);
          older = page === 1 ? "stored" : "exhausted";
          for (const listener of listeners) listener();
        });
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as WhatsAppClient;

  await assert.rejects(
    proveStoredPaging({
      client,
      chatId,
      digestSalt: "deterministic-test-salt",
      oracle: async () => oracleMessages,
    }),
    /Client retained messages are not in descending order/,
  );
});

async function testSources(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testSources(file)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file);
  }
  return files;
}

function codeWithoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/u, ""))
    .join("\n");
}

function guardBypassesIn(source: string): readonly string[] {
  const code = codeWithoutComments(source);
  return [
    ...(/\b(?:\w+\.)?session\s*\.\s*send\s*\(/u.test(code) ? ["raw-session-send"] : []),
    ...(code.includes("client.messages.send.") ? ["raw-client-send"] : []),
    ...(code.includes("resolveAllowlistedTargetForTest(") ? ["test-allowlist-seam"] : []),
  ];
}

test("subject composition imports only the agreed public seams", async () => {
  const source = await readFile(path.join(here, "client-proof.ts"), "utf8");
  assert.match(source, /from "\.\.\/src\/index\.ts"/);
  assert.equal(source.match(/guardedSender\(peer\.session\)\.send/g)?.length, 3);
  assert.equal(source.includes("peer.session.send("), false);
  for (const forbidden of [
    "../src/stores/",
    "../src/runtime/client.ts",
    "../src/runtime/libsql.ts",
    "../src/runtime/projection.ts",
    "../src/baileys/",
    "../src/session.ts",
  ]) {
    assert.equal(source.includes(forbidden), false, `subject harness reached into ${forbidden}`);
  }
});

test("every real-profile harness uses the production allowlist authority and guarded send site", async () => {
  const harnesses: Array<{ readonly file: string; readonly source: string }> = [];
  for (const file of await testSources(here)) {
    if (file.endsWith(".test.ts")) continue;
    const source = await readFile(file, "utf8");
    const code = codeWithoutComments(source);
    if (!code.includes(".proof-private") && !/\bopenProfile\s*\(/u.test(code)) continue;
    if (!/\b(?:createSession|createWhatsAppRuntime|openProfile)\s*\(/u.test(code)) continue;
    harnesses.push({ file, source });
  }

  assert.deepEqual(
    harnesses.map(({ file }) => path.relative(here, file)).sort(),
    [
      "client-proof.ts",
      "history-proof.ts",
      "live-send-proof.ts",
      "pairing-proof.ts",
      "proof-profile.ts",
      "teardown-proof.ts",
    ],
    "the mechanical real-profile harness enumeration changed",
  );
  for (const { file, source } of harnesses) {
    assert.deepEqual(
      guardBypassesIn(source),
      [],
      `${path.relative(here, file)} bypasses the send guard`,
    );
  }

  assert.deepEqual(
    guardBypassesIn(`
      await peer.session.send(target, { text: "raw" });
      await client.messages.send.text(target, "raw");
      resolveAllowlistedTargetForTest(target, callerPath);
    `),
    ["raw-session-send", "raw-client-send", "test-allowlist-seam"],
    "the harness scan cannot see a planted bypass",
  );
});
