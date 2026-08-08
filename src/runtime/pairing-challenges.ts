interface PairingChallenge {
  readonly id: string;
  readonly accountId: string;
  readonly method: "qr" | "pairing_code";
  readonly value: string;
  readonly expiresAt: number;
}

export interface PairingChallengeStore {
  publish(challenge: PairingChallenge): Promise<void>;
  consume(accountId: string, challengeId: string): Promise<PairingChallenge | null>;
  clear(accountId: string, challengeId: string): Promise<void>;
}

export interface MemoryPairingChallengeStoreOptions {
  readonly now?: () => number;
}

/** Runtime-private destructive-read storage for short-lived pairing secrets. */
export function memoryPairingChallengeStore(
  options: MemoryPairingChallengeStoreOptions = {},
): PairingChallengeStore {
  const now = options.now ?? Date.now;
  const active = new Map<string, PairingChallenge>();
  let writes: Promise<void> = Promise.resolve();
  const serialize = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = writes.then(work);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  return {
    publish(challenge) {
      return serialize(() => {
        active.set(challenge.accountId, structuredClone(challenge));
      });
    },
    consume(accountId, challengeId) {
      return serialize(() => {
        const challenge = active.get(accountId);
        if (!challenge || challenge.id !== challengeId) return null;
        active.delete(accountId);
        if (challenge.expiresAt <= now()) return null;
        return structuredClone(challenge);
      });
    },
    clear(accountId, challengeId) {
      return serialize(() => {
        if (active.get(accountId)?.id === challengeId) active.delete(accountId);
      });
    },
  };
}
