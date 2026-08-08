import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRunADiagnosisReceipt,
  scanRunADiagnosisReceipt,
  type RunADiagnosisObservationStore,
} from "./run-a-diagnosis-receipt.ts";
import { test } from "./_expect.ts";

const sha = (character: string): string => character.repeat(40);
const digest = (character: string): string => character.repeat(64);
const here = path.dirname(fileURLToPath(import.meta.url));

function completeStore(): RunADiagnosisObservationStore {
  return {
    runStart: {
      captureSite: "run-a-proof-run-start",
      gitHead: sha("a"),
      sourceTreeHash: sha("b"),
      treeClean: true,
      startedAt: "2026-08-08T13:00:00.000Z",
    },
    finalizedAt: "2026-08-08T13:01:00.000Z",
    knownValues: ["private group", "private identity", "private profile path"],
    priorOutbound: {
      sourceReceiptSha256: digest("1"),
      sourceGitHead: sha("c"),
      sourceTreeHash: sha("b"),
      currentSourceTreeHash: sha("b"),
      sourceTreeMatches: true,
      terminalStatus: "succeeded",
      authoritativeEchoCount: 1,
      sessionSendInvocations: 1,
      observedThisRun: false,
    },
    liveDriftControl: {
      subjectPid: 10,
      intervalMs: 30_000,
      noSendInvocations: 0,
      componentMatches: {
        chats: true,
        contacts: true,
        groups: true,
        orderedIds: true,
        media: true,
      },
      stableProofStateEqual: true,
      collectionsPreserved: true,
      collectionChanges: {
        chats: { missingCount: 0, additionCount: 0 },
        contacts: { missingCount: 0, additionCount: 0 },
        groups: { missingCount: 0, additionCount: 0 },
      },
    },
    unnormalizedReplacement: {
      replacementPid: 20,
      distinctPid: true,
      childSessionSendInvocations: 0,
      componentMatches: {
        chats: true,
        contacts: true,
        groups: true,
        orderedIds: false,
        media: false,
      },
      stableProofStateEqual: false,
      collectionsPreserved: true,
      collectionChanges: {
        chats: { missingCount: 0, additionCount: 0 },
        contacts: { missingCount: 0, additionCount: 0 },
        groups: { missingCount: 0, additionCount: 0 },
      },
      credentialIdentityMatchesOriginal: true,
      sessionAttached: true,
      liveSocketResumed: false,
      durableReconstructedWhileNoLive: true,
    },
    replacement: {
      replacementPid: 30,
      distinctPid: true,
      childSessionSendInvocations: 0,
      componentMatches: {
        chats: true,
        contacts: true,
        groups: true,
        orderedIds: true,
        media: true,
      },
      stableProofStateEqual: true,
      collectionsPreserved: true,
      collectionChanges: {
        chats: { missingCount: 0, additionCount: 0 },
        contacts: { missingCount: 0, additionCount: 0 },
        groups: { missingCount: 0, additionCount: 0 },
      },
      credentialIdentityMatchesOriginal: true,
      sessionAttached: true,
      liveSocketResumed: false,
      durableReconstructedWhileNoLive: true,
    },
    conclusion: "proof-chat-window-asymmetry",
  };
}

test("Run A diagnosis receipt carries the prior send and records component drift", () => {
  const store = completeStore();
  const receipt = buildRunADiagnosisReceipt(store, {
    gitHead: store.runStart.gitHead,
    treeClean: true,
  });
  const scan = scanRunADiagnosisReceipt(receipt, store.knownValues);

  assert.equal(scan.schemaUnknownFields, 0);
  assert.equal(scan.schemaInvalidFields, 0);
  assert.equal(scan.patternHits, 0);
  assert.equal(scan.knownValueHits, 0);
  assert.equal(scan.floorPassed, true);
  assert.equal(Reflect.get(receipt.priorOutbound as object, "observedThisRun"), false);
});

test("Run A diagnosis receipt refuses a fresh-send claim or unstable proof-chat state", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };
  assert.throws(
    () =>
      buildRunADiagnosisReceipt(
        {
          ...store,
          priorOutbound: {
            ...store.priorOutbound,
            // @ts-expect-error Deliberately dishonest carried-send fixture.
            observedThisRun: true,
          },
        },
        current,
      ),
    /carried/,
  );
  assert.throws(
    () =>
      buildRunADiagnosisReceipt(
        {
          ...store,
          replacement: {
            ...store.replacement,
            stableProofStateEqual: false,
          },
        },
        current,
      ),
    /stable proof state is not measured/,
  );
});

test("Run A diagnosis receipt refuses comparison booleans that disagree with measurements", () => {
  const store = completeStore();
  const current = { gitHead: store.runStart.gitHead, treeClean: true };
  assert.throws(
    () =>
      buildRunADiagnosisReceipt(
        {
          ...store,
          replacement: {
            ...store.replacement,
            collectionChanges: {
              ...store.replacement.collectionChanges,
              chats: { missingCount: 1, additionCount: 0 },
            },
          },
        },
        current,
      ),
    /collection preservation is not measured/,
  );
});

test("Run A diagnosis runner has no sending lane and the scan sees a planted lane", () => {
  const source = readFileSync(path.join(here, "run-a-diagnosis.ts"), "utf8");
  const childSource = readFileSync(path.join(here, "client-proof.ts"), "utf8");
  const replacementChild = childSource.match(
    /async function coldReplacement[\s\S]+?(?=\nasync function pagingReplacementRun)/u,
  )?.[0];
  const sendingLane =
    /guarded(?:Client)?Sender|mode:\s*["'](?:send-text|send-document|seed-pages)["']|\.messages\.send|\.session\.send/u;
  assert.equal(sendingLane.test(source), false);
  assert.ok(replacementChild, "the reachable replacement child was not found");
  assert.equal(sendingLane.test(replacementChild), false);
  assert.match(
    replacementChild,
    /sessionSendInvocations:\s*driver\.commands\.sent\.length/u,
    "the replacement child must return its measured Session send count",
  );
  assert.equal(sendingLane.test(`${source}\nrunPeerProcess({ mode: "send-text" });`), true);
  assert.equal(sendingLane.test(`${replacementChild}\ndriver.session.send("x", "y");`), true);
});
