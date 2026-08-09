import type { Row, Transaction } from "@libsql/client";
import type { LazyLibsqlClient } from "../stores/libsql.ts";
import { transact } from "./libsql-transaction.ts";
import {
  OperationIdempotencyConflictError,
  announceOperationChanges,
  operationSubscription,
  operationInputJson,
  validatedOperationInput,
  validatedOperationResult,
  validatedOperationState,
  validatedOperationSubmission,
  type WhatsAppOperation,
  type WhatsAppOperationState,
  type WhatsAppOperationStore,
} from "./operations.ts";

const databaseNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`invalid libSQL operation ${label}`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`invalid libSQL operation ${label}`);
  return value;
};

const integer = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`invalid libSQL operation ${label}`);
  return value;
};

function parseOperation(value: unknown): WhatsAppOperation {
  const held = record(value, "record");
  const extra = Object.keys(held).find(
    (key) =>
      ![
        "accountId",
        "id",
        "idempotencyKey",
        "revision",
        "sequence",
        "input",
        "state",
        "submittedAt",
        "updatedAt",
        "acknowledgedAt",
      ].includes(key),
  );
  if (extra) throw new Error(`invalid libSQL operation record member ${extra}`);
  const input = validatedOperationInput(held.input);
  const state = validatedOperationState(held.state, input);
  return {
    accountId: text(held.accountId, "accountId"),
    id: text(held.id, "id"),
    idempotencyKey: text(held.idempotencyKey, "idempotencyKey"),
    revision: integer(held.revision, "revision"),
    sequence: integer(held.sequence, "sequence"),
    input,
    state,
    submittedAt: integer(held.submittedAt, "submittedAt"),
    updatedAt: integer(held.updatedAt, "updatedAt"),
    ...(held.acknowledgedAt !== undefined && {
      acknowledgedAt: integer(held.acknowledgedAt, "acknowledgedAt"),
    }),
  };
}

const fromRow = (row: Row): WhatsAppOperation => {
  const operation = parseOperation(JSON.parse(text(row.operation_json, "operation_json")));
  if (
    operation.accountId !== row.account_id ||
    operation.id !== row.operation_id ||
    operation.idempotencyKey !== row.idempotency_key ||
    operation.sequence !== row.sequence
  )
    throw new Error("invalid libSQL operation identity");
  return operation;
};

const now = async (transaction: Transaction): Promise<number> => {
  const result = await transaction.execute(`SELECT ${databaseNow} AS now`);
  return integer(result.rows[0]?.now, "database clock");
};

const read = async (
  transaction: Transaction,
  accountId: string,
  operationId: string,
): Promise<WhatsAppOperation | undefined> => {
  const result = await transaction.execute({
    sql: `SELECT account_id, operation_id, idempotency_key, sequence, operation_json
      FROM wa_operations WHERE account_id = ? AND operation_id = ?`,
    args: [accountId, operationId],
  });
  return result.rows[0] && fromRow(result.rows[0]);
};

const write = (transaction: Transaction, operation: WhatsAppOperation): Promise<unknown> =>
  transaction.execute({
    sql: `UPDATE wa_operations SET operation_json = ?
      WHERE account_id = ? AND operation_id = ?`,
    args: [JSON.stringify(operation), operation.accountId, operation.id],
  });

const terminal = (state: WhatsAppOperationState): boolean =>
  state.status === "succeeded" || state.status === "failed" || state.status === "outcome_unknown";

