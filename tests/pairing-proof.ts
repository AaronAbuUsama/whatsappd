/**
 * Unattended #109 Run A proof.
 *
 * Run with stdin closed:
 *
 *   pnpm proof:pairing < /dev/null
 *
 * The fresh profile is created under the gitignored proof directory. The
 * durable android profile is resumed, never deleted, never paired, and never
 * used to send.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import {
  AccountAlreadyLinkedError,
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  memoryBackend,
  type WhatsAppClient,
} from "../src/index.ts";
import { createWhatsAppRuntimeForTesting } from "../src/testing.ts";
import { capturePairingProofRunStart, writePairingProofReceipt } from "./client-proof-receipt.ts";
import {
  createPairingChallengeObserver,
  runSyntheticPairingChallengeObserverControl,
} from "./pairing-proof-observer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const proofRoot = path.join(root, ".proof-private");
const runStart = capturePairingProofRunStart(root, fileURLToPath(import.meta.url));
const observationMs = 10_250;
const onlineTimeoutMs = 90_000;
type Phase = "fresh" | "control" | "linked";

const counts = {
  fresh: { net: 0 },
  control: { net: 0 },
  linked: { net: 0 },
};
let phase: Phase = "fresh";

function countSocket(socket: Socket | undefined, observed: Phase): void {
  // Count at creation rather than at connect. A refused non-loopback attempt
  // has no remoteAddress but is still an outbound socket, so waiting for
  // `connect` would make the zero assertion false-green. Counting loopback too
  // is a conservative strengthening of the required non-loopback count.
  if (socket) counts[observed].net += 1;
}

async function exerciseNativeNetDiagnostics(): Promise<void> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(address.port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const netChannel = diagnosticsChannel.channel("net.client.socket");
const onNet = (message: unknown): void => {
  const event = message as { readonly socket?: Socket };
  countSocket(event.socket, phase);
};
netChannel.subscribe(onNet);
assert.equal(netChannel.hasSubscribers, true);
if (process.stdin.isTTY) throw new Error("pairing proof requires closed stdin");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const observedZero = (value: number): 0 => {
  assert.equal(value, 0);
  return 0;
};
const observedFalse = (value: boolean): false => {
  assert.equal(value, false);
  return false;
};
const observedTrue = (value: boolean): true => {
  assert.equal(value, true);
  return true;
};
const observedResumed = (value: "resumed" | "paired"): "resumed" => {
  assert.equal(value, "resumed");
  return "resumed";
};

async function waitForOnline(client: WhatsAppClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const phases = new Set<string>();
    const finish = (): void => {
      if (finished) return;
      const account = client.account.get();
      const connection = account.connection;
      phases.add(connection?.phase ?? (account.closed ? "closed" : "none"));
      if (connection?.phase !== "online") return;
      finished = true;
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      off();
      reject(
        new Error(
          `timed out waiting for the linked account to become online (${[...phases].join(",")})`,
        ),
      );
    }, onlineTimeoutMs);
    const off = client.account.subscribe(finish);
    finish();
  });
}

const freshDirectory = mkdtempSync(path.join(proofRoot, "m4-needs-pairing-"));
let freshClient: WhatsAppClient | undefined;
let freshRuntime: ReturnType<typeof createWhatsAppRuntime> | undefined;
let freshBackend: ReturnType<typeof libsqlBackend> | undefined;
let linkedClient: WhatsAppClient | undefined;
let linkedRuntime: ReturnType<typeof createWhatsAppRuntime> | undefined;
let linkedBackend: ReturnType<typeof libsqlBackend> | undefined;

try {
  const syntheticChallengeObserverControl = runSyntheticPairingChallengeObserverControl();
  assert.equal(syntheticChallengeObserverControl.kind, "synthetic");
  assert.ok(syntheticChallengeObserverControl.challengeEventCount >= 1);

  const deterministicBackend = memoryBackend();
  let deterministicOpenCalls = 0;
  const deterministicRuntime = createWhatsAppRuntimeForTesting(
    { accountId: "fresh-pairing-proof-control", backend: deterministicBackend },
    {
      async registration() {
        return "unregistered";
      },
      async open() {
        deterministicOpenCalls += 1;
        throw new Error("the deterministic needs-pairing control must not open a Session");
      },
    },
  );
  await deterministicRuntime.start();
  const deterministicClient = await createWhatsAppClient(deterministicRuntime);
  try {
    assert.deepEqual(deterministicClient.account.get().link, { status: "needs_pairing" });
    assert.equal(deterministicOpenCalls, 0);
  } finally {
    await deterministicClient.close();
    await deterministicRuntime.stop();
  }

  const freshMedia = fileMediaStore({ directory: freshDirectory });
  freshBackend = libsqlBackend({
    url: `file:${path.join(freshDirectory, "whatsapp.db")}`,
    accountId: "fresh-pairing-proof",
    media: freshMedia,
  });
  freshRuntime = createWhatsAppRuntime({
    accountId: "fresh-pairing-proof",
    backend: freshBackend,
  });
  await freshRuntime.start();
  freshClient = await createWhatsAppClient(freshRuntime);
  assert.deepEqual(freshClient.account.get().link, { status: "needs_pairing" });
  if (process.env.PAIRING_PROOF_CONTROL === "socket") {
    const canary = { remoteAddress: "192.0.2.1" } as Socket;
    netChannel.publish({ socket: canary });
  }
  await delay(observationMs);
  assert.equal(counts.fresh.net, 0);

  phase = "control";
  await exerciseNativeNetDiagnostics();
  assert.ok(counts.control.net > 0);

  await freshClient.close();
  freshClient = undefined;
  await freshRuntime.stop();
  freshRuntime = undefined;
  await freshBackend.close();
  freshBackend = undefined;

  phase = "linked";
  const linkedDirectory = path.join(proofRoot, "android");
  const linkedMedia = fileMediaStore({ directory: linkedDirectory });
  linkedBackend = libsqlBackend({
    url: `file:${path.join(linkedDirectory, "whatsapp.db")}`,
    accountId: "android",
    media: linkedMedia,
  });
  linkedRuntime = createWhatsAppRuntime({
    accountId: "android",
    backend: linkedBackend,
  });
  linkedClient = await createWhatsAppClient(linkedRuntime);

  const challengeObserver = createPairingChallengeObserver(
    () => linkedClient?.account.get().connection,
  );
  const offLink = linkedClient.account.subscribe(() => challengeObserver.observe());
  challengeObserver.observe();
  const linkedStartedAt = Date.now();
  await linkedRuntime.start();
  await waitForOnline(linkedClient);
  offLink();

  const resumeMs = Date.now() - linkedStartedAt;
  const challengeEventCount = challengeObserver.count();
  const linkMode: "resumed" | "paired" = challengeEventCount === 0 ? "resumed" : "paired";
  assert.equal(challengeEventCount, 0);
  assert.equal(linkMode, "resumed");
  assert.deepEqual(linkedClient.account.get().link, { status: "linked" });
  const pairOperationsBefore = (await linkedBackend.operations.list("android")).filter(
    (operation) => operation.input.type === "pair",
  ).length;
  const socketsBeforePair = counts.linked.net;
  await assert.rejects(
    linkedClient.account.pair({ method: "qr" }),
    (error: unknown) => error instanceof AccountAlreadyLinkedError,
  );
  await delay(250);
  const pairOperationsAfter = (await linkedBackend.operations.list("android")).filter(
    (operation) => operation.input.type === "pair",
  ).length;
  assert.equal(pairOperationsAfter, pairOperationsBefore);
  assert.equal(counts.linked.net, socketsBeforePair);
  assert.equal(linkedClient.account.get().connection?.phase, "online");

  const summary = {
    interactive: false,
    freshLinkState: "needs_pairing" as const,
    observationMs,
    netSocketCountBeforePair: counts.fresh.net,
    netSocketCounterControlCount: counts.control.net,
    deterministicOpenCalls,
    syntheticChallengeObserverControl,
    linked: {
      linkMode,
      resumeMs,
      challengeEventCount,
      challengeProduced: challengeEventCount > 0,
      pairOperationCount: pairOperationsAfter - pairOperationsBefore,
      secondSocketCount: counts.linked.net - socketsBeforePair,
      sessionStillOnline: linkedClient.account.get().connection?.phase === "online",
    },
  };
  console.log(JSON.stringify(summary));
  if (process.env.PAIRING_PROOF_RECEIPT === "1") {
    const receipt = writePairingProofReceipt(root, {
      runStart,
      finalizedAt: new Date().toISOString(),
      knownValues: [randomUUID(), randomUUID(), freshDirectory],
      summary: {
        interactive: observedFalse(summary.interactive),
        freshLinkState: summary.freshLinkState,
        observationMs: summary.observationMs,
        netSocketCount: observedZero(summary.netSocketCountBeforePair),
        netControlCount: summary.netSocketCounterControlCount,
        deterministicOpenCalls: observedZero(summary.deterministicOpenCalls),
        syntheticChallengeObserverControl: {
          kind: summary.syntheticChallengeObserverControl.kind,
          challengeEventCount: summary.syntheticChallengeObserverControl.challengeEventCount,
        },
        linkMode: observedResumed(summary.linked.linkMode),
        resumeMs: summary.linked.resumeMs,
        challengeEventCount: observedZero(summary.linked.challengeEventCount),
        challengeProduced: observedFalse(summary.linked.challengeProduced),
        pairOperationCount: observedZero(summary.linked.pairOperationCount),
        secondSocketCount: observedZero(summary.linked.secondSocketCount),
        sessionStillOnline: observedTrue(summary.linked.sessionStillOnline),
      },
    });
    console.log(
      JSON.stringify({
        receipt: path.relative(root, receipt.file),
        sanitization: receipt.scan,
      }),
    );
  }
} finally {
  await linkedClient?.close().catch(() => {});
  await linkedRuntime?.stop().catch(() => {});
  await linkedBackend?.close().catch(() => {});
  await freshClient?.close().catch(() => {});
  await freshRuntime?.stop().catch(() => {});
  await freshBackend?.close().catch(() => {});
  netChannel.unsubscribe(onNet);
  rmSync(freshDirectory, { recursive: true, force: true });
}
