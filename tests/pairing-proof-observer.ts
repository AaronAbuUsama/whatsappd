import assert from "node:assert/strict";
import type { Status } from "../src/index.ts";

export interface PairingChallengeObserver {
  observe(): void;
  count(): number;
}

function isChallenge(status: Status | undefined): boolean {
  return status?.phase === "pairing" && status.pairing.step === "challenge_live";
}

export function createPairingChallengeObserver(
  readStatus: () => Status | undefined,
): PairingChallengeObserver {
  let challengeEventCount = 0;
  let challengeWasLive = false;
  return {
    observe() {
      const live = isChallenge(readStatus());
      if (live && !challengeWasLive) challengeEventCount += 1;
      challengeWasLive = live;
    },
    count: () => challengeEventCount,
  };
}

export function runSyntheticPairingChallengeObserverControl(): {
  readonly kind: "synthetic";
  readonly nonChallengeEventCount: number;
  readonly liveChallengeEventCount: number;
} {
  let status: Status | undefined = {
    phase: "pairing",
    pairing: { step: "awaiting_ready" },
  };
  const observer = createPairingChallengeObserver(() => status);
  observer.observe();
  assert.equal(observer.count(), 0);
  status = { phase: "online" };
  observer.observe();
  const nonChallengeEventCount = observer.count();
  assert.equal(nonChallengeEventCount, 0);
  status = {
    phase: "pairing",
    pairing: {
      step: "challenge_live",
      method: "qr",
      qr: "synthetic-observer-control",
      expiresAt: 1,
    },
  };
  observer.observe();
  const liveChallengeEventCount = observer.count();
  assert.equal(liveChallengeEventCount, 1);
  observer.observe();
  assert.equal(observer.count(), 1);
  return { kind: "synthetic", nonChallengeEventCount, liveChallengeEventCount };
}
