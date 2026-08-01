/** Capture one promise without losing a falsy rejection reason. */
export async function settle<T>(promise: PromiseLike<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([promise]);
  return result!;
}

/** Return the first rejected result, preserving its reason by identity. */
export interface RejectedOutcome {
  readonly status: "rejected";
  readonly reason: unknown;
}

export function firstRejection(
  results: readonly ({ readonly status: "fulfilled" } | RejectedOutcome)[],
): RejectedOutcome | undefined {
  return results.find((result): result is RejectedOutcome => result.status === "rejected");
}
