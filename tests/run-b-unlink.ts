/**
 * Issue #112 Run B, phase 2 — the destructive unlink, and its re-verification.
 *
 *   RUN_B_UNLINK_SLOT=<runId> pnpm proof:run-b:unlink
 *   RUN_B_UNLINK_SLOT=<runId> pnpm proof:run-b:verify
 *
 * Needs no QR scan: phase 1 left the throwaway slot linked and its credentials
 * durable, so this resumes. It is therefore rerunnable, which is the whole
 * reason the two phases are split — a defect here never costs a second scan.
 *
 * The run id must be passed explicitly. That is the owner confirming WHICH
 * linked-device slot Run B owns; a general approval of the link/unlink cycle is
 * not a statement about a slot, and this is the one action in the mission that
 * destroys credentials.
 *
 * Two modes, because the unlink is not repeatable but its consequences are:
 *
 *   unlink  — the slot is still linked. Perform the unlink, then observe.
 *   verify  — the slot is already unlinked. Observe the post-unlink state
 *             without attempting a second unlink.
 *
 * The mode is *derived from the durable record*, never declared by the caller:
 * a mode a caller asserts is a mode that can disagree with the account.
 * `RUN_B_MODE` states only what the caller expects, and a mismatch aborts.
 *
 * Every measured observation is finalized on every path — success, assertion
 * failure and crash. An earlier version of this file threw at its cold-process
 * assertion and printed nothing at all, losing a real run's evidence.
 */
import path from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  assert,
  assertDurableProfileSandbox,
  openThrowawayProfile,
  readHandoff,
  root,
  scanForChallengeValue,
  sha256,
  sleep,
} from "./run-b-proof.ts";
import {
  captureRunBRunStart,
  finalizeRunBFailure,
  gatingRows,
  type RunBMode,
  type RunBObservationStore,
  type RunBSourceMatrixId,
  type RunBSourceMatrixRow,
  type RunBStage,
} from "./run-b-receipt.ts";
import type { WhatsAppOperation } from "../src/index.ts";
import type { ThrowawayProfile } from "./run-b-proof.ts";

const OPERATION_TIMEOUT_MS = 120_000;

/** The `src` tree a commit names, read from git rather than remembered. */
const sourceTreeHashOf = (commit: string): string =>
  execFileSync("git", ["rev-parse", `${commit}:src`], { cwd: root, encoding: "utf8" }).trim();
const isTerminal = (operation: WhatsAppOperation): boolean =>
  operation.state.status === "succeeded" ||
  operation.state.status === "failed" ||
  operation.state.status === "outcome_unknown";

async function waitForTerminal(
  profile: ThrowawayProfile,
  operation: WhatsAppOperation,
): Promise<WhatsAppOperation> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let latest = operation;
  while (Date.now() < deadline) {
    if (isTerminal(latest)) return latest;
    await sleep(100);
    const refreshed = await profile.client.operations.get(operation.id);
    if (refreshed) latest = refreshed;
  }
  throw new Error(`operation ${operation.input.type} never reached a terminal state`);
}

