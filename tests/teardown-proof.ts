/**
 * Live iOS teardown proof for deliberate-stop draining.
 *
 * Prints only counts and booleans. It never sends, reads message content, or
 * records account identifiers from the mirror.
 */
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  AccountNotHeldError,
  createSession,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  type AccountLeaseStore,
  type CredentialStore,
  type WhatsAppBackend,
  type WhatsAppSessionHandlers,
} from "../src/index.ts";
import { createTestWhatsAppRuntime, createTestWhatsAppSession } from "../src/testing.ts";
import { captureTeardownProofRunStart, writeTeardownProofReceipt } from "./client-proof-receipt.ts";
import {
  assertDurableReplayTeardownObservation,
  assertSyntheticTeardownControl,
  type LeaseLossGuardSummary,
  type TeardownProofKind,
  type TeardownProofSummary,
} from "./teardown-proof-summary.ts";

const requiredStops = 10;
const syntheticAttempts = Number(process.env.SYNTHETIC_STOP_ATTEMPTS ?? String(requiredStops));
const replayAttempts = Number(process.env.REPLAY_STOP_ATTEMPTS ?? String(requiredStops));
const mode = process.env.TEARDOWN_PROOF_MODE ?? "all";
if (
  !Number.isSafeInteger(syntheticAttempts) ||
  syntheticAttempts < requiredStops ||
  !Number.isSafeInteger(replayAttempts) ||
  replayAttempts < requiredStops ||
  !["all", "synthetic", "replay"].includes(mode)
)
  throw new Error("invalid teardown proof configuration");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const directory = path.join(root, ".proof-private", "ios");
const proofRoot = path.join(root, ".proof-private");
const runStart = captureTeardownProofRunStart(root, fileURLToPath(import.meta.url));
const knownValues = new Set<string>();
const limitation =
  "History-sync-origin in-flight work was not observed on the already-linked iOS profile because socket.ts:166 emits conversation_sync only for a non-empty messaging-history.set batch, and WhatsApp delivers that history once at initial link. The drained work used real already-durable iOS mirror rows replayed through the production serial event pipeline, not a fresh history sync.";

interface StopAttempt {
  readonly inFlightAtStop: number;
  readonly stopFailed: boolean;
  readonly stopPendingWhileHeld: boolean;
  readonly syncAccepted: boolean;
  readonly leaseHeldWhileDraining: boolean;
  readonly leaseFreeAfterStop: boolean;
  readonly challengeProduced: boolean;
  readonly durableRowsReplayed: number;
  readonly historySyncOriginObserved: boolean;
}

