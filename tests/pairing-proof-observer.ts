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
  readonly challengeEventCount: number;
} {
  let status: Status | undefined;
  const observer = createPairingChallengeObserver(() => status);
  observer.observe();
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
  return { kind: "synthetic", challengeEventCount: observer.count() };
}