/** Every file under the profile's media root, digested by relative path and bytes. */
function mediaDigest(directory: string): { readonly fileCount: number; readonly digest: string } {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  try {
    walk(path.join(directory, ".whatsappd-media"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    // The relative path is hashed with the bytes, so a file that moved is a
    // different digest rather than a silent match.
    hash.update(path.relative(directory, file));
    hash.update(readFileSync(file));
  }
  return { fileCount: files.length, digest: hash.digest("hex") };
}

interface Ids {
  readonly chats: readonly string[];
  readonly contacts: readonly string[];
  readonly groups: readonly string[];
}

const idsOf = (profile: ThrowawayProfile): Ids => ({
  chats: profile.client.chats.list().map(({ chatId }) => chatId),
  contacts: profile.client.contacts.list().map(({ contactId }) => contactId),
  groups: profile.client.groups.list().map(({ groupId }) => groupId),
});

/** Order-independent: drift reorders a mirror, and a reorder is not a loss. */
const idDigest = (ids: readonly string[]): string => sha256([...ids].sort().join("\u0000"));

interface ColdChildObservation {
  readonly pid: number;
  readonly link: string;
  readonly closed: boolean;
  readonly sessionFactoryOpenCalls: number;
  readonly credentialsCleared: boolean;
  readonly outstandingLifecycleOperations: number;
  readonly chats: readonly string[];
  readonly contacts: readonly string[];
  readonly groups: readonly string[];
}

/**
 * Run the cold leg in a child process, under the same filesystem sandbox.
 *
 * The child inherits neither this process's environment nor its permissions by
 * accident: the flags are stated here, and `.proof-private/android` and
 * `.proof-private/ios` are absent from them exactly as they are absent here.
 */
function runColdChild(accountId: string, directory: string): ColdChildObservation {
  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--permission",
      "--allow-addons",
      "--allow-wasi",
      "--allow-fs-read=./src",
      "--allow-fs-read=./tests",
      "--allow-fs-read=./node_modules",
      "--allow-fs-read=./package.json",
      "--allow-fs-read=./.proof-private/throwaway-*",
      "--allow-fs-write=./.proof-private/throwaway-*",
      path.join(root, "tests", "run-b-cold-child.ts"),
      accountId,
      directory,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      // Never spread process.env into a child: an explicit allowlist only.
      env: { PATH: process.env.PATH ?? "", WA_LOG_LEVEL: "silent" },
    },
  );
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("the cold child produced no observation");
  return JSON.parse(line) as ColdChildObservation;
}

/** Every durable message across every chat, paged through the backend view. */
async function durableMessageCount(
  profile: ThrowawayProfile,
  chatIds: readonly string[],
): Promise<number> {
  return profile.backend.data.read(profile.accountId, async (view) => {
    let total = 0;
    for (const chatId of chatIds) {
      let before: { readonly timestamp: number; readonly messageId: string } | undefined;
      do {
        const page = await view.messages(chatId, before && { before });
        total += page.messages.length;
        before = page.nextBefore;
      } while (before);
    }
    return total;
  });
}

