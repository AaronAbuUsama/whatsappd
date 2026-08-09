import { createHash } from "node:crypto";
import type { MessageRef, SendOptions } from "../model/outbound.ts";
import type { Unsubscribe } from "../subscription.ts";
import { fanoutBatch } from "./surface.ts";

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
  /** Account-scoped causal submission order. */
  readonly sequence: number;
  readonly input: WhatsAppOperationInput;
  readonly state: WhatsAppOperationState<Result>;
  readonly submittedAt: number;
  readonly updatedAt: number;
  readonly acknowledgedAt?: number;
}

export interface WhatsAppOperationSubmission {
  readonly accountId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly input: WhatsAppOperationInput;
}

export interface WhatsAppOperationStore {
  submit(request: WhatsAppOperationSubmission): Promise<WhatsAppOperation>;
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
  const final = new Map(operations.map((operation) => [operation.id, operation]));
  fanoutBatch(held, final.values(), (registration, operation) =>
    registration.notify(structuredClone(operation)),
  );
}

const operationRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`invalid WhatsApp operation ${label}`);
  return value as Record<string, unknown>;
};

const operationKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0)
    throw new TypeError(`invalid WhatsApp operation ${label} member ${extras[0]}`);
};

const operationText = (value: unknown, label: string, empty = true): string => {
  if (typeof value !== "string" || (!empty && value.length === 0))
    throw new TypeError(`invalid WhatsApp operation ${label}`);
  return value;
};

const operationInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new TypeError(`invalid WhatsApp operation ${label}`);
  return value;
};

const operationNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`invalid WhatsApp operation ${label}`);
  return value;
};

const optionalText = (value: unknown, label: string): string | undefined =>
  value === undefined ? undefined : operationText(value, label);

const optionalBoolean = (value: unknown, label: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`invalid WhatsApp operation ${label}`);
  return value;
};

const operationRef = (value: unknown, label: string): MessageRef => {
  const ref = operationRecord(value, label);
  operationKeys(ref, ["id", "chatId", "fromMe", "participant"], label);
  if (typeof ref.fromMe !== "boolean")
    throw new TypeError(`invalid WhatsApp operation ${label}.fromMe`);
  return {
    id: operationText(ref.id, `${label}.id`, false),
    chatId: operationText(ref.chatId, `${label}.chatId`, false),
    fromMe: ref.fromMe,
    ...(ref.participant !== undefined && {
      participant: operationText(ref.participant, `${label}.participant`, false),
    }),
  };
};

const operationMedia = (value: unknown, label: string): DurableMediaInput => {
  const media = operationRecord(value, label);
  operationKeys(media, ["ref"], label);
  return { ref: operationText(media.ref, `${label}.ref`, false) };
};

