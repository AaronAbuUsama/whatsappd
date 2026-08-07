import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MessageRef, SendOptions } from "../model/outbound.ts";
import type { Unsubscribe } from "../subscription.ts";

export interface OperationClock {
  now(): number | Promise<number>;
}

export interface SerializedOperationError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

export type WhatsAppOperationInput = {
  readonly type: "send";
  readonly chatId: string;
  readonly content: { readonly text: string };
  readonly options?: SendOptions;
};

export type WhatsAppOperationState<Result = unknown> =
  | { readonly status: "queued" }
  | { readonly status: "claimed"; readonly attemptId: string; readonly expiresAt: number }
  | {
      readonly status: "executing";
      readonly attemptId: string;
      readonly startedAt: number;
      readonly expiresAt: number;
    }
  | { readonly status: "succeeded"; readonly result: Result; readonly completedAt: number }
  | {
      readonly status: "failed";
      readonly error: SerializedOperationError;
      readonly completedAt: number;
    }
  | { readonly status: "outcome_unknown"; readonly reason: string; readonly completedAt: number };

export interface WhatsAppOperation<Result = unknown> {
  readonly accountId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly input: WhatsAppOperationInput;
  readonly state: WhatsAppOperationState<Result>;
  readonly submittedAt: number;
  readonly updatedAt: number;
}

export interface WhatsAppOperationStore {
  submit(input: {
    readonly accountId: string;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: WhatsAppOperationInput;
  }): Promise<WhatsAppOperation>;
  get(accountId: string, operationId: string): Promise<WhatsAppOperation | undefined>;
  subscribe(
    accountId: string,
    operationId: string,
    listener: (operation: WhatsAppOperation) => void,
  ): Unsubscribe;
  recoverExpired(accountId: string): Promise<number>;
  claimNext(accountId: string, ttlMs: number): Promise<WhatsAppOperation | undefined>;
  start(accountId: string, operationId: string, attemptId: string, ttlMs: number): Promise<boolean>;
  succeed(
    accountId: string,
    operationId: string,
    attemptId: string,
    result: unknown,
  ): Promise<boolean>;
  fail(
    accountId: string,
    operationId: string,
    attemptId: string,
    error: SerializedOperationError,
  ): Promise<boolean>;
  markUnknown(
    accountId: string,
    operationId: string,
    attemptId: string,
    reason: string,
  ): Promise<boolean>;
}

export class OperationIdempotencyConflictError extends Error {
  readonly accountId: string;
  readonly idempotencyKey: string;

  constructor(accountId: string, idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" already names a different WhatsApp operation`);
    this.name = "OperationIdempotencyConflictError";
    this.accountId = accountId;
    this.idempotencyKey = idempotencyKey;
  }
}

const owned = <T>(value: T): T => structuredClone(value);

export function notifyOperationListener(
  listener: (operation: WhatsAppOperation) => void,
  operation: WhatsAppOperation,
): void {
  try {
    listener(owned(operation));
  } catch (error) {
    process.emitWarning(
      error instanceof Error ? error : new Error("a WhatsApp operation observer failed"),
    );
  }
}

export function fanoutOperationListeners(
  listeners: ReadonlySet<(operation: WhatsAppOperation) => void>,
  operation: WhatsAppOperation,
): void {
  const receiving = Array.from(listeners);
  for (const listener of receiving)
    if (listeners.has(listener)) notifyOperationListener(listener, operation);
}

export function sameOperationInput(
  left: WhatsAppOperationInput,
  right: WhatsAppOperationInput,
): boolean {
  return isDeepStrictEqual(left, right);
}

export function sanitizeOperationError(error: unknown): SerializedOperationError {
  let name = "Error";
  let message = "operation failed";
  let code: string | number | undefined;
  const field = (key: "name" | "message" | "code"): unknown => {
    if (typeof error !== "object" || error === null) return undefined;
    try {
      return Reflect.get(error, key);
    } catch {}
    return undefined;
  };
  const candidateName = field("name");
  const candidateMessage = field("message");
  const candidateCode = field("code");
  if (typeof candidateName === "string" && candidateName) name = candidateName;
  if (typeof candidateMessage === "string" && candidateMessage) message = candidateMessage;
  if (typeof candidateCode === "string" || typeof candidateCode === "number") code = candidateCode;
  return owned({ name, message, ...(code !== undefined && { code }) });
}

