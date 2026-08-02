import { addressOf, type InboundMessage } from "./model/message.ts";
import type { MessageRef, Outbound, SendOptions } from "./model/outbound.ts";
import type { WaIdentity } from "./model/status.ts";
import type { WhatsAppSession } from "./session.ts";
import { createSubscriptionDispatcher, type WhatsAppEvent } from "./subscription.ts";

export interface TextMessageInput {
  readonly id: string;
  readonly chatId: string;
  readonly text: string;
  /** The author's native address. Defaults to the chat, which is only ever true of an incoming 1:1. */
  readonly sender?: string;
  readonly fromMe?: boolean;
  readonly timestamp?: number;
  readonly live?: boolean;
  readonly isGroup?: boolean;
}

export function textMessage(
  input: TextMessageInput,
): InboundMessage & { readonly kind: "text"; readonly text: string } {
  const isGroup = input.isGroup ?? input.chatId.endsWith("@g.us");
  const fromMe = input.fromMe ?? false;
  if (isGroup && (!input.sender || input.sender === input.chatId)) {
    throw new TypeError("group messages require an actual sender");
  }
  // The chat default would name the peer as the author of your own message —
  // the misattribution ADR-0001 exists to prevent, so it is not constructible.
  if (fromMe && !input.sender) {
    throw new TypeError("own messages require the linked account as sender");
  }
  return {
    id: input.id,
    chatId: input.chatId,
    sender: addressOf(input.sender ?? input.chatId),
    fromMe,
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
  readonly historyRequests: Array<{
    readonly anchor: { readonly ref: MessageRef; readonly timestamp: number };
    readonly count: number;
    readonly result: { readonly requestId: string };
  }>;
}

export interface TestWhatsAppSessionDriver {
  readonly session: Pick<
    WhatsAppSession,
    | "subscribe"
    | "send"
    | "markRead"
    | "setTyping"
    | "requestHistory"
    | "identity"
    | "start"
    | "stop"
  >;
  readonly commands: RecordedSessionCommands;
  emit(event: TestWhatsAppEvent): Promise<void>;
}

export function createTestWhatsAppSession(options?: {
  readonly identity?: WaIdentity;
}): TestWhatsAppSessionDriver {
  const sent: Array<{
    readonly to: string;
    readonly content: Outbound;
    readonly options?: SendOptions;
    readonly result: MessageRef;
  }> = [];
  const read: Array<{ readonly refs: readonly MessageRef[] }> = [];
  const typing: Array<{ readonly chatId: string; readonly on: boolean }> = [];
  const historyRequests: Array<{
    readonly anchor: { readonly ref: MessageRef; readonly timestamp: number };
    readonly count: number;
    readonly result: { readonly requestId: string };
  }> = [];
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
  // The live session's `start()` resolves only when the session has ended, and
  // rejects with the first handler failure its pipeline sees. Without the same
  // channel here, a consumer that stops on a failed write — the whole point of
  // an awaited subscription — is untestable: the driver would keep dispatching
  // to a consumer the real session would already have taken down.
  let endSession: () => void = () => {};
  let failSession: (error: unknown) => void = () => {};
  const life = new Promise<void>((resolve, reject) => {
    endSession = resolve;
    failSession = reject;
  });
  // A driver used without a supervising consumer must not crash the process on
  // a handler failure the caller already received from `emit()`.
  void life.catch(() => {});

  return {
    session: {
      subscribe: (handlers, options) => dispatcher.subscribe(handlers, options),
      send,
      start: () => life,
      async stop() {
        endSession();
      },
      async markRead(refs) {
        read.push({ refs });
      },
      async setTyping(chatId, on) {
        typing.push({ chatId, on });
      },
      async requestHistory(anchor, opts) {
        const count = opts?.count ?? 50;
        // Mirror the real seam's ADR-0010 bound so driver-tested code cannot
        // pass counts the live session would reject.
        if (!Number.isInteger(count) || count < 1 || count > 50)
          throw new RangeError(`count must be an integer in 1..50, got ${count}`);
        const result = { requestId: `test-history-${historyRequests.length + 1}` };
        historyRequests.push({ anchor, count, result });
        return result;
      },
      identity: () => options?.identity,
    },
    commands: { sent, read, typing, historyRequests },
    emit(event) {
      const task = (pipeline = pipeline.then(() => dispatcher.dispatch(event)));
      // Reported to the session's life as well as to the caller: a handler that
      // rejects has ended the session, exactly as it would live.
      void task.catch(failSession);
      return task;
    },
  };
}