export function libsqlOperationStore(client: LazyLibsqlClient): WhatsAppOperationStore {
  const listeners = new Map<
    string,
    Set<{ readonly notify: (operation: WhatsAppOperation) => void }>
  >();
  const mutate = async <T>(
    accountId: string,
    work: (transaction: Transaction) => Promise<{ result: T; changed: WhatsAppOperation[] }>,
  ): Promise<T> => {
    const committed = await transact(client, "write", work);
    announceOperationChanges(listeners, accountId, committed.changed);
    return structuredClone(committed.result);
  };
  const transition = (
    accountId: string,
    operationId: string,
    change: (current: WhatsAppOperation, at: number) => WhatsAppOperation | undefined,
    returnCurrent = false,
  ): Promise<WhatsAppOperation | undefined> =>
    mutate(accountId, async (transaction) => {
      const current = await read(transaction, accountId, operationId);
      if (!current) return { result: undefined, changed: [] };
      const next = change(current, await now(transaction));
      if (!next) return { result: returnCurrent ? current : undefined, changed: [] };
      const committed = { ...next, revision: current.revision + 1 };
      await write(transaction, committed);
      return { result: committed, changed: [committed] };
    });

  return {
    submit(request) {
      const submission = validatedOperationSubmission(request);
      return mutate(submission.accountId, async (transaction) => {
        const existing = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, sequence, operation_json
            FROM wa_operations WHERE account_id = ? AND idempotency_key = ?`,
          args: [submission.accountId, submission.idempotencyKey],
        });
        if (existing.rows[0]) {
          const operation = fromRow(existing.rows[0]);
          if (operationInputJson(operation.input) !== operationInputJson(submission.input))
            throw new OperationIdempotencyConflictError(
              submission.accountId,
              submission.idempotencyKey,
            );
          return { result: operation, changed: [] };
        }
        const at = await now(transaction);
        const sequenceResult = await transaction.execute({
          sql: "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM wa_operations WHERE account_id = ?",
          args: [submission.accountId],
        });
        const sequence = integer(sequenceResult.rows[0]?.sequence, "next operation sequence");
        const operation: WhatsAppOperation = {
          ...submission,
          revision: 0,
          sequence,
          state: { status: "queued" },
          submittedAt: at,
          updatedAt: at,
        };
        await transaction.execute({
          sql: `INSERT INTO wa_operations
            (account_id, operation_id, idempotency_key, submitted_at, sequence, operation_json)
            VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            submission.accountId,
            submission.id,
            submission.idempotencyKey,
            at,
            sequence,
            JSON.stringify(operation),
          ],
        });
        return { result: operation, changed: [operation] };
      });
    },

    get: (accountId, operationId) =>
      transact(client, "read", (transaction) => read(transaction, accountId, operationId)),

    list(accountId) {
      return transact(client, "read", async (transaction) => {
        const result = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, sequence, operation_json
            FROM wa_operations WHERE account_id = ? ORDER BY sequence`,
          args: [accountId],
        });
        return result.rows.map(fromRow);
      });
    },

    claim(accountId, attemptId, ttlMs) {
      return mutate(accountId, async (transaction) => {
        const at = await now(transaction);
        const result = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, sequence, operation_json
            FROM wa_operations WHERE account_id = ? ORDER BY sequence`,
          args: [accountId],
        });
        const operations = result.rows.map(fromRow);
        const changed: WhatsAppOperation[] = [];
        for (const operation of operations) {
          if (
            (operation.state.status !== "claimed" && operation.state.status !== "executing") ||
            operation.state.expiresAt > at
          )
            continue;
          const state: WhatsAppOperationState =
            operation.state.status === "claimed"
              ? { status: "queued" }
              : {
                  status: "outcome_unknown",
                  reason: "the executing attempt expired before recording its outcome",
                  completedAt: at,
                };
          Object.assign(operation, {
            state,
            revision: operation.revision + 1,
            updatedAt: at,
          });
          await write(transaction, operation);
          changed.push(operation);
        }
        const queued = operations.find((operation) => operation.state.status === "queued");
        if (!queued) return { result: undefined, changed };
        const claimed: WhatsAppOperation = {
          ...queued,
          revision: queued.revision + 1,
          state: { status: "claimed", attemptId, expiresAt: at + ttlMs },
          updatedAt: at,
        };
        await write(transaction, claimed);
        changed.push(claimed);
        return { result: claimed, changed };
      });
    },

    recoveryDelay(accountId) {
      return transact(client, "read", async (transaction) => {
        const at = await now(transaction);
        const result = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, sequence, operation_json
            FROM wa_operations WHERE account_id = ? ORDER BY sequence`,
          args: [accountId],
        });
        const expiries = result.rows.flatMap((row) => {
          const operation = fromRow(row);
          return operation.state.status === "claimed" || operation.state.status === "executing"
            ? [operation.state.expiresAt]
            : [];
        });
        return expiries.length === 0 ? undefined : Math.max(0, Math.min(...expiries) - at);
      });
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
          ? {
              ...current,
              state: { status: "failed", error, completedAt: at },
              updatedAt: at,
            }
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

    subscribe(accountId, listener) {
      return operationSubscription(listeners, accountId, listener);
    },
  };
}
