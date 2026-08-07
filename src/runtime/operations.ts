import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BinaryInput, MessageRef, Outbound, SendOptions } from "../model/outbound.ts";
import type { Unsubscribe } from "../subscription.ts";
import { bytesOfBinaryInput } from "./binary-input.ts";
import type { MediaStore } from "./contracts.ts";
import type { OperationSession } from "./operation-session.ts";

export interface OperationClock {
  now(): number | Promise<number>;
}

export interface SerializedOperationError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

interface DurableMediaBase {
  readonly ref: string;
  readonly byteLength: number;
}

export type DurableMediaInput =
  | (DurableMediaBase & {
      readonly kind: "image";
      readonly caption?: string;
    })
  | (DurableMediaBase & {
      readonly kind: "video";
      readonly caption?: string;
      readonly gifPlayback?: boolean;
    })
  | (DurableMediaBase & {
      readonly kind: "audio";
      readonly ptt?: boolean;
      readonly seconds?: number;
      readonly mimetype?: string;
    })
  | (DurableMediaBase & {
      readonly kind: "document";
      readonly fileName: string;
      readonly mimetype: string;
      readonly caption?: string;
    })
  | (DurableMediaBase & {
      readonly kind: "sticker";
    });

export type DurableOutbound = { readonly text: string } | { readonly media: DurableMediaInput };

export type WhatsAppOperationInput =
  | {
      readonly type: "send";
      readonly chatId: string;
      readonly content: DurableOutbound;
      readonly options?: SendOptions;
    }
  | { readonly type: "mark_read"; readonly refs: readonly MessageRef[] }
  | { readonly type: "typing"; readonly chatId: string; readonly on: boolean }
  | {
      readonly type: "phone_history";
      readonly anchor: { readonly ref: MessageRef; readonly timestamp: number };
      readonly count: number;
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
  get(
    accountId: string,
    operationIds: readonly string[],
  ): Promise<readonly (WhatsAppOperation | undefined)[]>;
  list(accountId: string): Promise<readonly WhatsAppOperation[]>;
  subscribe(
    accountId: string,
    operationId: string,
    listener: (operation: WhatsAppOperation) => void,
  ): Unsubscribe;
  recoverExpired(accountId: string): Promise<number>;
  claimNext(accountId: string, ttlMs: number): Promise<WhatsAppOperation | undefined>;
  releaseClaim(accountId: string, operationId: string, attemptId: string): Promise<boolean>;
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

const FORBIDDEN_OPERATION_KEYS = new Set([
  "stack",
  "creds",
  "noisekey",
  "signedidentitykey",
  "signedprekey",
  "pairingcode",
  "bytes",
  "stream",
  "buffer",
]);

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

function normalizedJson(
  value: unknown,
  seen = new WeakSet<object>(),
  path = "operation JSON",
): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("operation input numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value !== "object")
    throw new TypeError(`operation input contains unsupported ${typeof value}`);
  if (seen.has(value)) throw new TypeError("operation input must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1)
        if (!Object.hasOwn(value, index))
          throw new TypeError(`${path} must not contain sparse arrays`);
      return value.map((item, index) => normalizedJson(item, seen, `${path}[${index}]`));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new TypeError("operation input must contain only plain JSON objects");
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => {
          if (FORBIDDEN_OPERATION_KEYS.has(key.toLowerCase()))
            throw new TypeError(`operation JSON contains forbidden key ${key}`);
          return [key, normalizedJson(nested, seen, `${path}.${key}`)];
        }),
    );
  } finally {
    seen.delete(value);
  }
}

export function normalizeOperationJson(value: unknown): unknown {
  return normalizedJson(value);
}

export function normalizeOperationInput(input: WhatsAppOperationInput): WhatsAppOperationInput {
  const normalized = normalizeOperationJson(input) as WhatsAppOperationInput;
  if (normalized.type !== "send" || normalized.options === undefined) return normalized;
  const options = normalized.options as {
    quote?: MessageRef;
    mentions?: readonly string[];
  };
  if (options.mentions?.length === 0) delete options.mentions;
  if (options.quote === undefined && options.mentions === undefined)
    delete (normalized as { options?: SendOptions }).options;
  return normalized;
}

