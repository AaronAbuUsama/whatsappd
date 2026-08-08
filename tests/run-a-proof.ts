/**
 * Issue #111 Run A exact-head proof.
 *
 * This lane sends one durable outbound text from android, and never retries it.
 * The ios peer supplies the inbound nonce and document in separate processes.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageRecord, MessageRef, WhatsAppOperation } from "../src/index.ts";
import {
  credentialIdentityDigest,
  durableDigest,
  observeInboundDocument,
  observeInboundText,
  openProfile,
  proofGroupId,
  runPeerProcess,
  type OpenProfile,
} from "./client-proof.ts";
import {
  captureRunAProofRunStart,
  writeRunAProofReceipt,
  type RunAMatrixId,
  type RunAMatrixRow,
  type RunAProofObservationStore,
} from "./run-a-proof-receipt.ts";
import { guardedClientSender, resolveAllowlistedTarget } from "./send-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const TIMEOUT_MS = 120_000;
const GROUP_ID_SUFFIX = "06573@g.us";

type StatusName = "queued" | "claimed" | "executing" | "succeeded";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error("Run A timed out before the required observation");
}

function messageRefOf(operation: WhatsAppOperation): MessageRef {
  assert.equal(operation.state.status, "succeeded");
  const result = operation.state.result;
  assert.ok(result !== null && typeof result === "object", "send succeeded without a MessageRef");
  const { id, chatId, fromMe, participant } = result as Partial<MessageRef>;
  if (typeof id !== "string" || id.length === 0) throw new Error("send returned no MessageRef id");
  if (typeof chatId !== "string") throw new Error("send returned no MessageRef chatId");
  if (typeof fromMe !== "boolean") throw new Error("send returned no MessageRef fromMe flag");
  return {
    id,
    chatId,
    fromMe,
    ...(typeof participant === "string" && { participant }),
  };
}

function matchingText(
  subject: OpenProfile,
  chatId: string,
  bodySha256: string,
): readonly Extract<MessageRecord, { kind: "text" }>[] {
  return subject.client.messages
    .get(chatId)
    .messages.filter(
      (message): message is Extract<MessageRecord, { kind: "text" }> =>
        message.kind === "text" && sha256(message.text) === bodySha256,
    );
}

function stageRows(
  rows: readonly RunAMatrixRow[],
  failedId: RunAMatrixId,
  stage: RunAMatrixRow["evidence"]["stage"],
): RunAMatrixRow[] {
  const ordered: readonly RunAMatrixId[] = [
    "resume-unattended",
    "inbound-text",
    "inbound-document",
    "attachment-bytes",
    "outbound-durable-send",
    "saved-state",
    "process-replacement",
  ];
  const failedIndex = ordered.indexOf(failedId);
  const completed = new Set(rows.map(({ id }) => id));
  return [
    ...rows,
    ...ordered
      .filter((id) => !completed.has(id))
      .map(
        (id): RunAMatrixRow => ({
          id,
          verdict:
            id === failedId
              ? "failed"
              : ordered.indexOf(id) > failedIndex
                ? "not_observed"
                : "failed",
          captureSite: "run-stage-verdict",
          evidence: { stage },
        }),
      ),
  ];
}

async function main(): Promise<void> {
  if (process.stdin.isTTY)
    throw new Error("Run A refuses an interactive TTY; run it with stdin closed");
  const runStart = captureRunAProofRunStart(root);
  if (!runStart.treeClean)
    throw new Error("Run A refuses a dirty tree before opening either linked account");

  const rows: RunAMatrixRow[] = [];
  const knownValues: string[] = [];
  let subject: OpenProfile | undefined;
  let failedId: RunAMatrixId = "resume-unattended";
  let stage: RunAMatrixRow["evidence"]["stage"] = "subject-open";
  let sendLanded = false;
  let finalizedRows: readonly RunAMatrixRow[] | undefined;

  try {
    const chatId = proofGroupId();
    assert.equal(
      chatId.endsWith(GROUP_ID_SUFFIX),
      true,
      "Run A target is not the owner-approved Tst group",
    );
    knownValues.push(chatId);

    subject = await openProfile("android");
    knownValues.push(subject.identity);
    assert.equal(subject.link.linkMode, "resumed", "the subject paired instead of resuming");
    rows.push({
      id: "resume-unattended",
      verdict: "observed",
      captureSite: "subject-runtime-events",
      evidence: {
        linkMode: subject.link.linkMode,
        challengeEventCount: subject.link.challengeEventCount,
        challengeProduced: subject.link.challengeEventCount > 0,
        interactive: false,
        subjectPid: process.pid,
      },
    });

    failedId = "inbound-text";
    stage = "inbound-text";
    let textPeer: Awaited<ReturnType<typeof runPeerProcess>> | undefined;
    const text = await observeInboundText({
      client: subject.client,
      chatId,
      async send() {
        textPeer = await runPeerProcess({ mode: "send-text" });
        if (textPeer.sent?.kind !== "text") throw new Error("peer returned no text proof");
        return textPeer.sent;
      },
    });
    const nonce = textPeer?.privateKnownValues?.nonce;
    const peerJid = textPeer?.privateKnownValues?.peerJid;
    if (!nonce || !peerJid || !textPeer?.link)
      throw new Error("inbound text proof returned no private controls");
    knownValues.push(nonce, peerJid);
    rows.push({
      id: "inbound-text",
      verdict: "observed",
      captureSite: text.observedVia === "live-upsert" ? "client-live-upsert" : "client-stored-page",
      evidence: {
        ...text,
        peerPid: textPeer.pid,
        peerLinkMode: textPeer.link.linkMode,
      },
    });

    failedId = "inbound-document";
    stage = "inbound-document";
    let documentPeer: Awaited<ReturnType<typeof runPeerProcess>> | undefined;
    const document = await observeInboundDocument({
      accountId: "android",
      client: subject.client,
      media: subject.media,
      chatId,
      async send() {
        documentPeer = await runPeerProcess({ mode: "send-document" });
        if (documentPeer.sent?.kind !== "document")
          throw new Error("peer returned no document proof");
        return documentPeer.sent;
      },
    });
    if (!documentPeer?.link) throw new Error("document proof returned no link observation");
    rows.push(
      {
        id: "inbound-document",
        verdict: "observed",
        captureSite: "client-message-record",
        evidence: {
          kind: document.kind,
          mediaState: document.mediaState,
          byteLength: document.byteLength,
          byteLengthMatches: document.byteLengthMatches,
          peerPid: documentPeer.pid,
          peerLinkMode: documentPeer.link.linkMode,
        },
      },
      {
        id: "attachment-bytes",
        verdict: "observed",
        captureSite: "client-media-read",
        evidence: {
          sentSha256: document.sentSha256,
          storedSha256: document.storedSha256,
          equal: document.equal,
        },
      },
    );

    failedId = "outbound-durable-send";
    stage = "outbound-durable-send";
    const body = `whatsappd-run-a:${randomBytes(24).toString("base64url")}`;
    const idempotencyKey = `run-a-${randomBytes(16).toString("hex")}`;
    knownValues.push(body, idempotencyKey);
    const bodyHash = sha256(body);
    subject.client.messages.get(chatId);
    const offMessages = subject.client.messages.subscribe(() => {});
    const target = resolveAllowlistedTarget(chatId);
    const statuses: StatusName[] = [];
    const sendsBefore = subject.sessionSendInvocations();
    try {
      assert.equal(
        chatId.endsWith(GROUP_ID_SUFFIX),
        true,
        "Run A target changed after allowlist resolution",
      );
      const operation = await guardedClientSender(subject.client).text(target, body, {
        idempotencyKey,
      });
      sendLanded = subject.sessionSendInvocations() === sendsBefore + 1;
      knownValues.push(operation.id);
      if (
        operation.state.status !== "failed" &&
        operation.state.status !== "outcome_unknown" &&
        statuses.at(-1) !== operation.state.status
      )
        statuses.push(operation.state.status);
      let unexpected: "failed" | "outcome_unknown" | undefined;
      const offOperation = subject.client.operations.subscribe(operation.id, (current) => {
        const status = current.state.status;
        if (status === "failed" || status === "outcome_unknown") unexpected = status;
        else if (statuses.at(-1) !== status) statuses.push(status);
      });
      const terminal = await waitFor(async () => {
        const current = await subject?.client.operations.get(operation.id);
        return current?.state.status === "succeeded" ? current : undefined;
      });
      offOperation();
      assert.equal(unexpected, undefined, "the outbound operation reached a failed terminal state");
      const ref = messageRefOf(terminal);
      knownValues.push(ref.id);
      assert.equal(ref.chatId, chatId, "the outbound MessageRef names another destination");
      const echo = await waitFor(() => {
        const matches = subject ? matchingText(subject, chatId, bodyHash) : [];
        return matches.length === 1 ? matches[0] : undefined;
      });
      assert.equal(echo.messageId, ref.id, "authoritative echo did not reconcile by id");
      assert.deepEqual(statuses, ["queued", "claimed", "executing", "succeeded"]);
      rows.push({
        id: "outbound-durable-send",
        verdict: "observed",
        captureSite: "android-client-operation-and-authoritative-echo",
        evidence: {
          targetKind: "allowlisted-group",
          bodySha256: bodyHash,
          bodyLength: Buffer.byteLength(body),
          idempotencyKeySha256: sha256(idempotencyKey),
          idempotencyKeyLength: idempotencyKey.length,
          operationIdSha256: sha256(operation.id),
          operationIdLength: operation.id.length,
          statusTimeline: statuses,
          terminalStatus: terminal.state.status,
          messageRefIdSha256: sha256(ref.id),
          messageRefIdLength: ref.id.length,
          messageRefFromMe: ref.fromMe,
          messageRefChatMatchesTarget: ref.chatId === chatId,
          authoritativeEchoCount: 1,
          sessionSendInvocationsBefore: sendsBefore,
          sessionSendInvocationsAfter: subject.sessionSendInvocations(),
        },
      });
    } finally {
      offMessages();
    }

    failedId = "saved-state";
    stage = "subject-close";
    const salt = randomBytes(16).toString("hex");
    const durableBeforeReplacement = await durableDigest({
      client: subject.client,
      media: subject.media,
      accountId: "android",
      chatId,
      salt,
    });
    const originalCredentialIdentityDigest = await credentialIdentityDigest(
      subject.backend.credentials,
      salt,
    );
    const closeOrder: string[] = [];
    await subject.client.close();
    closeOrder.push("client");
    await subject.runtime.stop();
    closeOrder.push("runtime");
    await subject.backend.close();
    closeOrder.push("backend");
    subject = undefined;
    rows.push({
      id: "saved-state",
      verdict: "observed",
      captureSite: "subject-client-runtime-backend-close",
      evidence: { closeOrder, durableDigest: durableBeforeReplacement },
    });

    failedId = "process-replacement";
    stage = "cold-replacement";
    const replacementProcess = await runPeerProcess({
      mode: "replacement",
      identityHashSalt: salt,
      originalCredentialIdentityDigest,
      timeoutMs: TIMEOUT_MS,
    });
    const replacement = replacementProcess.replacement;
    if (!replacement) throw new Error("replacement child returned no observation");
    stage = "durable-comparison";
    assert.deepEqual(
      replacement.durableDigest,
      durableBeforeReplacement,
      "replacement reconstructed a different durable digest",
    );
    rows.push({
      id: "process-replacement",
      verdict: "observed",
      captureSite: "replacement-child-result",
      evidence: {
        replacementPid: replacementProcess.pid,
        distinctPid: replacementProcess.pid !== process.pid,
        durableDigestEqual: true,
        credentialIdentityMatchesOriginal: replacement.credentialIdentityMatchesOriginal,
        sessionAttached: replacement.sessionAttached,
        liveSocketResumed: replacement.liveSocketResumed,
        durableReconstructedWhileNoLive: replacement.durableReconstructedWhileNoLive,
        connectionPresent: replacement.connectionPresent,
        identityPresent: replacement.identityPresent,
        presenceObservationsRestored: replacement.presenceObservationsRestored,
        lastConnectedAtPresent: replacement.lastConnectedAtPresent,
        lastDisconnectedAtPresent: replacement.lastDisconnectedAtPresent,
      },
    });
    finalizedRows = rows;
  } catch {
    finalizedRows = stageRows(rows, failedId, stage);
  } finally {
    await subject?.close().catch(() => {});
  }

  if (!finalizedRows || knownValues.length < 3)
    throw new Error("Run A ended before a receipt-safe observation store could be finalized");
  const store = {
    runStart,
    finalizedAt: new Date().toISOString(),
    knownValues,
    rows: finalizedRows,
  } satisfies RunAProofObservationStore;
  const privateStore = path.join(
    root,
    ".proof-private",
    `issue111-run-a-${runStart.gitHead.slice(0, 7)}.json`,
  );
  writeFileSync(privateStore, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx" });
  const receipt = writeRunAProofReceipt(root, store);
  process.stdout.write(
    `${JSON.stringify({
      receipt: path.relative(root, receipt.file),
      sendLanded,
      verdicts: finalizedRows.map(({ id, verdict }) => ({ id, verdict })),
      schemaUnknownFields: receipt.scan.schemaUnknownFields,
      schemaInvalidFields: receipt.scan.schemaInvalidFields,
      patternHits: receipt.scan.patternHits,
      knownValueHits: receipt.scan.knownValueHits,
      floorPassed: receipt.scan.floorPassed,
    })}\n`,
  );
  if (finalizedRows.some(({ verdict }) => verdict !== "observed")) process.exitCode = 1;
}

await main();
