import type { SendOptions } from "../model/outbound.ts";
import {
  awaitOperationSubmission,
  operationId,
  type MediaOutbound,
  type WhatsAppOperation,
} from "./operations.ts";
import type { ClientRuntimeSource } from "./runtime.ts";

export interface ClientOperationOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ClientSendOptions extends ClientOperationOptions, SendOptions {}

type Submission = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly options?: SendOptions;
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
