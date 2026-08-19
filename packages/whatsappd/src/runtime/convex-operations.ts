/**
 * A Convex-backed {@link WhatsAppOperationStore}.
 *
 * @remarks
 * Every state a receipt can reach is a pure function of the receipt and the
 * clock, and that function lives in `operations.ts` with its validators. So a
 * transition here reads the receipt and the deployment's clock together,
 * computes the next state in this process, and writes it back naming the
 * revision it was computed from. A receipt that moved meanwhile fails the write
 * and the transition is computed again — the alternative, restating those
 * transitions inside a Convex mutation, is a second copy of the rules that
 * decides which sends are retried.
 *
 * The clock is the deployment's, not this process's, for the same reason the
 * libSQL store reads the database clock: an attempt expires against the clock
 * every worker shares, and two workers with skewed clocks would otherwise
 * disagree about whether a claim is still live.
 *
 * @packageDocumentation
 */
import type { ConvexCalls } from "./convex-client.ts";
import {
  OperationIdempotencyConflictError,
  announceOperationChanges,
  operationInputJson,
  operationSubscription,
  validatedOperationInput,
  validatedOperationResult,
  validatedOperationState,
  validatedOperationSubmission,
  type WhatsAppOperation,
  type WhatsAppOperationState,
  type WhatsAppOperationStore,
} from "./operations.ts";

/**
 * How many times a transition is recomputed against a receipt that moved under
 * it. Operations are executed by the account's single lease holder, so a second
 * pass is already unexpected; the bound turns a pathological deployment into an
 * error instead of a spin.
 */
const WRITE_ATTEMPTS = 8;

const decodeOperation = (value: string): WhatsAppOperation => {
  const held = JSON.parse(value) as WhatsAppOperation;
  const input = validatedOperationInput(held.input);
  return { ...held, input, state: validatedOperationState(held.state, input) };
};

/**
 * One receipt as the compare-and-set write that publishes it.
 *
 * @remarks
 * The state is validated here rather than after the round trip, so a rejected
 * transition — an error carrying a stack, a reason that is not a string —
 * raises before anything durable is touched, leaving the receipt in the state
 * the caller can still see.
 */
const write = (
  operation: WhatsAppOperation,
  expectedRevision: number,
): {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly operation: string;
} => ({
  operationId: operation.id,
  expectedRevision,
  revision: operation.revision,
  operation: JSON.stringify({
    ...operation,
    state: validatedOperationState(operation.state, operation.input),
  }),
});

const terminal = (state: WhatsAppOperationState): boolean =>
  state.status === "succeeded" || state.status === "failed" || state.status === "outcome_unknown";