async function main(): Promise<void> {
  if (process.stdin.isTTY)
    throw new Error("Run B phase 2 refuses an interactive TTY; run it with stdin closed");

  const runStart = captureRunBRunStart(root);
  if (!runStart.treeClean)
    throw new Error("Run B phase 2 refuses a dirty tree before opening the throwaway slot");

  // Observed positively before anything else: a violation count of zero under
  // a guard that was never enabled reads exactly like one under a guard that
  // was.
  const sandbox = assertDurableProfileSandbox();

  const slot = process.env.RUN_B_UNLINK_SLOT;
  if (!slot)
    throw new Error(
      "RUN_B_UNLINK_SLOT is required: name the phase-1 run id whose slot the owner confirmed",
    );
  const handoff = readHandoff(slot);
  assert.equal(handoff.runId, slot);

  // Refuse to unlink anything but a throwaway profile. The account id shape is
  // generated by phase 1 and cannot match a durable profile.
  assert.match(handoff.accountId, /^run-b-throwaway-\d{14}$/);
  assert.equal(path.basename(handoff.directory), `throwaway-${slot}`);
  assert.notEqual(handoff.accountId, "android");
  assert.notEqual(handoff.accountId, "ios");

  const rows: RunBSourceMatrixRow[] = [];
  const knownValues: string[] = [handoff.accountId, handoff.directory, handoff.salt];
  let failedId: RunBSourceMatrixId = "durable-profiles-untouched-by-run-b";
  let stage: RunBStage = "sandbox";
  let finalizedRows: readonly RunBSourceMatrixRow[] | undefined;
  let mode: RunBMode = "unlink";
  let profile: ThrowawayProfile | undefined;

  try {
    rows.push({
      id: "durable-profiles-untouched-by-run-b",
      verdict: "observed",
      captureSite: "run-b-sandbox-probe",
      evidence: {
        permissionModelEnabled: sandbox.permissionModelEnabled,
        deniedProfileReadAttempts: sandbox.deniedProfileReadAttempts,
        deniedProfileReadDenials: sandbox.deniedProfileReadDenials,
        // Neither durable directory is in this process's fs allowlist, so it
        // could not have opened one. Their unattended resume is re-verified
        // outside this process by `pnpm proof:profile`, and this row does not
        // claim to have done that here.
        durableProfileHandlesOpened: 0,
        durableProfileResumeRevalidatedHere: false,
      },
    });

    // Phase 1's rows are carried forward. They cost a human QR scan and cannot
    // be re-measured; the handoff is the durable record they were finalized
    // into, and the writer refuses one captured against a different `src`.
    stage = "handoff";
    failedId = "challenge-consumed-exactly-once";
    // Currency is a tree comparison, not a judgement and not head equality:
    // phase 1 and phase 2 are separate commits by construction, because phase 2
    // and its receipt writer are themselves committed between the two. What has
    // to be unchanged is the behaviour the run observed — `src` — so that is
    // what is compared. A `src` that moved makes every carried-forward phase-1
    // row stale, and the receipt writer refuses it separately.
    const phaseOneSourceTreeHash = sourceTreeHashOf(handoff.gitHead);
    assert.equal(
      phaseOneSourceTreeHash,
      runStart.sourceTreeHash,
      "src moved since phase 1, so its carried-forward observations are stale",
    );
    const phaseOne = {
      phaseOneRunIdSha256: sha256(handoff.runId),
      phaseOneGitHead: handoff.gitHead,
      phaseOneSourceTreeHash,
      phaseOneLinkedAt: handoff.linkedAt,
      handoffFinalized: true,
    } as const;
    assert.equal(handoff.sessionFactoryOpenCalls, 1, "phase 1 opened more than one Session");
    assert.ok(handoff.challengeValueLength > 0, "phase 1 recorded no challenge length");
    rows.push(
      {
        id: "challenge-consumed-exactly-once",
        verdict: "observed",
        captureSite: "phase-one-handoff",
        evidence: {
          ...phaseOne,
          // The length, and only the length. A QR reference is short and
          // dictionary-confirmable, so even a hash of it is unsafe.
          challengeValueLength: handoff.challengeValueLength,
          challengeValueRetained: false,
          laterConsumeNullsRetained: true,
          onceOnlyEvidence: "handoff-finalized-after-assertions",
        },
      },
      {
        id: "pair-links-through-one-session",
        verdict: "observed",
        captureSite: "phase-one-handoff",
        evidence: {
          ...phaseOne,
          sessionFactoryOpenCalls: handoff.sessionFactoryOpenCalls,
          reconnectCount: handoff.reconnectCount,
        },
      },
      {
        // Bonus. The mission's only genuine first-link history sync, which M4
        // recorded `not_observed`. Labelled native, and it gates nothing.
        id: "bonus-first-link-history-sync",
        verdict: "observed",
        captureSite: "phase-one-handoff",
        evidence: {
          ...phaseOne,
          observationKind: "native-first-link-history-sync",
          conversationSyncBatches: handoff.conversationSyncBatches,
          conversationSyncChats: handoff.conversationSyncChats,
          gatesNothing: true,
        },
      },
    );

    stage = "throwaway-open";
    failedId = "unlink-clears-only-target-credentials";
    profile = await openThrowawayProfile({
      accountId: handoff.accountId,
      directory: handoff.directory,
    });
    const opened = profile;
    await sleep(1_000);

    // The mode is derived from the account's durable record, not declared.
    const operationsBefore = await opened.backend.operations.list(handoff.accountId);
    const priorUnlinks = operationsBefore.filter((o) => o.input.type === "unlink");
    mode = priorUnlinks.length === 0 ? "unlink" : "verify";
    const expected = process.env.RUN_B_MODE;
    if (expected && expected !== mode)
      throw new Error(`the slot is in ${mode} mode but RUN_B_MODE asked for ${expected}`);

    let unlinkOperation: WhatsAppOperation;
    let logoutOrderingObserved: boolean;
    if (mode === "unlink") {
      assert.deepEqual(
        opened.client.account.get().link,
        { status: "linked" },
        "the slot did not resume as linked",
      );
      const credentialsBefore = await opened.backend.credentials.read("creds");
      assert.ok(
        credentialsBefore && credentialsBefore.length > 0,
        "the resumed slot had no credentials",
      );
      stage = "unlink";
      // Exactly once, through the product surface — never the phone's device
      // list, which cannot target a slot.
      unlinkOperation = await waitForTerminal(opened, await opened.client.account.unlink());
      // Product-first: the account reports the result before any oracle is read.
      assert.deepEqual(opened.client.account.get().link, { status: "needs_pairing" });
      logoutOrderingObserved = true;
    } else {
      // Already unlinked. The terminal record of that unlink is the evidence,
      // and a second unlink is neither attempted nor needed.
      unlinkOperation = priorUnlinks[0]!;
      logoutOrderingObserved = false;
    }

    stage = "operations-oracle";
    const operationsAfterUnlink = await opened.backend.operations.list(handoff.accountId);
    const unlinkOperations = operationsAfterUnlink.filter((o) => o.input.type === "unlink");
    assert.equal(unlinkOperations.length, 1, "unlink did not run exactly once");
    assert.equal(unlinkOperation.state.status, "succeeded");

    stage = "credentials-oracle";
    const credentialsAfter = await opened.backend.credentials.read("creds");
    assert.equal(credentialsAfter, null, "the unlinked slot kept its credentials");
    rows.push({
      id: "unlink-clears-only-target-credentials",
      verdict: "observed",
      captureSite: "throwaway-credentials-oracle",
      evidence: {
        unlinkOperationCount: unlinkOperations.length,
        unlinkTerminalStatus: unlinkOperation.state.status,
        authRowCount: credentialsAfter === null ? 0 : 1,
        credentialsCleared: credentialsAfter === null,
        // Ordering was asserted in-process by the run that performed the
        // unlink. A later verify run cannot re-observe it, and says so rather
        // than carrying a claim it did not make.
        logoutOrderingRetained: logoutOrderingObserved,
      },
    });

    // D-runtime-survives-unlink-and-accepts-repair. The repair pair() is
    // accepted and then aborted through its own AbortSignal without ever
    // reaching a scan. The AbortSignal rejects the caller's await; it does NOT
    // cancel the durable operation row, so the row is driven to a terminal
    // state here rather than left in flight. A cold process resuming an
    // unfinished pair row would report `pairing` — which is the operation
    // machine working, but it would make the assertion below race the
    // executor rather than measure the unlink.
    stage = "repair";
    failedId = "runtime-survives-unlink-and-accepts-repair";
    if (mode === "unlink") {
      const controller = new AbortController();
      const repair = opened.client.account.pair({ method: "qr" }, { signal: controller.signal });
      controller.abort();
      await repair.catch(() => undefined);
    }
    const repairOperations = (await opened.backend.operations.list(handoff.accountId)).filter(
      (o) => o.input.type === "pair" && o.submittedAt > unlinkOperation.submittedAt,
    );
    const repairSettled = await Promise.all(
      repairOperations.map((operation) => waitForTerminal(opened, operation)),
    );
    const runtimeStillLive = opened.client.account.get().closed === false;
    assert.equal(runtimeStillLive, true, "the Runtime did not survive the unlink");
    assert.equal(repairOperations.length, 1, "the repair pair did not run exactly once");
    assert.equal(
      repairSettled.every((operation) => operation.state.status !== "succeeded"),
      true,
      "an aborted repair pair reached succeeded without a scan",
    );

    // The leak scanner, re-verified against this run's live corpus rather than
    // a synthetic stand-in. The value planted is generated here and is not a
    // real challenge — phase 1 dropped that one — so what this proves is that
    // the scanner still detects a planted value over a real, non-empty corpus.
    const scannerControlValue = `run-b-scanner-control-${sha256(handoff.runId).slice(0, 24)}`;
    const corpus = new Map<string, string>([
      ["operation-records", JSON.stringify(repairSettled)],
      ["mirror-chats", JSON.stringify(opened.client.chats.list())],
      ["mirror-contacts", JSON.stringify(opened.client.contacts.list())],
      ["mirror-groups", JSON.stringify(opened.client.groups.list())],
      ["session-statuses", JSON.stringify(opened.statuses())],
    ]);
    const leak = scanForChallengeValue(scannerControlValue, corpus);
    assert.deepEqual(leak.hits, [], "the scanner control value was already in the corpus");
    assert.equal(leak.plantedControlDetected, true, "the leak scan cannot detect a planted value");
    rows.push({
      id: "challenge-never-in-ordinary-state",
      verdict: "observed",
      captureSite: "leak-scanner-self-test",
      evidence: {
        ...phaseOne,
        positiveControlRetained: true,
        leakScanEvidence: "handoff-finalized-after-assertions",
        scannerScannedEntries: leak.scannedEntries,
        scannerScannedBytes: leak.scannedBytes,
        scannerCleanCorpusHits: leak.hits.length,
        scannerPlantedControlDetected: leak.plantedControlDetected,
        scannerControlKind: "synthetic-value-over-live-corpus",
      },
    });

    stage = "durable-compare";
    failedId = "unlink-preserves-durable-chats-and-media";
    const afterIds = idsOf(opened);
    // Read through the durable view, not `client.messages.get()`: the Client
    // only holds what has been paged in, so that route reports 0 on a mirror
    // nothing has read yet — a number that looks like total loss.
    const messages = await durableMessageCount(opened, afterIds.chats);
    const media = mediaDigest(handoff.directory);

    stage = "cold-open";
    await opened.close();
    profile = undefined;

    // A genuinely distinct process over the same files — a second Runtime in
    // *this* process would share the module registry and every in-memory latch
    // the unlink just touched, and so could not tell a durable `needs_pairing`
    // from a remembered one. Every lifecycle operation is terminal by now, so
    // `needs_pairing` measures the unlink rather than the executor's progress
    // through a queue.
    const coldChild = runColdChild(handoff.accountId, handoff.directory);
    const coldIds = {
      chats: coldChild.chats,
      contacts: coldChild.contacts,
      groups: coldChild.groups,
    };
    const coldMedia = mediaDigest(handoff.directory);
    const coldLink = coldChild.link;
    const outstanding = coldChild.outstandingLifecycleOperations;

    // Asymmetric on purpose: live drift only ever adds or mutates, so a loss
    // fails outright while an addition is reported rather than tolerated.
    const shortfall = {
      chats: Math.max(0, handoff.durable.chats - coldIds.chats.length),
      contacts: Math.max(0, handoff.durable.contacts - coldIds.contacts.length),
      groups: Math.max(0, handoff.durable.groups - coldIds.groups.length),
    };
    const coldIdMissingCount = {
      chats: afterIds.chats.filter((id) => !coldIds.chats.includes(id)).length,
      contacts: afterIds.contacts.filter((id) => !coldIds.contacts.includes(id)).length,
      groups: afterIds.groups.filter((id) => !coldIds.groups.includes(id)).length,
    };
    rows.push({
      id: "unlink-preserves-durable-chats-and-media",
      verdict: "observed",
      captureSite: "cold-process-client",
      evidence: {
        comparisonBasis: "phase-one-counts",
        phaseOneCounts: handoff.durable,
        afterCounts: {
          chats: afterIds.chats.length,
          contacts: afterIds.contacts.length,
          groups: afterIds.groups.length,
          messages,
        },
        countShortfall: shortfall,
        countAdditions: {
          chats: Math.max(0, coldIds.chats.length - handoff.durable.chats),
          contacts: Math.max(0, coldIds.contacts.length - handoff.durable.contacts),
          groups: Math.max(0, coldIds.groups.length - handoff.durable.groups),
        },
        durableIdDigest: {
          chats: idDigest(afterIds.chats),
          contacts: idDigest(afterIds.contacts),
          groups: idDigest(afterIds.groups),
        },
        coldIdMissingCount,
        mediaFileCount: media.fileCount,
        mediaDigest: media.digest,
        coldMediaDigest: coldMedia.digest,
        mediaDigestEqual: media.digest === coldMedia.digest,
      },
    });
    assert.deepEqual(
      coldIdMissingCount,
      { chats: 0, contacts: 0, groups: 0 },
      "a cold process lost durable rows",
    );
    assert.equal(media.digest, coldMedia.digest, "captured media changed across the unlink");
    assert.equal(coldChild.sessionFactoryOpenCalls, 0, "an unlinked cold process opened a Session");
    assert.notEqual(coldChild.pid, process.pid, "the cold leg ran in this process");
    // The `needs_pairing` clause is only meaningful once nothing is in flight;
    // asserting the absence of outstanding work is what stops it passing for
    // the wrong reason.
    assert.equal(outstanding, 0, "a lifecycle operation was still in flight on the cold process");
    assert.equal(coldLink, "needs_pairing", "a cold process still reported a link");

    rows.push({
      id: "runtime-survives-unlink-and-accepts-repair",
      verdict: "observed",
      captureSite: "cold-process-client",
      evidence: {
        repairPairOperationCount: repairOperations.length,
        repairTerminalStatus: repairSettled[0]!.state.status,
        // Accepted, then aborted before a scan, so it must not have linked.
        repairReachedSucceeded: repairSettled[0]!.state.status === "succeeded",
        credentialsStillClearedAfterRepair: coldChild.credentialsCleared,
        coldRuntimeClosed: coldChild.closed,
        coldBackendReadable: true,
        coldLinkStatus: coldLink,
        coldSessionFactoryOpenCalls: coldChild.sessionFactoryOpenCalls,
        coldPid: coldChild.pid,
        distinctFromPhaseOnePid: coldChild.pid !== process.pid,
        outstandingLifecycleOperations: outstanding,
      },
    });

    finalizedRows = rows;
  } catch (error) {
    finalizedRows = finalizeRunBFailure(rows, failedId, stage);
    process.exitCode = 1;
    process.stderr.write(
      `run-b phase 2 failed at stage ${stage} (${failedId}): ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
  } finally {
    await profile?.close().catch(() => {});
  }

  const store = {
    runStart,
    mode,
    finalizedAt: new Date().toISOString(),
    knownValues,
    // Every path above assigns this; the fallback exists so the type system
    // agrees, not because a run is allowed to reach here unfinalized.
    rows: finalizedRows ?? finalizeRunBFailure(rows, failedId, stage),
  } satisfies RunBObservationStore;
  // The runner captures; the writer transcribes. This process runs under a
  // filesystem sandbox that deliberately cannot reach the formatter, so the
  // observation store — which holds the run's known-value controls and is
  // therefore private — is finalized here and transcribed into a receipt by
  // `pnpm proof:run-b:receipt`, which re-reads the head and refuses a mismatch.
  const privateStore = path.join(
    root,
    ".proof-private",
    `issue112-run-b-${runStart.gitHead.slice(0, 7)}-${Date.now()}.json`,
  );
  writeFileSync(privateStore, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx" });

  process.stdout.write(
    `${JSON.stringify({
      stage: "finalized",
      mode,
      observationStore: path.relative(root, privateStore),
      verdicts: store.rows.map(({ id, verdict }) => ({ id, verdict })),
    })}\n`,
  );
  if (gatingRows(store.rows).some(({ verdict }) => verdict !== "observed")) process.exitCode = 1;
}

await main();
