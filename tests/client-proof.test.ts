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
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaStore, MessageRecord } from "../src/index.ts";
import type { WhatsAppClientCore } from "../src/runtime/client.ts";
import { test } from "./_expect.ts";
import {
  createLinkObservation,
  observeInboundDocument,
  observeInboundText,
  runPeerProcess,
  type PeerProcessResult,
} from "./client-proof.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

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
  } as unknown as WhatsAppClientCore;

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
  } as unknown as WhatsAppClientCore;
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

test("subject composition imports only the agreed public seams", async () => {
  const source = await readFile(path.join(here, "client-proof.ts"), "utf8");
  assert.match(source, /from "\.\.\/src\/index\.ts"/);
  assert.match(source, /from "\.\.\/src\/runtime\/client\.ts"/);
  assert.equal(source.match(/guardedSender\(peer\.session\)\.send/g)?.length, 2);
  assert.equal(source.includes("peer.session.send("), false);
  for (const forbidden of [
    "../src/stores/",
    "../src/runtime/libsql.ts",
    "../src/runtime/projection.ts",
    "../src/baileys/",
    "../src/session.ts",
  ]) {
    assert.equal(source.includes(forbidden), false, `subject harness reached into ${forbidden}`);
  }
});