const operationOutbound = (value: unknown): DurableOutbound => {
  const content = operationRecord(value, "send content");
  if ("text" in content) {
    operationKeys(content, ["text"], "send text");
    return { text: operationText(content.text, "send text") };
  }
  if ("image" in content) {
    operationKeys(content, ["image", "caption"], "send image");
    const caption = optionalText(content.caption, "send image caption");
    return {
      image: operationMedia(content.image, "send image ref"),
      ...(caption !== undefined && { caption }),
    };
  }
  if ("video" in content) {
    operationKeys(content, ["video", "caption", "gifPlayback"], "send video");
    const caption = optionalText(content.caption, "send video caption");
    const gifPlayback = optionalBoolean(content.gifPlayback, "send video gifPlayback");
    return {
      video: operationMedia(content.video, "send video ref"),
      ...(caption !== undefined && { caption }),
      ...(gifPlayback !== undefined && { gifPlayback }),
    };
  }
  if ("audio" in content) {
    operationKeys(content, ["audio", "ptt", "seconds", "mimetype"], "send audio");
    const ptt = optionalBoolean(content.ptt, "send audio ptt");
    const seconds =
      content.seconds === undefined
        ? undefined
        : operationNumber(content.seconds, "send audio seconds");
    const mimetype = optionalText(content.mimetype, "send audio mimetype");
    return {
      audio: operationMedia(content.audio, "send audio ref"),
      ...(ptt !== undefined && { ptt }),
      ...(seconds !== undefined && { seconds }),
      ...(mimetype !== undefined && { mimetype }),
    };
  }
  if ("document" in content) {
    operationKeys(content, ["document", "fileName", "mimetype", "caption"], "send document");
    const caption = optionalText(content.caption, "send document caption");
    return {
      document: operationMedia(content.document, "send document ref"),
      fileName: operationText(content.fileName, "send document fileName", false),
      mimetype: operationText(content.mimetype, "send document mimetype", false),
      ...(caption !== undefined && { caption }),
    };
  }
  if ("sticker" in content) {
    operationKeys(content, ["sticker"], "send sticker");
    return { sticker: operationMedia(content.sticker, "send sticker ref") };
  }
  if ("location" in content) {
    operationKeys(content, ["location"], "send location");
    const location = operationRecord(content.location, "send location value");
    operationKeys(location, ["lat", "lng", "name", "address"], "send location value");
    const name = optionalText(location.name, "send location name");
    const address = optionalText(location.address, "send location address");
    return {
      location: {
        lat: operationNumber(location.lat, "send location lat"),
        lng: operationNumber(location.lng, "send location lng"),
        ...(name !== undefined && { name }),
        ...(address !== undefined && { address }),
      },
    };
  }
  if ("contacts" in content) {
    operationKeys(content, ["contacts"], "send contacts");
    const contacts = operationRecord(content.contacts, "send contacts value");
    operationKeys(contacts, ["displayName", "vcards"], "send contacts value");
    if (!Array.isArray(contacts.vcards))
      throw new TypeError("invalid WhatsApp operation send contacts vcards");
    const displayName = optionalText(contacts.displayName, "send contacts displayName");
    return {
      contacts: {
        ...(displayName !== undefined && { displayName }),
        vcards: contacts.vcards.map((vcard) => operationText(vcard, "send contact vcard")),
      },
    };
  }
  if ("react" in content) {
    operationKeys(content, ["react"], "send reaction");
    const react = operationRecord(content.react, "send reaction value");
    operationKeys(react, ["to", "emoji"], "send reaction value");
    return {
      react: {
        to: operationRef(react.to, "send reaction target"),
        emoji: operationText(react.emoji, "send reaction emoji"),
      },
    };
  }
  if ("edit" in content) {
    operationKeys(content, ["edit"], "send edit");
    const edit = operationRecord(content.edit, "send edit value");
    operationKeys(edit, ["target", "text"], "send edit value");
    return {
      edit: {
        target: operationRef(edit.target, "send edit target"),
        text: operationText(edit.text, "send edit text"),
      },
    };
  }
  if ("delete" in content) {
    operationKeys(content, ["delete"], "send delete");
    return { delete: operationRef(content.delete, "send delete target") };
  }
  throw new TypeError("invalid WhatsApp operation send content kind");
};

const operationOptions = (value: unknown): SendOptions => {
  const options = operationRecord(value, "send options");
  operationKeys(options, ["quote", "mentions"], "send options");
  if (options.mentions !== undefined && !Array.isArray(options.mentions))
    throw new TypeError("invalid WhatsApp operation send mentions");
  return {
    ...(options.quote !== undefined && { quote: operationRef(options.quote, "send quote") }),
    ...(options.mentions !== undefined && {
      mentions: options.mentions.map((mention) => operationText(mention, "send mention", false)),
    }),
  };
};