async function runStopAttempt(kind: TeardownProofKind, attempt: number): Promise<StopAttempt> {
  const media = fileMediaStore({ directory });
  const base = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: "ios",
    media,
  });
  const replayChats =
    kind === "durable_replay_observation"
      ? (await base.data.snapshot("ios")).chats.slice(0, 8).map((chat) => ({
          id: chat.chatId,
          ...(chat.subject !== undefined && { subject: chat.subject }),
          isGroup: chat.isGroup,
          lastMessageAt: chat.lastMessageAt,
        }))
      : [];
  if (kind === "durable_replay_observation" && replayChats.length === 0)
    throw new Error("the durable replay observation found no real iOS mirror rows");
  for (const chat of replayChats.slice(0, 3)) knownValues.add(chat.id);
  let activeSync = 0;
  let syncAccepted = false;
  let challengeProduced = false;
  let historySyncOriginObserved = false;
  let releaseSync!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  let entered!: () => void;
  const syncEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let holding = true;
  const backend: WhatsAppBackend = {
    ...base,
    data: {
      ...base.data,
      async accept(accountId, event, fencingToken) {
        if (!event.some((item) => item.event.type === "conversation_sync") || !holding)
          return base.data.accept(accountId, event, fencingToken);
        holding = false;
        activeSync += 1;
        entered();
        try {
          await held;
          const accepted = await base.data.accept(accountId, event, fencingToken);
          syncAccepted = true;
          return accepted;
        } finally {
          activeSync -= 1;
        }
      },
    },
  };
  const runtime = createTestWhatsAppRuntime({
    accountId: "ios",
    backend,
    openSession(credentials: CredentialStore) {
      const session = createSession({
        store: credentials,
        auth: qrAuth(),
        logger: pino({ level: "silent" }),
      });
      return {
        ...session,
        subscribe(handlers: WhatsAppSessionHandlers) {
          let injectingControl = false;
          const conversationSync: WhatsAppSessionHandlers["conversationSync"] = async (batch) => {
            if (!injectingControl && batch.context.source !== "unknown")
              historySyncOriginObserved = true;
            await handlers.conversationSync?.(batch);
          };
          return session.subscribe({
            ...handlers,
            conversationSync,
            async connection(status) {
              if (status.phase === "pairing" && status.pairing.step === "challenge_live")
                challengeProduced = true;
              await handlers.connection?.(status);
              if (status.phase !== "online") return;
              injectingControl = true;
              try {
                if (kind === "synthetic_regression_control") {
                  // Kept exactly as a fast, empty regression control. It is
                  // labelled synthetic and never counts toward either floor.
                  await conversationSync?.({
                    context: { source: "recent", projection: { mode: "upsert" } },
                    chats: [],
                    contacts: [],
                    messages: [],
                  });
                } else {
                  // Real, already-durable rows from the iOS mirror are offered
                  // again through the production serial Session handler. This
                  // proves draining real queued storage work, not fresh
                  // WhatsApp history delivery.
                  await conversationSync?.({
                    context: { source: "unknown", projection: { mode: "upsert" } },
                    chats: replayChats,
                    contacts: [],
                    messages: [],
                  });
                }
              } finally {
                injectingControl = false;
              }
            },
          });
        },
      };
    },
  });

  let atStop = 0;
  let stopFailed = false;
  let pendingWhileHeld = false;
  let heldWhileDraining = false;
  let freeAfterStop = false;
  try {
    await runtime.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      syncEntered.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 90_000);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    atStop = activeSync;
    if (!observed) {
      releaseSync();
      try {
        await runtime.stop();
      } catch {
        stopFailed = true;
      }
    } else {
      let stopSettled = false;
      const stopping = runtime.stop();
      void stopping.then(
        () => {
          stopSettled = true;
        },
        () => {
          stopSettled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      pendingWhileHeld = !stopSettled;
      const competing = await base.leases.acquire(
        "ios",
        `teardown-proof-control-${kind}-${attempt}`,
        30_000,
      );
      if (!competing.acquired) heldWhileDraining = true;
      else await base.leases.release(competing.lease);
      releaseSync();
      try {
        await stopping;
        const replacement = await base.leases.acquire(
          "ios",
          `teardown-proof-replacement-${kind}-${attempt}`,
          30_000,
        );
        if (replacement.acquired) {
          freeAfterStop = true;
          await base.leases.release(replacement.lease);
        }
      } catch {
        stopFailed = true;
      }
    }
  } finally {
    releaseSync();
    await runtime.stop().catch(() => {});
    await base.close();
  }
  return {
    inFlightAtStop: atStop,
    stopFailed,
    stopPendingWhileHeld: pendingWhileHeld,
    syncAccepted,
    leaseHeldWhileDraining: heldWhileDraining,
    leaseFreeAfterStop: freeAfterStop,
    challengeProduced,
    durableRowsReplayed: replayChats.length,
    historySyncOriginObserved,
  };
}

async function runLeaseLossGuard(): Promise<LeaseLossGuardSummary> {
  const guardDirectory = mkdtempSync(path.join(proofRoot, "teardown-lease-loss-"));
  const media = fileMediaStore({ directory: guardDirectory });
  const base = libsqlBackend({
    url: `file:${path.join(guardDirectory, "whatsapp.db")}`,
    accountId: "teardown-lease-loss-control",
    media,
  });
  let renewalLost!: () => void;
  const lost = new Promise<void>((resolve) => {
    renewalLost = resolve;
  });
  const leases: AccountLeaseStore = {
    ...base.leases,
    async renew() {
      renewalLost();
      return { renewed: false, reason: "lost" };
    },
  };
  const backend: WhatsAppBackend = { ...base, leases };
  const driver = createTestWhatsAppSession();
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let emission: Promise<void> | undefined;
  const runtime = createTestWhatsAppRuntime({
    accountId: "teardown-lease-loss-control",
    backend,
    leaseTtlMs: 20,
    openSession: () => ({
      ...driver.session,
      async stop() {
        await emission;
        await driver.session.stop?.();
      },
    }),
  });
  try {
    await runtime.start();
    const mirrorRevisionBefore = (await base.data.snapshot("teardown-lease-loss-control")).revision;
    emission = driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "recent", projection: { mode: "upsert" } },
        chats: [],
        contacts: [],
        messages: [
          {
            id: "lease-loss-proof-message",
            chatId: "lease-loss-proof-chat",
            sender: { id: "lease-loss-proof-sender", mode: "pn" },
            fromMe: false,
            timestamp: 1,
            live: false,
            isGroup: false,
            kind: "image",
            media: {
              mimetype: "image/png",
              download: async () => {
                entered();
                await held;
                return Buffer.from("lease-loss-guard-marker");
              },
            },
          },
        ],
      },
    });
    await inFlight;
    await Promise.race([
      lost,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("lease-loss control did not observe renewal loss")),
          1_000,
        ),
      ),
    ]);
    release();
    let rejectionObserved = false;
    try {
      await emission;
    } catch (error) {
      for (let current: unknown = error; current; ) {
        if (current instanceof AccountNotHeldError) {
          rejectionObserved = true;
          break;
        }
        current =
          typeof current === "object" && current !== null && "cause" in current
            ? (current as { readonly cause?: unknown }).cause
            : undefined;
      }
    }
    await runtime.stop().catch(() => {});
    const mirrorRevisionAfter = (await base.data.snapshot("teardown-lease-loss-control")).revision;
    return {
      lossKind: "renewal_lost",
      rejectionObserved,
      mirrorRevisionBefore,
      mirrorRevisionAfter,
      mirrorUnchanged: mirrorRevisionAfter === mirrorRevisionBefore,
    };
  } finally {
    release();
    await runtime.stop().catch(() => {});
    await base.close();
    rmSync(guardDirectory, { recursive: true, force: true });
  }
}

