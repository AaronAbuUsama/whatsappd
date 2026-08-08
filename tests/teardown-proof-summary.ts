export type TeardownProofKind = "synthetic_regression_control" | "native_observation";

export interface LeaseLossGuardSummary {
  readonly lossKind: "renewal_lost";
  readonly rejectionObserved: boolean;
  readonly mirrorRevisionBefore: number;
  readonly mirrorRevisionAfter: number;
  readonly mirrorUnchanged: boolean;
}

export interface TeardownProofSummary {
  readonly kind: TeardownProofKind;
  readonly attemptBudget: number;
  readonly qualifyingStops: number;
  readonly totalStops: number;
  readonly unqualifiedStops: number;
  readonly stopFailures: number;
  readonly inFlightAtStop: readonly number[];
  readonly stopPendingWhileHeld: number;
  readonly syncAcceptances: number;
  readonly leaseHeldWhileDraining: number;
  readonly leaseFreeAfterStop: number;
  readonly challengeProduced: boolean;
  readonly countsTowardNativeFloor: boolean;
  readonly leaseLossGuard?: LeaseLossGuardSummary;
}

function assertAccounting(summary: TeardownProofSummary): number {
  const qualifying = summary.inFlightAtStop.filter((count) => count >= 1).length;
  if (
    summary.attemptBudget !== summary.totalStops ||
    summary.qualifyingStops !== qualifying ||
    summary.totalStops !== summary.inFlightAtStop.length ||
    summary.unqualifiedStops !== summary.totalStops - qualifying ||
    summary.stopFailures !== 0 ||
    summary.stopPendingWhileHeld < qualifying ||
    summary.syncAcceptances < qualifying ||
    summary.leaseHeldWhileDraining < qualifying ||
    summary.leaseFreeAfterStop < qualifying ||
    summary.challengeProduced
  )
    throw new Error("teardown proof observations are internally inconsistent");
  return qualifying;
}

/** The injected batch is a deterministic regression control, never native proof. */
export function assertSyntheticTeardownControl(
  summary: TeardownProofSummary,
  requiredStops = 10,
): void {
  const qualifying = assertAccounting(summary);
  if (
    summary.kind !== "synthetic_regression_control" ||
    summary.countsTowardNativeFloor ||
    qualifying < requiredStops ||
    summary.leaseLossGuard !== undefined
  )
    throw new Error("synthetic teardown regression control is incomplete or mislabelled");
}

/**
 * Validate an honest fixed-budget native observation.
 *
 * Returns whether the historical ten-qualifying-stop floor was reached. A
 * shortfall remains a valid observation, but must be reported for adjudication.
 */
export function assertNativeTeardownObservation(
  summary: TeardownProofSummary,
  requiredStops = 10,
): boolean {
  const qualifying = assertAccounting(summary);
  const guard = summary.leaseLossGuard;
  if (
    summary.kind !== "native_observation" ||
    !summary.countsTowardNativeFloor ||
    !guard ||
    guard.lossKind !== "renewal_lost" ||
    !guard.rejectionObserved ||
    !guard.mirrorUnchanged ||
    guard.mirrorRevisionAfter !== guard.mirrorRevisionBefore
  )
    throw new Error("native teardown observation or lease-loss guard is incomplete");
  return qualifying >= requiredStops;
}
