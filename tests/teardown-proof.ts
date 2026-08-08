/**
 * Live iOS teardown proof for the deliberate-stop conversation-sync race.
 *
 * Prints only counts and booleans. It never sends, reads message content, or
 * records account identifiers from the mirror.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  createSession,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  type CredentialStore,
  type WhatsAppBackend,
  type WhatsAppSessionHandlers,
} from "../src/index.ts";
import { createTestWhatsAppRuntime } from "../src/testing.ts";
import { assertTeardownProofSummary } from "./teardown-proof-summary.ts";

const requiredStops = Number(process.env.STOP_ATTEMPTS ?? "10");
if (!Number.isSafeInteger(requiredStops) || requiredStops < 10)
  throw new Error("STOP_ATTEMPTS must be an integer of at least 10");

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.join(here, "..", ".proof-private", "ios");
const timeoutMs = 90_000;
let qualifyingStops = 0;
let stopFailures = 0;
let challengeEvents = 0;
let attempts = 0;
let stopPendingWhileHeld = 0;
let syncAcceptances = 0;
let leaseHeldWhileDraining = 0;
let leaseFreeAfterStop = 0;
const inFlightAtStop: number[] = [];

while (qualifyingStops < requiredStops && attempts < requiredStops * 2) {
  attempts += 1;
  const media = fileMediaStore({ directory });
  const base = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: "ios",
    media,
  });
  let activeSync = 0;
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
          syncAcceptances += 1;
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
          return session.subscribe({
            ...handlers,
            async connection(status) {
              if (status.phase === "pairing" && status.pairing.step === "challenge_live")
                challengeEvents += 1;
              await handlers.connection?.(status);
              // Every resumed iOS Session contributes one deterministic batch
              // through the same serial event pipeline as native history sync.
              if (status.phase === "online")
                await handlers.conversationSync?.({
                  context: { source: "recent", projection: { mode: "upsert" } },
                  chats: [],
                  contacts: [],
                  messages: [],
                });
            },
          });
        },
      };
    },
  });

  try {
    await runtime.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      syncEntered.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!observed) {
      inFlightAtStop.push(activeSync);
      releaseSync();
      await runtime.stop();
      continue;
    }
    inFlightAtStop.push(activeSync);
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
    if (!stopSettled) stopPendingWhileHeld += 1;
    const competing = await base.leases.acquire(
      "ios",
      `teardown-proof-control-${attempts}`,
      30_000,
    );
    if (!competing.acquired) leaseHeldWhileDraining += 1;
    else await base.leases.release(competing.lease);
    releaseSync();
    try {
      await stopping;
      const replacement = await base.leases.acquire(
        "ios",
        `teardown-proof-replacement-${attempts}`,
        30_000,
      );
      if (replacement.acquired) {
        leaseFreeAfterStop += 1;
        await base.leases.release(replacement.lease);
      }
    } catch {
      stopFailures += 1;
    }
    if (inFlightAtStop.at(-1)! >= 1) {
      qualifyingStops += 1;
    }
  } finally {
    releaseSync();
    await runtime.stop().catch(() => {});
    await base.close();
  }
}

const summary = {
  stopAttempts: qualifyingStops,
  totalStops: inFlightAtStop.length,
  unqualifiedStops: inFlightAtStop.filter((count) => count < 1).length,
  stopFailures,
  inFlightAtStop,
  stopPendingWhileHeld,
  syncAcceptances,
  leaseHeldWhileDraining,
  leaseFreeAfterStop,
  challengeProduced: challengeEvents > 0,
};
console.log(JSON.stringify(summary));
try {
  assertTeardownProofSummary(summary, requiredStops);
} catch {
  process.exitCode = 1;
}
