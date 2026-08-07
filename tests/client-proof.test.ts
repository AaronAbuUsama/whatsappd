/**
 * Deterministic guardrails for the real-account Client proof harness.
 *
 * The live behavior is P4 and runs separately. These tests pin the parts most
 * likely to make that run dishonest: deriving resume from observed challenges,
 * isolating the peer child from the test runner's environment, bounding a hung
 * child, and keeping the subject on the agreed composition seams.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./_expect.ts";
import { createLinkObservation, runPeerProcess, type PeerProcessResult } from "./client-proof.ts";

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

test("subject composition imports only the agreed public seams", async () => {
  const source = await readFile(path.join(here, "client-proof.ts"), "utf8");
  assert.match(source, /from "\.\.\/src\/index\.ts"/);
  assert.match(source, /from "\.\.\/src\/runtime\/client\.ts"/);
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
