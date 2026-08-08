export interface TeardownProofSummary {
  readonly stopAttempts: number;
  readonly totalStops: number;
  readonly unqualifiedStops: number;
  readonly stopFailures: number;
  readonly inFlightAtStop: readonly number[];
  readonly stopPendingWhileHeld: number;
  readonly syncAcceptances: number;
  readonly leaseHeldWhileDraining: number;
  readonly leaseFreeAfterStop: number;
  readonly challengeProduced: boolean;
}

/** Fail closed on every reported clause of the live deliberate-stop proof. */
export function assertTeardownProofSummary(
  summary: TeardownProofSummary,
  requiredStops = 10,
): void {
  const qualifying = summary.inFlightAtStop.filter((count) => count >= 1).length;
  if (
    summary.stopAttempts !== qualifying ||
    summary.totalStops !== summary.inFlightAtStop.length ||
    summary.unqualifiedStops !== summary.totalStops - qualifying ||
    qualifying < requiredStops ||
    summary.stopFailures !== 0 ||
    summary.stopPendingWhileHeld < requiredStops ||
    summary.syncAcceptances < requiredStops ||
    summary.leaseHeldWhileDraining < requiredStops ||
    summary.leaseFreeAfterStop < requiredStops ||
    summary.challengeProduced
  )
    throw new Error("live teardown proof observations are incomplete");
}