function operationAbortReason(signal: AbortSignal): unknown {
  try {
    return signal.reason;
  } catch {
    return new DOMException("operation aborted", "AbortError");
  }
}

export async function awaitOperationSubmission(
  submission: Promise<WhatsAppOperation>,
  signal: AbortSignal | undefined,
): Promise<WhatsAppOperation> {
  if (!signal) return submission;
  if (signal.aborted) throw operationAbortReason(signal);
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(operationAbortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void submission.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export interface OperationSession {
  send?(to: string, content: { readonly text: string }, options?: SendOptions): Promise<MessageRef>;
}

export interface OperationExecutor {
  wake(): void;
  resume(): void;
  pause(): void;
  stop(): Promise<void>;
}

function validate(input: WhatsAppOperationInput): void {
  if (!input.chatId) throw new TypeError("send chatId must not be empty");
  if (typeof input.content.text !== "string" || input.content.text.length === 0)
    throw new TypeError("send text must not be empty");
}

async function executeClaimed(
  store: WhatsAppOperationStore,
  session: OperationSession,
  operation: WhatsAppOperation,
  ttlMs: number,
): Promise<void> {
  if (operation.state.status !== "claimed") return;
  const { attemptId } = operation.state;
  const send = (...args: Parameters<NonNullable<OperationSession["send"]>>) =>
    session.send!(...args);
  try {
    validate(operation.input);
    if (!session.send) throw new TypeError("runtime session does not support sends");
    if (!(await store.start(operation.accountId, operation.id, attemptId, ttlMs))) {
      await store.recoverExpired(operation.accountId);
      return;
    }
  } catch (error) {
    if (
      !(await store.fail(
        operation.accountId,
        operation.id,
        attemptId,
        sanitizeOperationError(error),
      ))
    )
      await store.recoverExpired(operation.accountId);
    return;
  }

  let result: MessageRef;
  try {
    result = await send(operation.input.chatId, operation.input.content, operation.input.options);
  } catch {
    if (
      !(await store.markUnknown(
        operation.accountId,
        operation.id,
        attemptId,
        "session_call_failed",
      ))
    )
      await store.recoverExpired(operation.accountId);
    return;
  }

  try {
    if (!(await store.succeed(operation.accountId, operation.id, attemptId, result)))
      await store.recoverExpired(operation.accountId);
  } catch {
    if (
      !(await store.markUnknown(
        operation.accountId,
        operation.id,
        attemptId,
        "completion_not_recorded",
      ))
    )
      await store.recoverExpired(operation.accountId);
  }
}

export function createOperationExecutor(input: {
  readonly accountId: string;
  readonly store: WhatsAppOperationStore;
  readonly session: OperationSession;
  readonly attemptTtlMs?: number;
  readonly onError?: (error: unknown) => void;
}): OperationExecutor {
  const ttlMs = input.attemptTtlMs ?? 30_000;
  let stopped = false;
  let active = false;
  let requested = false;
  let recover = false;
  let release: (() => void) | undefined;

  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      release = resolve;
    });
  const wakeLoop = (): void => {
    const waiting = release;
    release = undefined;
    waiting?.();
  };

  const running = (async () => {
    while (!stopped) {
      if (!active || !requested) await wait();
      if (stopped) break;
      if (!active) continue;
      requested = false;
      if (recover) {
        recover = false;
        await input.store.recoverExpired(input.accountId);
      }
      while (active && !stopped) {
        const operation = await input.store.claimNext(input.accountId, ttlMs);
        if (!operation || stopped || !active) break;
        await executeClaimed(input.store, input.session, operation, ttlMs);
      }
    }
  })();
  void running.catch((error) => input.onError?.(error));

  return {
    wake() {
      requested = true;
      wakeLoop();
    },
    resume() {
      active = true;
      recover = true;
      requested = true;
      wakeLoop();
    },
    pause() {
      active = false;
    },
    async stop() {
      stopped = true;
      wakeLoop();
      await running;
    },
  };
}

export const operationId = (): string => crypto.randomUUID();
