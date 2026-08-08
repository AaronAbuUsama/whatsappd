import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareDurableSnapshots,
  credentialIdentityDigest,
  durableSnapshot,
  openProfile,
  proofGroupId,
  runPeerProcess,
  type DurableComparison,
  type OpenProfile,
} from "./client-proof.ts";
import {
  writeRunADiagnosisReceipt,
  type RunADiagnosisObservationStore,
} from "./run-a-diagnosis-receipt.ts";
import { captureRunAProofRunStart } from "./run-a-proof-receipt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const CONTROL_INTERVAL_MS = 30_000;
const PRIOR_RECEIPT = path.join(root, ".proof-receipts", "issue111-p4.run2-9c134a7.json");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function accountCollectionsDrifted(comparison: DurableComparison): boolean {
  return (
    !comparison.componentMatches.chats ||
    !comparison.componentMatches.contacts ||
    !comparison.componentMatches.groups
  );
}

function priorOutboundEvidence(runStartSourceTreeHash: string): {
  readonly sourceReceiptSha256: string;
  readonly sourceGitHead: string;
  readonly sourceTreeHash: string;
  readonly currentSourceTreeHash: string;
  readonly sourceTreeMatches: true;
  readonly terminalStatus: "succeeded";
  readonly authoritativeEchoCount: 1;
  readonly sessionSendInvocations: 1;
  readonly observedThisRun: false;
} {
  const bytes = readFileSync(PRIOR_RECEIPT);
  const receipt = JSON.parse(bytes.toString("utf8")) as {
    readonly provenance?: { readonly gitHead?: unknown };
    readonly matrix?: readonly {
      readonly id?: unknown;
      readonly verdict?: unknown;
      readonly evidence?: Readonly<Record<string, unknown>>;
    }[];
  };
  const sourceGitHead = receipt.provenance?.gitHead;
  const outbound = receipt.matrix?.find(({ id }) => id === "outbound-durable-send");
  if (
    typeof sourceGitHead !== "string" ||
    outbound?.verdict !== "observed" ||
    outbound.evidence?.terminalStatus !== "succeeded" ||
    outbound.evidence.authoritativeEchoCount !== 1 ||
    outbound.evidence.sessionSendInvocationsBefore !== 0 ||
    outbound.evidence.sessionSendInvocationsAfter !== 1
  )
    throw new Error("the carried Run A outbound observation is incomplete");
  const sourceTreeHash = execFileSync("git", ["rev-parse", `${sourceGitHead}:src`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (sourceTreeHash !== runStartSourceTreeHash)
    throw new Error("the carried Run A outbound observation is stale for the current src tree");
  return {
    sourceReceiptSha256: sha256(bytes),
    sourceGitHead,
    sourceTreeHash,
    currentSourceTreeHash: runStartSourceTreeHash,
    sourceTreeMatches: true,
    terminalStatus: "succeeded",
    authoritativeEchoCount: 1,
    sessionSendInvocations: 1,
    observedThisRun: false,
  };
}

async function main(): Promise<void> {
  if (process.stdin.isTTY)
    throw new Error("Run A diagnosis refuses an interactive TTY; run it with stdin closed");
  const runStart = captureRunAProofRunStart(root);
  if (!runStart.treeClean)
    throw new Error("Run A diagnosis refuses a dirty tree before opening the linked account");

  const priorOutbound = priorOutboundEvidence(runStart.sourceTreeHash);
  const salt = randomBytes(16).toString("hex");
  const knownValues = [path.join(root, ".proof-private", "android")];
  let subject: OpenProfile | undefined;
  try {
    const chatId = proofGroupId();
    knownValues.push(chatId);
    subject = await openProfile("android");
    knownValues.push(subject.identity);
    if (subject.link.linkMode !== "resumed")
      throw new Error("the diagnosis subject paired instead of resuming");
    if (subject.sessionSendInvocations() !== 0)
      throw new Error("the diagnosis opened with an unexpected send invocation");

    const before = await durableSnapshot({
      client: subject.client,
      media: subject.media,
      accountId: "android",
      chatId,
      salt,
    });
    await sleep(CONTROL_INTERVAL_MS);
    const after = await durableSnapshot({
      client: subject.client,
      media: subject.media,
      accountId: "android",
      chatId,
      salt,
    });
    const liveDrift = compareDurableSnapshots(before, after);
    if (subject.sessionSendInvocations() !== 0)
      throw new Error("the read-only control invoked a send");

    const originalCredentialIdentityDigest = await credentialIdentityDigest(
      subject.backend.credentials,
      salt,
    );
    await subject.close();
    subject = undefined;

    const replacementProcess = await runPeerProcess({
      mode: "replacement",
      identityHashSalt: salt,
      originalCredentialIdentityDigest,
      timeoutMs: 120_000,
    });
    const replacement = replacementProcess.replacement;
    if (!replacement) throw new Error("the replacement child returned no observation");
    if (replacementProcess.pid === process.pid)
      throw new Error("the replacement did not run in a distinct process");
    const replacementComparison = compareDurableSnapshots(after, {
      digest: replacement.durableDigest,
      collectionCounts: replacement.collectionCounts,
    });
    const liveDriftSupportsHypothesis =
      liveDrift.stableProofStateEqual &&
      liveDrift.collectionFloorsSatisfied &&
      accountCollectionsDrifted(liveDrift);
    const replacementSupportsHypothesis =
      replacementComparison.stableProofStateEqual &&
      replacementComparison.collectionFloorsSatisfied &&
      accountCollectionsDrifted(replacementComparison);
    if (
      (!liveDriftSupportsHypothesis && !replacementSupportsHypothesis) ||
      !replacement.credentialIdentityMatchesOriginal ||
      !replacement.sessionAttached ||
      replacement.liveSocketResumed ||
      !replacement.durableReconstructedWhileNoLive
    )
      throw new Error("the non-sending observation did not support the live-drift hypothesis");

    const store = {
      runStart,
      finalizedAt: new Date().toISOString(),
      knownValues,
      priorOutbound,
      liveDriftControl: {
        subjectPid: process.pid,
        intervalMs: CONTROL_INTERVAL_MS,
        noSendInvocations: 0,
        componentMatches: liveDrift.componentMatches,
        stableProofStateEqual: true,
        collectionFloorsSatisfied: true,
      },
      replacement: {
        replacementPid: replacementProcess.pid,
        distinctPid: true,
        noSendInvocations: 0,
        componentMatches: replacementComparison.componentMatches,
        stableProofStateEqual: true,
        collectionFloorsSatisfied: true,
        credentialIdentityMatchesOriginal: replacement.credentialIdentityMatchesOriginal,
        sessionAttached: replacement.sessionAttached,
        liveSocketResumed: replacement.liveSocketResumed,
        durableReconstructedWhileNoLive: replacement.durableReconstructedWhileNoLive,
      },
      conclusion: "live-account-collection-drift",
    } satisfies RunADiagnosisObservationStore;
    const privateStore = path.join(
      root,
      ".proof-private",
      `issue111-run-a-diagnosis-${runStart.gitHead.slice(0, 7)}.json`,
    );
    writeFileSync(privateStore, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx" });
    const receipt = writeRunADiagnosisReceipt(root, store);
    process.stdout.write(
      `${JSON.stringify({
        receipt: path.relative(root, receipt.file),
        noSendInvocations: 0,
        liveDriftComponentMatches: liveDrift.componentMatches,
        replacementComponentMatches: replacementComparison.componentMatches,
        stableProofStateEqual: replacementComparison.stableProofStateEqual,
        collectionFloorsSatisfied: replacementComparison.collectionFloorsSatisfied,
        credentialIdentityMatchesOriginal: replacement.credentialIdentityMatchesOriginal,
        sessionAttached: replacement.sessionAttached,
        liveSocketResumed: replacement.liveSocketResumed,
        durableReconstructedWhileNoLive: replacement.durableReconstructedWhileNoLive,
        schemaUnknownFields: receipt.scan.schemaUnknownFields,
        schemaInvalidFields: receipt.scan.schemaInvalidFields,
        patternHits: receipt.scan.patternHits,
        knownValueHits: receipt.scan.knownValueHits,
        floorPassed: receipt.scan.floorPassed,
      })}\n`,
    );
  } finally {
    await subject?.close().catch(() => {});
  }
}

await main();
