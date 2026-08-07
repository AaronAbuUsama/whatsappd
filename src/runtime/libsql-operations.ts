import type { Row, Transaction } from "@libsql/client";
import type { LazyLibsqlClient } from "../stores/libsql.ts";
import { transact } from "./libsql-transaction.ts";
import {
  fanoutOperationListeners,
  OperationIdempotencyConflictError,
  notifyOperationListener,
  operationId,
  sameOperationInput,
  type OperationClock,
  type SerializedOperationError,
  type WhatsAppOperation,
  type WhatsAppOperationInput,
  type WhatsAppOperationState,
  type WhatsAppOperationStore,
} from "./operations.ts";

const databaseNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`invalid libSQL operation ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`invalid libSQL operation ${label}`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : integer(value, label);
}

function parsed(value: unknown, label: string): unknown {
  try {
    return JSON.parse(text(value, label));
  } catch (error) {
    throw new Error(`invalid libSQL operation ${label}`, { cause: error });
  }
}

function operationInput(value: unknown): WhatsAppOperationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid libSQL operation input_json");
  const input = value as Record<string, unknown>;
  if (input.type !== "send") throw new Error("invalid libSQL operation input type");
  if (
    typeof input.content !== "object" ||
    input.content === null ||
    Array.isArray(input.content) ||
    typeof (input.content as Record<string, unknown>).text !== "string"
  )
    throw new Error("invalid libSQL operation send content");
  return structuredClone(value) as WhatsAppOperationInput;
}

function serializedError(value: unknown): SerializedOperationError {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid libSQL operation error_json");
  const error = value as Record<string, unknown>;
  const code = error.code;
  if (code !== undefined && typeof code !== "string" && typeof code !== "number")
    throw new Error("invalid libSQL operation error code");
  return {
    name: text(error.name, "error name"),
    message: text(error.message, "error message"),
    ...(code !== undefined && { code }),
  };
}

function operation(row: Row): WhatsAppOperation {
  const status = text(row.status, "status");
  const completedAt = optionalInteger(row.completed_at, "completed_at");
  let state: WhatsAppOperationState;
  switch (status) {
    case "queued":
      state = { status };
      break;
    case "claimed":
      state = {
        status,
        attemptId: text(row.attempt_id, "attempt_id"),
        expiresAt: integer(row.lease_expires_at, "lease_expires_at"),
      };
      break;
    case "executing":
      state = {
        status,
        attemptId: text(row.attempt_id, "attempt_id"),
        startedAt: integer(row.started_at, "started_at"),
        expiresAt: integer(row.lease_expires_at, "lease_expires_at"),
      };
      break;
    case "succeeded":
      state = {
        status,
        result: parsed(row.result_json, "result_json"),
        completedAt:
          completedAt ??
          (() => {
            throw new Error("invalid libSQL operation completed_at");
          })(),
      };
      break;
    case "failed":
      state = {
        status,
        error: serializedError(parsed(row.error_json, "error_json")),
        completedAt:
          completedAt ??
          (() => {
            throw new Error("invalid libSQL operation completed_at");
          })(),
      };
      break;
    case "outcome_unknown":
      state = {
        status,
        reason: text(row.unknown_reason, "unknown_reason"),
        completedAt:
          completedAt ??
          (() => {
            throw new Error("invalid libSQL operation completed_at");
          })(),
      };
      break;
    default:
      throw new Error(`invalid libSQL operation status ${status}`);
  }
  return {
    accountId: text(row.account_id, "account_id"),
    id: text(row.operation_id, "operation_id"),
    idempotencyKey: text(row.idempotency_key, "idempotency_key"),
    input: operationInput(parsed(row.input_json, "input_json")),
    state,
    submittedAt: integer(row.submitted_at, "submitted_at"),
    updatedAt: integer(row.updated_at, "updated_at"),
  };
}

const columns = `operation_id, account_id, idempotency_key, input_json, status,
  attempt_id, lease_expires_at, started_at, result_json, error_json,
  unknown_reason, submitted_at, updated_at, completed_at`;

async function now(transaction: Transaction, clock: OperationClock | undefined): Promise<number> {
  if (clock) {
    const value = await clock.now();
    if (!Number.isSafeInteger(value)) throw new RangeError(`operation clock returned ${value}`);
    return value;
  }
  const result = await transaction.execute(`SELECT ${databaseNow} AS now`);
  return integer(result.rows[0]?.now, "database clock");
}

export function libsqlOperationStore(
  client: LazyLibsqlClient,
  clock?: OperationClock,
): WhatsAppOperationStore {
  const listeners = new Map<string, Set<(value: WhatsAppOperation) => void>>();
  const observed = new Map<string, WhatsAppOperation>();
  const listenerKey = (accountId: string, operationIdValue: string): string =>
    `${accountId}\0${operationIdValue}`;
  const publish = (value: WhatsAppOperation): void => {
    const key = listenerKey(value.accountId, value.id);
    observed.set(key, value);
    const subscriptions = listeners.get(key);
    if (subscriptions) fanoutOperationListeners(subscriptions, value);
    else
      setImmediate(() => {
        if (!listeners.has(key) && observed.get(key) === value) observed.delete(key);
      });
  };
  const read = async (
    transaction: Transaction,
    accountId: string,
    operationIdValue: string,
  ): Promise<WhatsAppOperation | undefined> => {
    const result = await transaction.execute({
      sql: `SELECT ${columns} FROM wa_operations
        WHERE account_id = ? AND operation_id = ?`,
      args: [accountId, operationIdValue],
    });
    const row = result.rows[0];
    return row && operation(row);
  };
  const changed = async (
    accountId: string,
    operationIdValue: string,
    statement: (transaction: Transaction, at: number) => Promise<number>,
  ): Promise<boolean> => {
    const value = await transact(client, "write", async (transaction) => {
      const at = await now(transaction, clock);
      if ((await statement(transaction, at)) !== 1) return undefined;
      return read(transaction, accountId, operationIdValue);
    });
    if (value) publish(value);
    return value !== undefined;
  };
  const get = (accountId: string, operationIdValue: string) =>
    transact(client, "read", (transaction) => read(transaction, accountId, operationIdValue));

  return {
    async submit(input) {
      const submitted = await transact(client, "write", async (transaction) => {
        const existing = await transaction.execute({
          sql: `SELECT ${columns} FROM wa_operations
            WHERE account_id = ? AND idempotency_key = ?`,
          args: [input.accountId, input.idempotencyKey],
        });
        const row = existing.rows[0];
        if (row) {
          const replay = operation(row);
          if (!sameOperationInput(replay.input, input.operation))
            throw new OperationIdempotencyConflictError(input.accountId, input.idempotencyKey);
          return { operation: replay, created: false };
        }
        const at = await now(transaction, clock);
        await transaction.execute({
          sql: `INSERT INTO wa_operations
            (operation_id, account_id, idempotency_key, input_json, status, submitted_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
          args: [
            input.id,
            input.accountId,
            input.idempotencyKey,
            JSON.stringify(input.operation),
            at,
            at,
          ],
        });
        const created = await read(transaction, input.accountId, input.id);
        if (!created) throw new Error("libSQL operation insert returned no row");
        return { operation: created, created: true };
      });
      if (submitted.created) publish(submitted.operation);
      return submitted.operation;
    },
    get,
    subscribe(accountId, operationIdValue, listener) {
      const key = listenerKey(accountId, operationIdValue);
      const subscriptions = listeners.get(key) ?? new Set();
      subscriptions.add(listener);
      listeners.set(key, subscriptions);
      const current = observed.get(key);
      if (current) notifyOperationListener(listener, current);
      else
        void get(accountId, operationIdValue).then((loaded) => {
          if (!loaded || !subscriptions.has(listener) || observed.has(key)) return;
          publish(loaded);
        });
      return () => {
        subscriptions.delete(listener);
        if (subscriptions.size === 0) {
          listeners.delete(key);
          observed.delete(key);
        }
      };
    },
    async recoverExpired(accountId) {
      const recovered = await transact(client, "write", async (transaction) => {
        const at = await now(transaction, clock);
        const result = await transaction.execute({
          sql: `UPDATE wa_operations SET
              status = CASE status WHEN 'claimed' THEN 'queued' ELSE 'outcome_unknown' END,
              attempt_id = NULL,
              lease_expires_at = NULL,
              started_at = CASE status WHEN 'claimed' THEN NULL ELSE started_at END,
              unknown_reason = CASE status WHEN 'executing' THEN 'execution_lease_expired' END,
              completed_at = CASE status WHEN 'executing' THEN ? END,
              updated_at = ?
            WHERE account_id = ? AND status IN ('claimed', 'executing')
              AND lease_expires_at <= ?
            RETURNING ${columns}`,
          args: [at, at, accountId, at],
        });
        return result.rows.map(operation);
      });
      for (const value of recovered) publish(value);
      return recovered.length;
    },
    async claimNext(accountId, ttlMs) {
      const claimed = await transact(client, "write", async (transaction) => {
        const at = await now(transaction, clock);
        const result = await transaction.execute({
          sql: `UPDATE wa_operations SET status = 'claimed', attempt_id = ?,
              lease_expires_at = ?, updated_at = ?
            WHERE operation_id = (
              SELECT operation_id FROM wa_operations
              WHERE account_id = ? AND status = 'queued'
              ORDER BY submitted_at, operation_id LIMIT 1
            ) AND account_id = ? AND status = 'queued'
            RETURNING ${columns}`,
          args: [operationId(), at + ttlMs, at, accountId, accountId],
        });
        const row = result.rows[0];
        return row && operation(row);
      });
      if (claimed) publish(claimed);
      return claimed;
    },
    start(accountId, operationIdValue, attemptId, ttlMs) {
      return changed(accountId, operationIdValue, async (transaction, at) => {
        const result = await transaction.execute({
          sql: `UPDATE wa_operations SET status = 'executing', started_at = ?,
              lease_expires_at = ?, updated_at = ?
            WHERE account_id = ? AND operation_id = ? AND status = 'claimed'
              AND attempt_id = ? AND lease_expires_at > ?`,
          args: [at, at + ttlMs, at, accountId, operationIdValue, attemptId, at],
        });
        return result.rowsAffected;
      });
    },
    succeed(accountId, operationIdValue, attemptId, result) {
      return changed(accountId, operationIdValue, async (transaction, at) => {
        const updated = await transaction.execute({
          sql: `UPDATE wa_operations SET status = 'succeeded', result_json = ?,
              attempt_id = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE account_id = ? AND operation_id = ? AND status = 'executing'
              AND attempt_id = ? AND lease_expires_at > ?`,
          args: [JSON.stringify(result), at, at, accountId, operationIdValue, attemptId, at],
        });
        return updated.rowsAffected;
      });
    },
    fail(accountId, operationIdValue, attemptId, error) {
      return changed(accountId, operationIdValue, async (transaction, at) => {
        const result = await transaction.execute({
          sql: `UPDATE wa_operations SET status = 'failed', error_json = ?,
              attempt_id = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE account_id = ? AND operation_id = ? AND status = 'claimed'
              AND attempt_id = ? AND lease_expires_at > ?`,
          args: [JSON.stringify(error), at, at, accountId, operationIdValue, attemptId, at],
        });
        return result.rowsAffected;
      });
    },
    markUnknown(accountId, operationIdValue, attemptId, reason) {
      return changed(accountId, operationIdValue, async (transaction, at) => {
        const result = await transaction.execute({
          sql: `UPDATE wa_operations SET status = 'outcome_unknown', unknown_reason = ?,
              attempt_id = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE account_id = ? AND operation_id = ? AND status = 'executing'
              AND attempt_id = ? AND lease_expires_at > ?`,
          args: [reason, at, at, accountId, operationIdValue, attemptId, at],
        });
        return result.rowsAffected;
      });
    },
  };
}