export function sameOperationInput(
  left: WhatsAppOperationInput,
  right: WhatsAppOperationInput,
): boolean {
  return isDeepStrictEqual(left, right);
}

export function sanitizeOperationError(error: unknown): SerializedOperationError {
  let name = "Error";
  const message = "operation failed before Session call";
  let code: string | number | undefined;
  const field = (key: "name" | "message" | "code"): unknown => {
    if (typeof error !== "object" || error === null) return undefined;
    try {
      return Reflect.get(error, key);
    } catch {}
    return undefined;
  };
  const candidateName = field("name");
  const candidateCode = field("code");
  if (typeof candidateName === "string" && candidateName) name = candidateName;
  if (
    typeof candidateCode === "string" ||
    (typeof candidateCode === "number" && Number.isFinite(candidateCode))
  )
    code = candidateCode;
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
  submit: () => Promise<WhatsAppOperation>,
  signal: AbortSignal | undefined,
): Promise<WhatsAppOperation> {
  if (!signal) return submit();
  if (signal.aborted) throw operationAbortReason(signal);
  const submission = submit();
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(operationAbortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void submission.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export interface OperationExecutor {
  wake(): void;
  resume(): void;
  pause(): void;
  stop(): Promise<void>;
}

function mediaOutbound(media: DurableMediaInput, bytes: Uint8Array): Outbound {
  const binary = Buffer.from(bytes);
  switch (media.kind) {
    case "image":
      return { image: binary, ...(media.caption !== undefined && { caption: media.caption }) };
    case "video":
      return {
        video: binary,
        ...(media.caption !== undefined && { caption: media.caption }),
        ...(media.gifPlayback !== undefined && { gifPlayback: media.gifPlayback }),
      };
    case "audio":
      return {
        audio: binary,
        ...(media.ptt !== undefined && { ptt: media.ptt }),
        ...(media.seconds !== undefined && { seconds: media.seconds }),
        ...(media.mimetype !== undefined && { mimetype: media.mimetype }),
      };
    case "document":
      return {
        document: binary,
        fileName: media.fileName,
        mimetype: media.mimetype,
        ...(media.caption !== undefined && { caption: media.caption }),
      };
    case "sticker":
      return { sticker: binary };
  }
}

async function executableOutbound(
  accountId: string,
  store: MediaStore,
  content: DurableOutbound,
): Promise<Outbound> {
  if ("text" in content) return content;
  const bytes = await store.read({ accountId, ref: content.media.ref });
  if (!bytes) throw new Error("durable media reference is missing");
  if (bytes.byteLength !== content.media.byteLength)
    throw new Error("durable media byte length does not match its operation metadata");
  return mediaOutbound(content.media, bytes);
}

async function prepareSessionCall(
  accountId: string,
  media: MediaStore,
  session: OperationSession,
  input: WhatsAppOperationInput,
): Promise<() => Promise<unknown>> {
  switch (input.type) {
    case "send": {
      if (!input.chatId) throw new TypeError("send chatId must not be empty");
      if ("text" in input.content && input.content.text.length === 0)
        throw new TypeError("send text must not be empty");
      if (!session.send) throw new TypeError("runtime session does not support sends");
      const content = await executableOutbound(accountId, media, input.content);
      return () => session.send!(input.chatId, content, input.options);
    }
    case "mark_read":
      if (!session.markRead) throw new TypeError("runtime session does not support markRead");
      return async () => {
        await session.markRead!([...input.refs]);
        return {};
      };
    case "typing":
      if (!input.chatId) throw new TypeError("typing chatId must not be empty");
      if (!session.setTyping) throw new TypeError("runtime session does not support setTyping");
      return async () => {
        await session.setTyping!(input.chatId, input.on);
        return {};
      };
    case "phone_history":
      if (!input.anchor.ref.chatId)
        throw new TypeError("phone history anchor chatId must not be empty");
      if (!Number.isInteger(input.count) || input.count < 1 || input.count > 50)
        throw new RangeError(`count must be an integer in 1..50, got ${input.count}`);
      if (!session.requestHistory)
        throw new TypeError("runtime session does not support requestHistory");
      return () => session.requestHistory!(input.anchor, { count: input.count });
  }
}

async function executeClaimed(
  store: WhatsAppOperationStore,
  media: MediaStore,
  session: OperationSession,
  operation: WhatsAppOperation,
  ttlMs: number,
): Promise<void> {
  if (operation.state.status !== "claimed") return;
  const { attemptId } = operation.state;
  let call: () => Promise<unknown>;
  try {
    call = await prepareSessionCall(operation.accountId, media, session, operation.input);
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

  let result: unknown;
  try {
    result = await call();
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
  readonly media: MediaStore;
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
        if (!operation) break;
        if (stopped || !active) {
          if (
            operation.state.status === "claimed" &&
            !(await input.store.releaseClaim(
              input.accountId,
              operation.id,
              operation.state.attemptId,
            ))
          )
            await input.store.recoverExpired(input.accountId);
          break;
        }
        await executeClaimed(input.store, input.media, input.session, operation, ttlMs);
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

export type MediaOutbound = Extract<
  Outbound,
  | { readonly image: BinaryInput }
  | { readonly video: BinaryInput }
  | { readonly audio: BinaryInput }
  | { readonly document: BinaryInput }
  | { readonly sticker: BinaryInput }
>;

export interface MediaOperationSubmission {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly chatId: string;
  readonly content: MediaOutbound;
  readonly options?: SendOptions;
}

export async function stageMediaOutbound(input: {
  readonly accountId: string;
  readonly operationId: string;
  readonly content: MediaOutbound;
  readonly store: MediaStore;
}): Promise<{ readonly media: DurableMediaInput }> {
  const message = { id: input.operationId, chatId: "operation-media", fromMe: true } as const;
  if ("image" in input.content) {
    const bytes = await bytesOfBinaryInput(input.content.image);
    const stored = await input.store.put({
      accountId: input.accountId,
      message,
      kind: "image",
      bytes,
    });
    return {
      media: {
        kind: "image",
        ...stored,
        ...(input.content.caption !== undefined && { caption: input.content.caption }),
      },
    };
  }
  if ("video" in input.content) {
    const bytes = await bytesOfBinaryInput(input.content.video);
    const stored = await input.store.put({
      accountId: input.accountId,
      message,
      kind: "video",
      bytes,
    });
    return {
      media: {
        kind: "video",
        ...stored,
        ...(input.content.caption !== undefined && { caption: input.content.caption }),
        ...(input.content.gifPlayback !== undefined && {
          gifPlayback: input.content.gifPlayback,
        }),
      },
    };
  }
  if ("audio" in input.content) {
    const bytes = await bytesOfBinaryInput(input.content.audio);
    const stored = await input.store.put({
      accountId: input.accountId,
      message,
      kind: "audio",
      bytes,
      ...(input.content.mimetype !== undefined && { mimetype: input.content.mimetype }),
    });
    return {
      media: {
        kind: "audio",
        ...stored,
        ...(input.content.ptt !== undefined && { ptt: input.content.ptt }),
        ...(input.content.seconds !== undefined && { seconds: input.content.seconds }),
        ...(input.content.mimetype !== undefined && { mimetype: input.content.mimetype }),
      },
    };
  }
  if ("document" in input.content) {
    const bytes = await bytesOfBinaryInput(input.content.document);
    const stored = await input.store.put({
      accountId: input.accountId,
      message,
      kind: "document",
      bytes,
      mimetype: input.content.mimetype,
    });
    return {
      media: {
        kind: "document",
        ...stored,
        fileName: input.content.fileName,
        mimetype: input.content.mimetype,
        ...(input.content.caption !== undefined && { caption: input.content.caption }),
      },
    };
  }
  const bytes = await bytesOfBinaryInput(input.content.sticker);
  const stored = await input.store.put({
    accountId: input.accountId,
    message,
    kind: "sticker",
    bytes,
  });
  return { media: { kind: "sticker", ...stored } };
}