export function convexOperationStore(calls: ConvexCalls): WhatsAppOperationStore {
  const listeners = new Map<
    string,
    Set<{ readonly notify: (operation: WhatsAppOperation) => void }>
  >();

  const exhausted = (accountId: string): Error =>
    new Error(
      `a WhatsApp operation for account "${accountId}" kept changing under its own transition`,
    );

  const transition = async (
    accountId: string,
    operationId: string,
    change: (current: WhatsAppOperation, at: number) => WhatsAppOperation | undefined,
    returnCurrent = false,
  ): Promise<WhatsAppOperation | undefined> => {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const read = await calls.query("operationGet", { accountId, operationId });
      if (read.operation === null) return undefined;
      const current = decodeOperation(read.operation);
      const next = change(current, read.now);
      if (!next) return returnCurrent ? current : undefined;
      const committed = { ...next, revision: current.revision + 1 };
      const written = await calls.mutation("operationWrite", {
        accountId,
        writes: [write(committed, current.revision)],
      });
      if (written.status === "conflict") continue;
      announceOperationChanges(listeners, accountId, [committed]);
      return structuredClone(committed);
    }
    throw exhausted(accountId);
  };

  return {
    async submit(request) {
      const submission = validatedOperationSubmission(request);
      const input = operationInputJson(submission.input);
      const result = await calls.mutation("operationSubmit", {
        accountId: submission.accountId,
        operationId: submission.id,
        idempotencyKey: submission.idempotencyKey,
        input,
        canonicalInput: input,
      });
      if (result.status === "conflict")
        throw new OperationIdempotencyConflictError(
          submission.accountId,
          submission.idempotencyKey,
        );
      const operation = decodeOperation(result.operation);
      // A repeat submission is the same receipt, not a change: announcing it
      // would wake every consumer for a request that already happened.
      if (result.status === "created")
        announceOperationChanges(listeners, submission.accountId, [operation]);
      return operation;
    },

    async get(accountId, operationId) {
      const read = await calls.query("operationGet", { accountId, operationId });
      return read.operation === null ? undefined : decodeOperation(read.operation);
    },

    async list(accountId) {
      const read = await calls.query("operationList", { accountId });
      return read.operations.map(decodeOperation);
    },

    async claim(accountId, attemptId, ttlMs) {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const read = await calls.query("operationList", { accountId });
        const at = read.now;
        const stored = read.operations.map(decodeOperation);
        /** The revision each touched receipt was read at — its write's guard. */
        const from = new Map(stored.map((operation) => [operation.id, operation.revision]));
        const changed: WhatsAppOperation[] = [];
        const recovered = stored.map((operation) => {
          if (
            (operation.state.status !== "claimed" && operation.state.status !== "executing") ||
            operation.state.expiresAt > at
          )
            return operation;
          // An attempt that expired before it started is simply queued again.
          // One that expired while executing may already have sent, and that
          // is the outcome nobody can recover (ADR-0025).
          const state: WhatsAppOperationState =
            operation.state.status === "claimed"
              ? { status: "queued" }
              : {
                  status: "outcome_unknown",
                  reason: "the executing attempt expired before recording its outcome",
                  completedAt: at,
                };
          const next = { ...operation, state, revision: operation.revision + 1, updatedAt: at };
          changed.push(next);
          return next;
        });
        const queued = recovered.find((operation) => operation.state.status === "queued");
        const claimed = queued && {
          ...queued,
          revision: queued.revision + 1,
          state: { status: "claimed" as const, attemptId, expiresAt: at + ttlMs },
          updatedAt: at,
        };
        if (claimed) changed.push(claimed);
        if (changed.length === 0) return undefined;
        // A receipt recovered and then claimed in the same pass is one row, so
        // it is one write: its guard is the revision it was read at, and its
        // value is the state the pass ended on. Both steps still reach the
        // listeners, which keep the last one per receipt.
        const final = new Map(changed.map((operation) => [operation.id, operation]));
        const written = await calls.mutation("operationWrite", {
          accountId,
          writes: [...final.values()].map((operation) =>
            write(operation, from.get(operation.id) ?? operation.revision),
          ),
        });
        if (written.status === "conflict") continue;
        announceOperationChanges(listeners, accountId, changed);
        return claimed && structuredClone(claimed);
      }
      throw exhausted(accountId);
    },

    async recoveryDelay(accountId) {
      const read = await calls.query("operationList", { accountId });
      const expiries = read.operations.flatMap((value) => {
        const operation = decodeOperation(value);
        return operation.state.status === "claimed" || operation.state.status === "executing"
          ? [operation.state.expiresAt]
          : [];
      });
      return expiries.length === 0 ? undefined : Math.max(0, Math.min(...expiries) - read.now);
    },

    start: (accountId, operationId, attemptId, ttlMs) =>
      transition(accountId, operationId, (current, at) =>
        current.state.status === "claimed" &&
        current.state.attemptId === attemptId &&
        current.state.expiresAt > at
          ? {
              ...current,
              state: { status: "executing", attemptId, startedAt: at, expiresAt: at + ttlMs },
              updatedAt: at,
            }
          : undefined,
      ),

    release: (accountId, operationId, attemptId) =>
      transition(accountId, operationId, (current, at) =>
        current.state.status === "claimed" && current.state.attemptId === attemptId
          ? { ...current, state: { status: "queued" }, updatedAt: at }
          : undefined,
      ),

    succeed: (accountId, operationId, attemptId, result) =>
      transition(accountId, operationId, (current, at) =>
        current.state.status === "executing" && current.state.attemptId === attemptId
          ? {
              ...current,
              state: {
                status: "succeeded",
                result: validatedOperationResult(current.input, result),
                completedAt: at,
              },
              updatedAt: at,
            }
          : undefined,
      ),

    fail: (accountId, operationId, attemptId, error) =>
      transition(accountId, operationId, (current, at) =>
        current.state.status === "claimed" && current.state.attemptId === attemptId
          ? { ...current, state: { status: "failed", error, completedAt: at }, updatedAt: at }
          : undefined,
      ),

    unknown: (accountId, operationId, attemptId, reason) =>
      transition(accountId, operationId, (current, at) =>
        current.state.status === "executing" && current.state.attemptId === attemptId
          ? {
              ...current,
              state: { status: "outcome_unknown", reason, completedAt: at },
              updatedAt: at,
            }
          : undefined,
      ),

    acknowledge: (accountId, operationId) =>
      transition(
        accountId,
        operationId,
        (current, at) =>
          current.acknowledgedAt === undefined && terminal(current.state)
            ? { ...current, acknowledgedAt: at, updatedAt: at }
            : undefined,
        true,
      ),

    subscribe: (accountId, listener) => operationSubscription(listeners, accountId, listener),
  };
}
