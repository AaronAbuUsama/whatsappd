import type { Status, WaIdentity } from "../model/status.ts";
import type { Unsubscribe, WhatsAppSessionHandlers } from "../subscription.ts";
import type {
  CurrentMirrorSnapshot,
  CurrentMirrorView,
  RuntimeDurableFrame,
  RuntimeLiveFrame,
  StoredMessagePage,
  StoredMessagePageOptions,
  WhatsAppBackend,
} from "./contracts.ts";
import type { OperationSession } from "./operation-session.ts";
import type {
  MediaOperationSubmission,
  WhatsAppOperation,
  WhatsAppOperationInput,
} from "./operations.ts";
import { stageMediaOutbound } from "./operations.ts";
import type { WhatsAppLinkState } from "./lifecycle.ts";
import { durableFrames } from "./runtime-frames.ts";

/** The part of a live Session the Runtime consumes and commands. */
export interface RuntimeSession extends OperationSession {
  readonly status?: Status;
  subscribe(
    handlers: WhatsAppSessionHandlers,
    options?: { readonly signal?: AbortSignal },
  ): Unsubscribe;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  identity?(): WaIdentity | undefined;
}

export interface WhatsAppRuntimeConfig {
  readonly accountId: string;
  readonly backend: WhatsAppBackend;
  readonly holderId?: string;
  readonly leaseTtlMs?: number;
  readonly freshnessMs?: number;
  readonly operationAttemptTtlMs?: number;
}

export interface WhatsAppRuntime {
  readonly accountId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface InProcessWhatsAppRuntime extends WhatsAppRuntime {
  snapshot(): Promise<CurrentMirrorSnapshot>;
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
  onFrame(listener: (frame: RuntimeDurableFrame) => void): Unsubscribe;
  onLive(listener: (frame: RuntimeLiveFrame) => void): Unsubscribe;
}

export interface ClientClaim {
  readonly fencingToken: number;
  readonly expiresAt: number;
}

export interface ClientRuntimeSource {
  frames(signal?: AbortSignal): AsyncIterable<RuntimeDurableFrame>;
  onLive(listener: (frame: RuntimeLiveFrame, claim: ClientClaim) => void): Unsubscribe;
  read<T>(fn: (view: CurrentMirrorView) => Promise<T>): Promise<T>;
  identity(): WaIdentity | undefined;
  currentClaim(): ClientClaim | undefined;
  linkState(): WhatsAppLinkState | undefined;
  submitOperation(input: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: WhatsAppOperationInput;
  }): Promise<WhatsAppOperation>;
  submitPair(input: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: Extract<WhatsAppOperationInput, { readonly type: "pair" }>;
  }): Promise<WhatsAppOperation>;
  submitUnlink(input: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: Extract<WhatsAppOperationInput, { readonly type: "unlink" }>;
  }): Promise<WhatsAppOperation>;
  submitMediaOperation(input: MediaOperationSubmission): Promise<WhatsAppOperation>;
  operations(operationIds: readonly string[]): Promise<readonly (WhatsAppOperation | undefined)[]>;
  onOperation(operationId: string, listener: (operation: WhatsAppOperation) => void): Unsubscribe;
  consumePairingChallenge(operationId: string): Promise<{
    readonly method: "qr" | "pairing_code";
    readonly value: string;
    readonly expiresAt: number;
  } | null>;
}

export const clientSourceFor = new WeakMap<WhatsAppRuntime, ClientRuntimeSource>();

/** Build the one private source registered for a Runtime's friendly Clients. */
export function createClientRuntimeSource(input: {
  readonly runtime: InProcessWhatsAppRuntime;
  readonly backend: WhatsAppBackend;
  readonly currentClaim: () => ClientClaim | undefined;
  readonly identity: () => WaIdentity | undefined;
  readonly linkState: () => WhatsAppLinkState | undefined;
  readonly wake: () => void;
  readonly submitPair: ClientRuntimeSource["submitPair"];
  readonly submitUnlink: ClientRuntimeSource["submitUnlink"];
  readonly consumePairingChallenge: ClientRuntimeSource["consumePairingChallenge"];
}): ClientRuntimeSource {
  const { runtime, backend } = input;
  const { accountId } = runtime;
  return {
    frames: (signal) => durableFrames(runtime, signal ? { signal } : undefined),
    onLive: (listener) =>
      runtime.onLive((frame) => {
        const claim = input.currentClaim();
        if (claim) listener(frame, claim);
      }),
    read: (fn) => backend.data.read(accountId, fn),
    identity: input.identity,
    currentClaim: input.currentClaim,
    linkState: input.linkState,
    async submitOperation(submission) {
      const operation = await backend.operations.submit({ accountId, ...submission });
      input.wake();
      return operation;
    },
    submitPair: input.submitPair,
    submitUnlink: input.submitUnlink,
    async submitMediaOperation(submission) {
      const content = await stageMediaOutbound({
        accountId,
        operationId: submission.idempotencyKey,
        content: submission.content,
        store: backend.media,
      });
      const operation = await backend.operations.submit({
        accountId,
        id: submission.id,
        idempotencyKey: submission.idempotencyKey,
        operation: {
          type: "send",
          chatId: submission.chatId,
          content,
          ...(submission.options && { options: submission.options }),
        },
      });
      input.wake();
      return operation;
    },
    operations: (operationIds) => backend.operations.get(accountId, operationIds),
    onOperation: (operationId, listener) =>
      backend.operations.subscribe(accountId, operationId, listener),
    consumePairingChallenge: input.consumePairingChallenge,
  };
}
