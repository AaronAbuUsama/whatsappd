import type { InboundMessage } from "./model/message.ts";
import type { MessageRef, Outbound, SendOptions } from "./model/outbound.ts";
import type { WhatsAppSession } from "./session.ts";
import { createSubscriptionDispatcher, type WhatsAppEvent } from "./subscription.ts";

export interface TextMessageInput {
  readonly id: string;
  readonly chatId: string;
  readonly text: string;
  readonly from?: string;
  readonly fromMe?: boolean;
  readonly timestamp?: number;
  readonly live?: boolean;
  readonly isGroup?: boolean;
}

export function textMessage(input: TextMessageInput): InboundMessage {
  const isGroup = input.isGroup ?? input.chatId.endsWith("@g.us");
  if (isGroup && (!input.from || input.from === input.chatId)) {
    throw new TypeError("group messages require an actual sender");
  }
  return {
    id: input.id,
    chatId: input.chatId,
    from: input.from ?? input.chatId,
    fromMe: input.fromMe ?? false,
    timestamp: input.timestamp ?? 0,
    live: input.live ?? true,
    isGroup,
    kind: "text",
    text: input.text,
  };
}

export type TestWhatsAppEvent = WhatsAppEvent;

export interface RecordedSessionCommands {
  readonly sent: Array<{
    readonly to: string;
    readonly content: Outbound;
    readonly options?: SendOptions;
    readonly result: MessageRef;
  }>;
  readonly read: Array<{ readonly refs: readonly MessageRef[] }>;
  readonly typing: Array<{ readonly chatId: string; readonly on: boolean }>;
}

export interface TestWhatsAppSessionDriver {
  readonly session: Pick<WhatsAppSession, "subscribe" | "send" | "markRead" | "setTyping">;
  readonly commands: RecordedSessionCommands;
  emit(event: TestWhatsAppEvent): Promise<void>;
}

export function createTestWhatsAppSession(): TestWhatsAppSessionDriver {
  const sent: Array<{
    readonly to: string;
    readonly content: Outbound;
    readonly options?: SendOptions;
    readonly result: MessageRef;
  }> = [];
  const read: Array<{ readonly refs: readonly MessageRef[] }> = [];
  const typing: Array<{ readonly chatId: string; readonly on: boolean }> = [];
  const send = async (
    to: string,
    content: Outbound,
    options?: SendOptions,
  ): Promise<MessageRef> => {
    const result = { id: `test-${sent.length + 1}`, chatId: to, fromMe: true };
    sent.push({ to, content, options, result });
    return result;
  };
  const dispatcher = createSubscriptionDispatcher(send);
  let pipeline = Promise.resolve();

  return {
    session: {
      subscribe: (handlers, options) => dispatcher.subscribe(handlers, options),
      send,
      async markRead(refs) {
        read.push({ refs });
      },
      async setTyping(chatId, on) {
        typing.push({ chatId, on });
      },
    },
    commands: { sent, read, typing },
    emit(event) {
      return (pipeline = pipeline.then(() => dispatcher.dispatch(event)));
    },
  };
}