/** Validate and project a durable envelope before persistence or execution. */
export function validatedOperationInput(input: unknown): WhatsAppOperationInput {
  const candidate = operationRecord(input, "input");
  if (candidate.version !== 1)
    throw new TypeError("unknown WhatsApp operation input version or type");
  if (candidate.type === "send") {
    operationKeys(candidate, ["version", "type", "chatId", "content", "options"], "send input");
    return {
      version: 1,
      type: "send",
      chatId: operationText(candidate.chatId, "send chatId", false),
      content: operationOutbound(candidate.content),
      ...(candidate.options !== undefined && { options: operationOptions(candidate.options) }),
    };
  }
  if (candidate.type === "mark_read") {
    operationKeys(candidate, ["version", "type", "refs"], "mark-read input");
    if (!Array.isArray(candidate.refs))
      throw new TypeError("invalid WhatsApp operation mark-read refs");
    return {
      version: 1,
      type: "mark_read",
      refs: candidate.refs.map((ref) => operationRef(ref, "mark-read ref")),
    };
  }
  if (candidate.type === "phone_history") {
    operationKeys(candidate, ["version", "type", "anchor", "count"], "phone-history input");
    const anchor = operationRecord(candidate.anchor, "phone-history anchor");
    operationKeys(anchor, ["ref", "timestamp"], "phone-history anchor");
    const count = operationInteger(candidate.count, "phone-history count");
    if (count < 1 || count > 50)
      throw new TypeError("invalid WhatsApp operation phone-history count");
    return {
      version: 1,
      type: "phone_history",
      anchor: {
        ref: operationRef(anchor.ref, "phone-history ref"),
        timestamp: operationInteger(anchor.timestamp, "phone-history timestamp"),
      },
      count,
    };
  }
  throw new TypeError("unknown WhatsApp operation input version or type");
}

export function validatedOperationSubmission(value: unknown): WhatsAppOperationSubmission {
  const request = operationRecord(value, "submission");
  operationKeys(request, ["accountId", "id", "idempotencyKey", "input"], "submission");
  return {
    accountId: operationText(request.accountId, "submission accountId", false),
    id: operationText(request.id, "submission id", false),
    idempotencyKey: operationText(request.idempotencyKey, "submission idempotencyKey", false),
    input: validatedOperationInput(request.input),
  };
}

/** Project the only values safe to persist after the Session boundary. */
export function validatedOperationResult(
  input: WhatsAppOperationInput,
  result: unknown,
): WhatsAppOperationResult {
  if (input.type === "mark_read") {
    if (result !== null) throw new TypeError("invalid mark-read operation result");
    return null;
  }
  if (input.type === "phone_history") {
    const receipt = operationRecord(result, "phone-history result");
    operationKeys(receipt, ["requestId"], "phone-history result");
    return { requestId: operationText(receipt.requestId, "phone-history requestId", false) };
  }
  return operationRef(result, "send result");
}

export function validatedOperationState(
  value: unknown,
  input: WhatsAppOperationInput,
): WhatsAppOperationState {
  const state = operationRecord(value, "state");
  if (state.status === "queued") {
    operationKeys(state, ["status"], "queued state");
    return { status: "queued" };
  }
  if (state.status === "claimed") {
    operationKeys(state, ["status", "attemptId", "expiresAt"], "claimed state");
    return {
      status: "claimed",
      attemptId: operationText(state.attemptId, "claimed attemptId", false),
      expiresAt: operationInteger(state.expiresAt, "claimed expiresAt"),
    };
  }
  if (state.status === "executing") {
    operationKeys(state, ["status", "attemptId", "startedAt", "expiresAt"], "executing state");
    return {
      status: "executing",
      attemptId: operationText(state.attemptId, "executing attemptId", false),
      startedAt: operationInteger(state.startedAt, "executing startedAt"),
      expiresAt: operationInteger(state.expiresAt, "executing expiresAt"),
    };
  }
  if (state.status === "succeeded") {
    operationKeys(state, ["status", "result", "completedAt"], "succeeded state");
    return {
      status: "succeeded",
      result: validatedOperationResult(input, state.result),
      completedAt: operationInteger(state.completedAt, "succeeded completedAt"),
    };
  }
  if (state.status === "failed") {
    operationKeys(state, ["status", "error", "completedAt"], "failed state");
    const error = operationRecord(state.error, "failed error");
    operationKeys(error, ["name", "message", "code"], "failed error");
    const code = optionalText(error.code, "failed error code");
    return {
      status: "failed",
      error: {
        name: operationText(error.name, "failed error name", false),
        message: operationText(error.message, "failed error message"),
        ...(code !== undefined && { code }),
      },
      completedAt: operationInteger(state.completedAt, "failed completedAt"),
    };
  }
  if (state.status === "outcome_unknown") {
    operationKeys(state, ["status", "reason", "completedAt"], "unknown state");
    return {
      status: "outcome_unknown",
      reason: operationText(state.reason, "unknown reason", false),
      completedAt: operationInteger(state.completedAt, "unknown completedAt"),
    };
  }
  throw new TypeError("invalid WhatsApp operation state");
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
