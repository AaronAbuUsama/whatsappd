/**
 * Issue #108 live durable-send proof.
 *
 * Run once, unattended, from a clean exact head:
 *
 *   pnpm proof:live-send < /dev/null
 *
 * The android profile submits one durable text send. The ios profile observes
 * the group in its own process. No identifier or message body is printed.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { MessageRecord, MessageRef, WhatsAppClient, WhatsAppOperation } from "../src/index.ts";
import { openProfile, proofGroupId } from "./client-proof.ts";
import {
  captureLiveSendProofRunStart,
  writeLiveSendProofReceipt,
  type LiveSendProofSummary,
} from "./live-send-proof-receipt.ts";
import { guardedClientSender, resolveAllowlistedTarget, SendRefusedError } from "./send-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PEER_ARG = "--peer";
const BODY_ENV = "LIVE_SEND_BODY";
const REPLAY_LABEL = "m3-live-send-2026-08-07-v1";
const TIMEOUT_MS = 90_000;
const SETTLE_MS = 2_000;

type StatusName = "queued" | "claimed" | "executing" | "succeeded";

interface PeerObservation {
  readonly kind: "ready" | "snapshot" | "closed";
  readonly pid: number;
  readonly linkMode?: "resumed" | "paired";
  readonly inboxCount?: number;
  readonly matchingMessages?: number;
  readonly privateIdentity?: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error("live send proof timed out before the required observation");
}

function matchingMessages(
  client: WhatsAppClient,
  chatId: string,
  bodyHash: string,
): MessageRecord[] {
  return client.messages
    .get(chatId)
    .messages.filter(
      (message): message is Extract<MessageRecord, { kind: "text" }> =>
        message.kind === "text" && sha256(message.text) === bodyHash,
    );
}

function messageRefOf(operation: WhatsAppOperation): MessageRef {
  assert.equal(operation.state.status, "succeeded");
  const result = operation.state.result;
  assert.ok(result !== null && typeof result === "object", "send succeeded without a MessageRef");
  const { id, chatId, fromMe, participant } = result as Partial<MessageRef>;
  if (typeof id !== "string" || id.length === 0) throw new Error("send returned no MessageRef id");
  if (typeof chatId !== "string") throw new Error("send returned no MessageRef chatId");
  if (typeof fromMe !== "boolean") throw new Error("send returned no MessageRef fromMe flag");
  if (participant !== undefined && typeof participant !== "string")
    throw new Error("send returned an invalid MessageRef participant");
  return {
    id,
    chatId,
    fromMe,
    ...(participant !== undefined && { participant }),
  };
}

class PeerController {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  readonly observations: PeerObservation[] = [];
  private output = "";
  private waiters: Array<{
    readonly kind: PeerObservation["kind"];
    readonly resolve: (observation: PeerObservation) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }> = [];

  constructor(body: string) {
    this.child = spawn(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url), PEER_ARG],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.HOME && { HOME: process.env.HOME }),
          WA_LOG_LEVEL: "silent",
          [BODY_ENV]: body,
        },
      },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.output += chunk;
      for (
        let newline = this.output.indexOf("\n");
        newline !== -1;
        newline = this.output.indexOf("\n")
      ) {
        const line = this.output.slice(0, newline);
        this.output = this.output.slice(newline + 1);
        const observation = JSON.parse(line) as PeerObservation;
        this.observations.push(observation);
        const waiter = this.waiters.find((candidate) => candidate.kind === observation.kind);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(observation);
      }
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("close", (code) => {
      if (this.waiters.length > 0)
        this.rejectAll(new Error(`peer process exited ${code ?? "without status"}`));
    });
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  waitFor(kind: PeerObservation["kind"]): Promise<PeerObservation> {
    const existing = this.observations.find((observation) => observation.kind === kind);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`peer process did not report ${kind}`));
      }, TIMEOUT_MS);
      this.waiters.push({ kind, resolve, reject, timer });
    });
  }

  async snapshot(): Promise<PeerObservation> {
    const prior = this.observations.filter((observation) => observation.kind === "snapshot").length;
    this.child.stdin.write("snapshot\n");
    return waitFor(() => {
      const snapshots = this.observations.filter((observation) => observation.kind === "snapshot");
      return snapshots.length > prior ? snapshots.at(-1) : undefined;
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.write("close\n");
    await this.waitFor("closed");
    if (this.child.exitCode === null)
      await new Promise<void>((resolve) => this.child.once("close", () => resolve()));
  }
}

async function peerRun(): Promise<void> {
  const body = process.env[BODY_ENV];
  if (!body) throw new Error("peer process has no live-send body");
  const chatId = proofGroupId();
  const bodyHash = sha256(body);
  const peer = await openProfile("ios");
  peer.client.messages.get(chatId);
  const off = peer.client.messages.subscribe(() => {});
  const snapshot = (): PeerObservation => ({
    kind: "snapshot",
    pid: process.pid,
    inboxCount: peer.client.messages.get(chatId).messages.length,
    matchingMessages: matchingMessages(peer.client, chatId, bodyHash).length,
  });
  process.stdout.write(
    `${JSON.stringify({
      kind: "ready",
      pid: process.pid,
      linkMode: peer.link.linkMode,
      inboxCount: snapshot().inboxCount,
      matchingMessages: snapshot().matchingMessages,
      privateIdentity: peer.identity,
    } satisfies PeerObservation)}\n`,
  );

  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    for (let newline = input.indexOf("\n"); newline !== -1; newline = input.indexOf("\n")) {
      const command = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (command === "snapshot") process.stdout.write(`${JSON.stringify(snapshot())}\n`);
      if (command === "close") {
        process.stdout.write(`${JSON.stringify({ kind: "closed", pid: process.pid })}\n`);
        off();
        await peer.close();
        return;
      }
    }
  }
}

function generatedUnlistedGroupId(): string {
  const digits = (length: number): string =>
    Array.from(randomBytes(length), (byte) => String(byte % 10)).join("");
  return `${digits(18)}-${digits(10)}@g.us`;
}

async function parentRun(): Promise<void> {
  const runStart = captureLiveSendProofRunStart(root);
  assert.equal(runStart.treeClean, true, "live send proof requires a clean exact head");
  const body = `whatsappd-live-send:${randomBytes(24).toString("base64url")}`;
  const bodyHash = sha256(body);
  const chatId = proofGroupId();
  const target = resolveAllowlistedTarget(chatId);
  const peer = new PeerController(body);
  const ready = await peer.waitFor("ready");
  assert.equal(ready.linkMode, "resumed", "the peer paired instead of resuming");
  assert.equal(ready.matchingMessages, 0, "the proof body already existed in the peer inbox");

  const subject = await openProfile("android");
  const knownValues = [body, chatId, subject.identity, ready.privateIdentity ?? "", REPLAY_LABEL];
  try {
    assert.equal(subject.link.linkMode, "resumed", "the subject paired instead of resuming");
    subject.client.messages.get(chatId);
    const offMessages = subject.client.messages.subscribe(() => {});
    const statuses: StatusName[] = [];
    try {
      const beforeSend = await peer.snapshot();
      const first = await guardedClientSender(subject.client).text(target, body, {
        idempotencyKey: REPLAY_LABEL,
      });
      let unexpectedStatus: "failed" | "outcome_unknown" | undefined;
      const offOperation = subject.client.operations.subscribe(first.id, (operation) => {
        const status = operation.state.status;
        if (status === "failed" || status === "outcome_unknown") {
          unexpectedStatus = status;
          return;
        }
        if (statuses.at(-1) !== status) statuses.push(status);
      });
      const terminal = await waitFor(async () => {
        const operation = await subject.client.operations.get(first.id);
        return operation?.state.status === "succeeded" ? operation : undefined;
      });
      offOperation();
      assert.equal(
        unexpectedStatus,
        undefined,
        "the live send reached an unexpected terminal state",
      );
      const ref = messageRefOf(terminal);
      assert.equal(ref.chatId, chatId, "the returned MessageRef names another destination");
      assert.equal(ref.fromMe, true, "the returned MessageRef is not an own message");
      knownValues.push(first.id, ref.id);

      const subjectEcho = await waitFor(() => {
        const matching = matchingMessages(subject.client, chatId, bodyHash);
        return matching.length === 1 ? matching[0] : undefined;
      });
      assert.equal(subjectEcho.messageId, ref.id, "the authoritative echo did not reconcile by id");
      const afterSend = await waitFor(async () => {
        const observation = await peer.snapshot();
        return observation.matchingMessages === 1 ? observation : undefined;
      });

      const sendsBeforeReplay = subject.sessionSendInvocations();
      const replay = await guardedClientSender(subject.client).text(target, body, {
        idempotencyKey: REPLAY_LABEL,
      });
      assert.equal(replay.id, first.id, "the replay returned another operation");
      const sendsAfterReplay = subject.sessionSendInvocations();
      assert.equal(
        sendsAfterReplay,
        sendsBeforeReplay,
        "the replay invoked the subject Session send site again",
      );
      await sleep(SETTLE_MS);
      const afterReplay = await peer.snapshot();
      assert.equal(afterReplay.matchingMessages, 1, "the replay delivered another message");
      assert.equal(
        afterReplay.inboxCount,
        afterSend.inboxCount,
        "the peer inbox changed after the idempotent replay",
      );
      const subjectMatches = matchingMessages(subject.client, chatId, bodyHash);
      assert.equal(subjectMatches.length, 1, "the subject retained duplicate authoritative rows");

      const operationsForKey = (await subject.backend.operations.list("android")).filter(
        (operation) => operation.idempotencyKey === REPLAY_LABEL,
      );
      assert.equal(operationsForKey.length, 1, "the idempotency key names multiple operations");
      assert.deepEqual(statuses, ["queued", "claimed", "executing", "succeeded"]);

      const refusedId = generatedUnlistedGroupId();
      knownValues.push(refusedId);
      const beforeRefusal = await peer.snapshot();
      let refusal: SendRefusedError | undefined;
      try {
        resolveAllowlistedTarget(refusedId);
      } catch (error) {
        if (error instanceof SendRefusedError) refusal = error;
        else throw error;
      }
      assert.equal(refusal?.reason, "target_not_allowlisted");
      await sleep(SETTLE_MS);
      const afterRefusal = await peer.snapshot();
      assert.equal(
        afterRefusal.inboxCount,
        beforeRefusal.inboxCount,
        "the peer inbox changed after the guard refused the send",
      );

      const summary = {
        subjectLinkMode: subject.link.linkMode,
        peerLinkMode: ready.linkMode,
        bodySha256: bodyHash,
        bodyLength: Buffer.byteLength(body),
        replayLabelSha256: sha256(REPLAY_LABEL),
        replayLabelLength: REPLAY_LABEL.length,
        operationIdSha256: sha256(first.id),
        operationIdLength: first.id.length,
        statusTimeline: statuses,
        operationCountForKey: operationsForKey.length,
        replayReturnedSameOperation: replay.id === first.id,
        messageRefPresent: true,
        messageRefIdSha256: sha256(ref.id),
        messageRefIdLength: ref.id.length,
        messageRefFromMe: ref.fromMe,
        subjectMatchingMessages: subjectMatches.length,
        subjectMessageRefMatches: subjectEcho.messageId === ref.id,
        peerMatchingMessages: afterReplay.matchingMessages ?? 0,
        peerInboxBeforeSend: beforeSend.inboxCount ?? 0,
        peerInboxAfterSend: afterSend.inboxCount ?? 0,
        peerInboxAfterReplay: afterReplay.inboxCount ?? 0,
        replaySentNothingFurther: sendsAfterReplay === sendsBeforeReplay,
        refusedTargetSha256: sha256(refusedId),
        refusedTargetLength: refusedId.length,
        refusalReason: refusal.reason,
        peerInboxBeforeRefusal: beforeRefusal.inboxCount ?? 0,
        peerInboxAfterRefusal: afterRefusal.inboxCount ?? 0,
        peerInboxUnchanged: afterRefusal.inboxCount === beforeRefusal.inboxCount,
      } satisfies LiveSendProofSummary;
      const receipt = writeLiveSendProofReceipt(root, {
        runStart,
        finalizedAt: new Date().toISOString(),
        summary,
        knownValues,
      });
      process.stdout.write(
        `${JSON.stringify({
          receipt: path.relative(root, receipt.file),
          statusTimeline: summary.statusTimeline,
          operationCountForKey: summary.operationCountForKey,
          peerMatchingMessages: summary.peerMatchingMessages,
          subjectMatchingMessages: summary.subjectMatchingMessages,
          replaySentNothingFurther: summary.replaySentNothingFurther,
          refusalReason: summary.refusalReason,
          peerInboxUnchanged: summary.peerInboxUnchanged,
          schemaUnknownFields: receipt.scan.schemaUnknownFields,
          schemaInvalidFields: receipt.scan.schemaInvalidFields,
          patternHits: receipt.scan.patternHits,
          knownValueHits: receipt.scan.knownValueHits,
          floorPassed: receipt.scan.floorPassed,
        })}\n`,
      );
    } finally {
      offMessages();
    }
  } finally {
    try {
      await subject.close();
    } finally {
      await peer.close();
    }
  }
}

if (process.argv.includes(PEER_ARG)) await peerRun();
else await parentRun();
