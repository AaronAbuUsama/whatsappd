/**
 * Issue #112 Run B, phase 1 — the attended link.
 *
 *   pnpm proof:run-b:link
 *
 * Costs the owner exactly one QR scan. Links a NEW device slot on the android
 * account into a THROWAWAY profile directory, observes everything about the
 * challenge that can only be observed on a real one, and exits with the slot
 * still linked. Phase 2 performs the destructive unlink without another scan,
 * so a phase-2 defect never costs a second scan.
 *
 * The QR is printed to the terminal and written nowhere. The raw challenge
 * value is held in one local, compared, measured and dropped; only its length
 * reaches an artifact — a QR reference is short and dictionary-confirmable, so
 * even a hash of it is unsafe.
 *
 * `consumeChallenge()` is once-only by design, so the product surface yields
 * exactly one value. WhatsApp refreshes the QR every 20s, and a human should
 * not be boxed into the first 60s window, so refreshed codes are printed from a
 * clearly-labelled DISPLAY-ONLY session observer. Every assertion below is made
 * against the value the product surface returned, never the display one.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ONLINE_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  assert,
  assertDurableProfileSandbox,
  openThrowawayProfile,
  proofRoot,
  qrcode,
  root,
  scanForChallengeValue,
  sleep,
  writeHandoff,
  type PhaseOneHandoff,
} from "./run-b-proof.ts";
import type { PairingOperation } from "../src/runtime/lifecycle.ts";
import type { Status } from "../src/index.ts";

const sandbox = assertDurableProfileSandbox();
console.log(JSON.stringify({ stage: "sandbox", ...sandbox }));

const runId = new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14);
const accountId = `run-b-throwaway-${runId}`;
const directory = path.join(proofRoot, `throwaway-${runId}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });

const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

// Capture this process's own stdout so "the value never reached the log" is
// checked against real captured output rather than against nothing.
const stdoutCapture: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  stdoutCapture.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

let displayedRefreshes = 0;
let lastDisplayed = "";
const displayOnlyQr = (status: Status): void => {
  if (status.phase !== "pairing" || status.pairing.step !== "challenge_live") return;
  const value = status.pairing.qr ?? status.pairing.code;
  if (!value || value === lastDisplayed) return;
  lastDisplayed = value;
  displayedRefreshes += 1;
  // Written straight to the real stream: never into the captured corpus, and
  // never into any file.
  originalWrite(`\n--- QR refresh #${displayedRefreshes} — scan this one ---\n`);
  qrcode.generate(value, { small: true }, (art: string) => originalWrite(`${art}\n`));
};

const profile = await openThrowawayProfile({
  accountId,
  directory,
  onSessionStatus: displayOnlyQr,
});

const publishedStates: string[] = [];
const offAccount = profile.client.account.subscribe(() => {
  const state = profile.client.account.get();
  publishedStates.push(JSON.stringify(state));
  const status = state.connection;
  if (status?.phase === "pairing" && status.pairing.step === "challenge_live") {
    // publicConnectionStatus() strips the raw value before ordinary
    // publication. This is the only run where that value is real, so assert it
    // rather than trust it.
    assert.equal(
      "qr" in status.pairing ? status.pairing.qr : undefined,
      undefined,
      "the published pairing status carried the raw challenge",
    );
    assert.equal(
      "code" in status.pairing ? status.pairing.code : undefined,
      undefined,
      "the published pairing status carried the raw pairing code",
    );
  }
});

try {
  assert.deepEqual(profile.client.account.get().link, { status: "needs_pairing" });

  const pairing: PairingOperation = await profile.client.account.pair({ method: "qr" });

  let methodSeen: string | undefined;
  let challengeIdSeen: string | undefined;
  let expiresAtSeen: number | undefined;

  const consumed = await new Promise<{
    readonly method: "qr" | "pairing_code";
    readonly value: string;
    readonly expiresAt: number;
  }>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("no pairing challenge went live within the attended window")),
      SCAN_TIMEOUT_MS,
    );
    const poll = async (): Promise<void> => {
      const link = profile.client.account.get().link;
      if (link?.status === "pairing" && link.challengeId) {
        methodSeen = link.method;
        challengeIdSeen = link.challengeId;
        expiresAtSeen = link.expiresAt;
        const challenge = await pairing.consumeChallenge();
        if (challenge) {
          clearTimeout(deadline);
          resolve(challenge);
          return;
        }
      }
      setTimeout(() => void poll().catch(reject), 100);
    };
    void poll().catch(reject);
  });

  const challengeValue = consumed.value;
  assert.ok(challengeValue.length > 0);
  const challengeValueLength = challengeValue.length;

  originalWrite("\n=== SCAN THIS: WhatsApp -> Linked devices -> Link a device ===\n");
  qrcode.generate(challengeValue, { small: true }, (art: string) => originalWrite(`${art}\n`));
  originalWrite("Refreshed codes will appear below if this one expires.\n\n");

  // D-challenge-consumed-exactly-once. Once-only holds on this operation, and
  // holds again after a refresh has replaced the stored challenge.
  const secondConsume = await pairing.consumeChallenge();
  assert.equal(secondConsume, null);
  const consumedAfterRefresh = await (async () => {
    const startedWith = challengeIdSeen;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const link = profile.client.account.get().link;
      if (link?.status === "linked") return "linked-before-refresh" as const;
      if (link?.status === "pairing" && link.challengeId && link.challengeId !== startedWith) {
        return await pairing.consumeChallenge();
      }
      await sleep(100);
    }
    return "no-refresh-observed" as const;
  })();
  const thirdConsume = await pairing.consumeChallenge();
  assert.equal(thirdConsume, null);

  // The positive control: these come from WhatsApp on this run, so their
  // presence is what proves the raw value's absence is real absence rather
  // than everything being absent.
  assert.equal(methodSeen, "qr");
  assert.ok(challengeIdSeen && challengeIdSeen.length > 0);
  assert.ok(typeof expiresAtSeen === "number" && expiresAtSeen > 0);

  const linkedAt = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("the scanned link never came online")),
      ONLINE_TIMEOUT_MS,
    );
    const check = (): void => {
      const state = profile.client.account.get();
      if (state.link?.status === "linked" && state.connection?.phase === "online") {
        clearTimeout(deadline);
        off();
        resolve(new Date().toISOString());
      }
    };
    const off = profile.client.account.subscribe(check);
    check();
  });

  // The only genuine first-link history sync in the mission. Bonus
  // observation: recorded with its true count, gating nothing.
  await sleep(20_000);

  const chats = profile.client.chats.list();
  const contacts = profile.client.contacts.list();
  const groups = profile.client.groups.list();

  // D-challenge-never-in-ordinary-state. A real corpus: published account
  // states, operation records, credential rows, the mirror, and stdout.
  const operations = await profile.backend.operations.list(accountId);
  const corpus = new Map<string, string>([
    ["published-account-states", publishedStates.join("\n")],
    ["operation-records", JSON.stringify(operations)],
    ["mirror-chats", JSON.stringify(chats)],
    ["mirror-contacts", JSON.stringify(contacts)],
    ["mirror-groups", JSON.stringify(groups)],
    ["harness-stdout", stdoutCapture.join("")],
    ["session-statuses", JSON.stringify(profile.statuses())],
  ]);
  for (const key of ["creds", "app-state-sync-key", "pre-key"]) {
    corpus.set(`credential:${key}`, (await profile.backend.credentials.read(key)) ?? "");
  }
  const leak = scanForChallengeValue(challengeValue, corpus);
  assert.deepEqual(leak.hits, [], "the raw challenge value reached an ordinary surface");
  assert.equal(leak.plantedControlDetected, true, "the leak scan cannot detect a planted value");

  // D-pair-links-through-one-session. One open() across the whole pair; the
  // expected 515 restart is a reconnect inside that Session, not a second one.
  const sessionFactoryOpenCalls = profile.sessionFactoryOpenCalls();
  const reconnectCount = profile.reconnectCount();
  assert.equal(sessionFactoryOpenCalls, 1, "pairing opened more than one Session");

  const handoff: PhaseOneHandoff = {
    runId,
    accountId,
    directory,
    salt: `run-b-${runId}`,
    linkedAt,
    gitHead,
    challengeValueLength,
    sessionFactoryOpenCalls,
    reconnectCount,
    durable: { chats: chats.length, contacts: contacts.length, groups: groups.length },
    conversationSyncBatches: profile.conversationSyncBatches(),
    conversationSyncChats: profile.conversationSyncChats(),
  };
  const handoffFile = writeHandoff(handoff);

  console.log(
    JSON.stringify({
      stage: "linked",
      runId,
      linkedAt,
      sessionFactoryOpenCalls,
      reconnectCount,
      challengeValueLength,
      displayedRefreshes,
      onceOnly: {
        secondConsumeNull: secondConsume === null,
        thirdConsumeNull: thirdConsume === null,
        refreshedConsume:
          typeof consumedAfterRefresh === "string" ? consumedAfterRefresh : "returned-value",
        refreshedConsumeWasNull: consumedAfterRefresh === null,
      },
      positiveControl: {
        methodPresent: methodSeen !== undefined,
        challengeIdPresent: challengeIdSeen !== undefined,
        expiresAtPresent: expiresAtSeen !== undefined,
      },
      leak: {
        scannedEntries: leak.scannedEntries,
        scannedBytes: leak.scannedBytes,
        hitCount: leak.hits.length,
        plantedControlDetected: leak.plantedControlDetected,
      },
      durable: handoff.durable,
      bonusHistorySync: {
        conversationSyncBatches: handoff.conversationSyncBatches,
        conversationSyncChats: handoff.conversationSyncChats,
      },
      handoff: path.relative(root, handoffFile),
    }),
  );
  originalWrite(
    `\nPhase 1 complete. The new slot is LINKED, run id ${runId}.\n` +
      `Check WhatsApp -> Linked devices and confirm the newest entry before phase 2.\n\n`,
  );
} finally {
  offAccount();
  process.stdout.write = originalWrite;
  await profile.close().catch(() => {});
}
