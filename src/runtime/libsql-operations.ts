import type { Row, Transaction } from "@libsql/client";
import type { LazyLibsqlClient } from "../stores/libsql.ts";
import { transact } from "./libsql-transaction.ts";
import {
  OperationIdempotencyConflictError,
  announceOperationChanges,
  operationSubscription,
  operationInputJson,
  type WhatsAppOperation,
  type WhatsAppOperationInput,
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
  const input = record(held.input, "input");
  if (input.version !== 1 || !["send", "mark_read", "phone_history"].includes(String(input.type)))
    throw new Error("invalid libSQL operation input version or type");
  const state = record(held.state, "state");
  if (
    !["queued", "claimed", "executing", "succeeded", "failed", "outcome_unknown"].includes(
      String(state.status),
    )
  )
    throw new Error("invalid libSQL operation state");
  return {
    accountId: text(held.accountId, "accountId"),
    id: text(held.id, "id"),
    idempotencyKey: text(held.idempotencyKey, "idempotencyKey"),
    revision: integer(held.revision, "revision"),
    input: input as unknown as WhatsAppOperationInput,
    state: state as unknown as WhatsAppOperationState,
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
    operation.idempotencyKey !== row.idempotency_key
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
    sql: `SELECT account_id, operation_id, idempotency_key, operation_json
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
  const listeners = new Map<string, Set<(operationId: string) => void>>();
  const mutate = async <T>(
    accountId: string,
    work: (transaction: Transaction) => Promise<{ result: T; changed: string[] }>,
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
      return { result: committed, changed: [operationId] };
    });

  return {
    submit(request) {
      return mutate(request.accountId, async (transaction) => {
        const existing = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, operation_json
            FROM wa_operations WHERE account_id = ? AND idempotency_key = ?`,
          args: [request.accountId, request.idempotencyKey],
        });
        if (existing.rows[0]) {
          const operation = fromRow(existing.rows[0]);
          if (operationInputJson(operation.input) !== operationInputJson(request.input))
            throw new OperationIdempotencyConflictError(request.accountId, request.idempotencyKey);
          return { result: operation, changed: [] };
        }
        const at = await now(transaction);
        const operation: WhatsAppOperation = {
          ...request,
          revision: 0,
          input: structuredClone(request.input),
          state: { status: "queued" },
          submittedAt: at,
          updatedAt: at,
        };
        await transaction.execute({
          sql: `INSERT INTO wa_operations
            (account_id, operation_id, idempotency_key, submitted_at, operation_json)
            VALUES (?, ?, ?, ?, ?)`,
          args: [
            request.accountId,
            request.id,
            request.idempotencyKey,
            at,
            JSON.stringify(operation),
          ],
        });
        return { result: operation, changed: [operation.id] };
      });
    },

    get: (accountId, operationId) =>
      transact(client, "read", (transaction) => read(transaction, accountId, operationId)),

    list(accountId) {
      return transact(client, "read", async (transaction) => {
        const result = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, operation_json
            FROM wa_operations WHERE account_id = ? ORDER BY submitted_at, operation_id`,
          args: [accountId],
        });
        return result.rows.map(fromRow);
      });
    },

    claim(accountId, attemptId, ttlMs) {
      return mutate(accountId, async (transaction) => {
        const at = await now(transaction);
        const result = await transaction.execute({
          sql: `SELECT account_id, operation_id, idempotency_key, operation_json
            FROM wa_operations WHERE account_id = ? ORDER BY submitted_at, operation_id`,
          args: [accountId],
        });
        const operations = result.rows.map(fromRow);
        const changed: string[] = [];
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
          changed.push(operation.id);
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
        changed.push(claimed.id);
        return { result: claimed, changed };
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
              state: { status: "succeeded", result, completedAt: at },
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
