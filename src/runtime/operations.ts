import { createHash } from "node:crypto";
import type { MessageRef, SendOptions } from "../model/outbound.ts";
import type { Unsubscribe } from "../subscription.ts";
import { fanout } from "./surface.ts";

export type OperationMediaKind = "image" | "video" | "audio" | "document" | "sticker";

export interface DurableMediaInput {
  readonly ref: string;
}

/** Every Session outbound shape, with live byte inputs replaced by a durable ref. */
export type DurableOutbound =
  | { readonly text: string }
  | { readonly image: DurableMediaInput; readonly caption?: string }
  | {
      readonly video: DurableMediaInput;
      readonly caption?: string;
      readonly gifPlayback?: boolean;
    }
  | {
      readonly audio: DurableMediaInput;
      readonly ptt?: boolean;
      readonly seconds?: number;
      readonly mimetype?: string;
    }
  | {
      readonly document: DurableMediaInput;
      readonly fileName: string;
      readonly mimetype: string;
      readonly caption?: string;
    }
  | { readonly sticker: DurableMediaInput }
  | {
      readonly location: {
        readonly lat: number;
        readonly lng: number;
        readonly name?: string;
        readonly address?: string;
      };
    }
  | { readonly contacts: { readonly displayName?: string; readonly vcards: readonly string[] } }
  | { readonly react: { readonly to: MessageRef; readonly emoji: string } }
  | { readonly edit: { readonly target: MessageRef; readonly text: string } }
  | { readonly delete: MessageRef };

export type WhatsAppOperationInput =
  | {
      readonly version: 1;
      readonly type: "send";
      readonly chatId: string;
      readonly content: DurableOutbound;
      readonly options?: SendOptions;
    }
  | { readonly version: 1; readonly type: "mark_read"; readonly refs: readonly MessageRef[] }
  | {
      readonly version: 1;
      readonly type: "phone_history";
      readonly anchor: { readonly ref: MessageRef; readonly timestamp: number };
      readonly count: number;
    };

export interface SerializedOperationError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export type WhatsAppOperationResult = MessageRef | { readonly requestId: string } | null;

export type WhatsAppOperationState<Result = WhatsAppOperationResult> =
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

export interface WhatsAppOperation<Result = WhatsAppOperationResult> {
  readonly accountId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  /** Monotonic within this operation; orders overlapping receipt reads. */
  readonly revision: number;
  readonly input: WhatsAppOperationInput;
  readonly state: WhatsAppOperationState<Result>;
  readonly submittedAt: number;
  readonly updatedAt: number;
  readonly acknowledgedAt?: number;
}

export interface WhatsAppOperationStore {
  submit(request: {
    readonly accountId: string;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly input: WhatsAppOperationInput;
  }): Promise<WhatsAppOperation>;
  get(accountId: string, operationId: string): Promise<WhatsAppOperation | undefined>;
  list(accountId: string): Promise<readonly WhatsAppOperation[]>;
  claim(
    accountId: string,
    attemptId: string,
    ttlMs: number,
  ): Promise<WhatsAppOperation | undefined>;
  /** Delay until the next claimed/executing row needs recovery, if any. */
  recoveryDelay(accountId: string): Promise<number | undefined>;
  start(
    accountId: string,
    operationId: string,
    attemptId: string,
    ttlMs: number,
  ): Promise<WhatsAppOperation | undefined>;
  release(
    accountId: string,
    operationId: string,
    attemptId: string,
  ): Promise<WhatsAppOperation | undefined>;
  succeed(
    accountId: string,
    operationId: string,
    attemptId: string,
    result: WhatsAppOperationResult,
  ): Promise<WhatsAppOperation | undefined>;
  fail(
    accountId: string,
    operationId: string,
    attemptId: string,
    error: SerializedOperationError,
  ): Promise<WhatsAppOperation | undefined>;
  unknown(
    accountId: string,
    operationId: string,
    attemptId: string,
    reason: string,
  ): Promise<WhatsAppOperation | undefined>;
  acknowledge(accountId: string, operationId: string): Promise<WhatsAppOperation | undefined>;
  subscribe(accountId: string, listener: (operation: WhatsAppOperation) => void): Unsubscribe;
}

interface OperationRegistration {
  readonly notify: (operation: WhatsAppOperation) => void;
}

/** Shared local wake registration for operation-store implementations. */
export function operationSubscription(
  listeners: Map<string, Set<OperationRegistration>>,
  accountId: string,
  listener: (operation: WhatsAppOperation) => void,
): Unsubscribe {
  const held = listeners.get(accountId) ?? new Set();
  const registration = { notify: listener };
  held.add(registration);
  listeners.set(accountId, held);
  return () => {
    held.delete(registration);
    if (held.size === 0) listeners.delete(accountId);
  };
}

export function announceOperationChanges(
  listeners: ReadonlyMap<string, ReadonlySet<OperationRegistration>>,
  accountId: string,
  operations: readonly WhatsAppOperation[],
): void {
  const held = listeners.get(accountId);
  if (!held) return;
  for (const operation of operations)
    fanout(held, (registration) => registration.notify(structuredClone(operation)));
}

/** Reject an unknown durable envelope before it can be persisted or executed. */
export function assertWhatsAppOperationInput(
  input: unknown,
): asserts input is WhatsAppOperationInput {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("invalid WhatsApp operation input");
  const candidate = input as { readonly version?: unknown; readonly type?: unknown };
  if (
    candidate.version !== 1 ||
    !["send", "mark_read", "phone_history"].includes(String(candidate.type))
  )
    throw new TypeError("unknown WhatsApp operation input version or type");
}

export class OperationIdempotencyConflictError extends Error {
  readonly accountId: string;
  readonly idempotencyKey: string;

  constructor(accountId: string, idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" already names a different operation input`);
    this.name = "OperationIdempotencyConflictError";
    this.accountId = accountId;
    this.idempotencyKey = idempotencyKey;
  }
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, member]) => member !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, member]) => [key, canonical(member)]),
        )
      : value;

/** The canonical equality checked behind the account/key unique constraint. */
export const operationInputJson = (input: WhatsAppOperationInput): string =>
  JSON.stringify(canonical(input));

/** Stable for one account/key, so media staging can precede the durable row safely. */
export const operationIdFor = (accountId: string, idempotencyKey: string): string =>
  `operation:v1:${createHash("sha256").update(accountId).update("\0").update(idempotencyKey).digest("hex")}`;

export function serializedOperationError(error: unknown): SerializedOperationError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const code = (error as Error & { readonly code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" && { code }),
  };
}
