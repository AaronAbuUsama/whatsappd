import type { MessageRef, SendOptions } from "../model/outbound.ts";
import {
  awaitOperationSubmission,
  operationId,
  type MediaOutbound,
  type WhatsAppOperation,
  type WhatsAppOperationInput,
} from "./operations.ts";
import type { ClientRuntimeSource } from "./runtime.ts";

export interface ClientOperationOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ClientSendOptions extends ClientOperationOptions, SendOptions {}

export interface ClientPhoneHistoryRequest {
  readonly before: { readonly ref: MessageRef; readonly timestamp: number };
  readonly count?: number;
}

export interface ClientOperationGet {
  (operationId: string): Promise<WhatsAppOperation | undefined>;
  (operationIds: readonly string[]): Promise<readonly (WhatsAppOperation | undefined)[]>;
}

export function createClientOperationGet(source: ClientRuntimeSource): ClientOperationGet {
  function get(operationId: string): Promise<WhatsAppOperation | undefined>;
  function get(
    operationIds: readonly string[],
  ): Promise<readonly (WhatsAppOperation | undefined)[]>;
  function get(
    operationId: string | readonly string[],
  ): Promise<WhatsAppOperation | undefined | readonly (WhatsAppOperation | undefined)[]> {
    return typeof operationId === "string"
      ? source.operations([operationId]).then(([operation]) => operation)
      : source.operations(operationId);
  }
  return get;
}

type Submission = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly options?: SendOptions;
};

const submitOperation = (
  source: ClientRuntimeSource,
  operation: WhatsAppOperationInput,
  options: ClientOperationOptions | undefined,
): Promise<WhatsAppOperation> => {
  const id = operationId();
  const { idempotencyKey = operationId(), signal } = options ?? {};
  return awaitOperationSubmission(
    () => source.submitOperation({ id, idempotencyKey, operation }),
    signal,
  );
};

export function createClientSend(source: ClientRuntimeSource): {
  text(chatId: string, text: string, options?: ClientSendOptions): Promise<WhatsAppOperation>;
  media(
    chatId: string,
    content: MediaOutbound,
    options?: ClientSendOptions,
  ): Promise<WhatsAppOperation>;
} {
  const submit = (
    options: ClientSendOptions | undefined,
    operation: (input: Submission) => Promise<WhatsAppOperation>,
  ): Promise<WhatsAppOperation> => {
    const id = operationId();
    const { idempotencyKey = operationId(), signal, ...sendOptions } = options ?? {};
    return awaitOperationSubmission(
      () =>
        operation({
          id,
          idempotencyKey,
          ...(Object.keys(sendOptions).length > 0 && { options: sendOptions }),
        }),
      signal,
    );
  };

  return {
    text: (chatId, text, options) =>
      submit(options, ({ id, idempotencyKey, options: sendOptions }) =>
        source.submitOperation({
          id,
          idempotencyKey,
          operation: {
            type: "send",
            chatId,
            content: { text },
            ...(sendOptions && { options: sendOptions }),
          },
        }),
      ),
    media: (chatId, content, options) =>
      submit(options, ({ id, idempotencyKey, options: sendOptions }) =>
        source.submitMediaOperation({
          id,
          idempotencyKey,
          chatId,
          content,
          ...(sendOptions && { options: sendOptions }),
        }),
      ),
  };
}

export function createClientMessageActions(source: ClientRuntimeSource) {
  return {
    markRead: (refs: readonly MessageRef[], options?: ClientOperationOptions) =>
      submitOperation(source, { type: "mark_read", refs }, options),
    setTyping: (chatId: string, on: boolean, options?: ClientOperationOptions) =>
      submitOperation(source, { type: "typing", chatId, on }, options),
    async requestPhoneHistory(
      chatId: string,
      request: ClientPhoneHistoryRequest,
      options?: ClientOperationOptions,
    ) {
      if (!chatId) throw new TypeError("phone history chatId must not be empty");
      if (request.before.ref.chatId !== chatId)
        throw new TypeError("phone history anchor must belong to chatId");
      const count = request.count ?? 50;
      if (!Number.isInteger(count) || count < 1 || count > 50)
        throw new RangeError(`count must be an integer in 1..50, got ${count}`);
      return submitOperation(
        source,
        { type: "phone_history", anchor: request.before, count },
        options,
      );
    },
  };
}