async function observeStops(
  kind: TeardownProofKind,
  attemptBudget: number,
  leaseLossGuard?: LeaseLossGuardSummary,
): Promise<TeardownProofSummary> {
  const attempts: StopAttempt[] = [];
  for (let attempt = 1; attempt <= attemptBudget; attempt++)
    attempts.push(await runStopAttempt(kind, attempt));
  const inFlightAtStop = attempts.map((attempt) => attempt.inFlightAtStop);
  const durableRowsReplayed = attempts.map((attempt) => attempt.durableRowsReplayed);
  const qualifyingStops = inFlightAtStop.filter((count) => count >= 1).length;
  return {
    kind,
    attemptBudget,
    qualifyingStops,
    totalStops: attempts.length,
    unqualifiedStops: attempts.length - qualifyingStops,
    stopFailures: attempts.filter((attempt) => attempt.stopFailed).length,
    inFlightAtStop,
    stopPendingWhileHeld: attempts.filter((attempt) => attempt.stopPendingWhileHeld).length,
    syncAcceptances: attempts.filter((attempt) => attempt.syncAccepted).length,
    leaseHeldWhileDraining: attempts.filter((attempt) => attempt.leaseHeldWhileDraining).length,
    leaseFreeAfterStop: attempts.filter((attempt) => attempt.leaseFreeAfterStop).length,
    challengeProduced: attempts.some((attempt) => attempt.challengeProduced),
    countsTowardNativeFloor: false,
    countsTowardReplacementFloor: kind === "durable_replay_observation",
    durableRowsReplayed,
    historySyncOriginObserved: attempts.some((attempt) => attempt.historySyncOriginObserved),
    ...(leaseLossGuard && { leaseLossGuard }),
  };
}

const output: {
  syntheticRegressionControl?: TeardownProofSummary;
  durableReplayObservation?: TeardownProofSummary;
  limitation: string;
} = {
  limitation,
};
if (mode === "all" || mode === "synthetic") {
  const synthetic = await observeStops("synthetic_regression_control", syntheticAttempts);
  assertSyntheticTeardownControl(synthetic, requiredStops);
  output.syntheticRegressionControl = synthetic;
}
if (mode === "all" || mode === "replay") {
  const guard = await runLeaseLossGuard();
  const replay = await observeStops("durable_replay_observation", replayAttempts, guard);
  assertDurableReplayTeardownObservation(replay, requiredStops);
  output.durableReplayObservation = replay;
}
console.log(JSON.stringify(output));
if (process.env.TEARDOWN_PROOF_RECEIPT === "1") {
  if (!output.syntheticRegressionControl || !output.durableReplayObservation)
    throw new Error("a teardown receipt requires TEARDOWN_PROOF_MODE=all");
  const receipt = writeTeardownProofReceipt(root, {
    runStart,
    finalizedAt: new Date().toISOString(),
    knownValues: [...knownValues],
    limitation,
    syntheticRegressionControl: output.syntheticRegressionControl,
    durableReplayObservation: output.durableReplayObservation,
  });
  console.log(
    JSON.stringify({
      receipt: path.relative(root, receipt.file),
      sanitization: receipt.scan,
    }),
  );
}
