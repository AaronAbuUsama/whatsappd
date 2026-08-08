import type { MessageRef, Outbound, SendOptions } from "../model/outbound.ts";
import type { WhatsAppOperationInput } from "./operations.ts";

export interface OperationSession {
  send?(to: string, content: Outbound, options?: SendOptions): Promise<MessageRef>;
  markRead?(refs: MessageRef[]): Promise<void>;
  setTyping?(chatId: string, on: boolean): Promise<void>;
  requestHistory?(
    anchor: { readonly ref: MessageRef; readonly timestamp: number },
    options?: { readonly count?: number },
  ): Promise<{ readonly requestId: string }>;
  pair?(
    input: Extract<WhatsAppOperationInput, { readonly type: "pair" }>,
    operationId: string,
  ): Promise<unknown>;
  validatePair?(): void | Promise<void>;
  unlink?(): Promise<unknown>;
  validateUnlink?(): void | Promise<void>;
}

export interface OperationExecutor {
  activeOperationType(): WhatsAppOperationInput["type"] | undefined;
  wake(): void;
  resume(): void;
  pause(): void;
  stop(): Promise<void>;
}

/** Adapt the currently attached Session plus lifecycle commands to one executor seam. */
export function createRuntimeOperationSession(input: {
  readonly current: () => OperationSession;
  readonly validatePair: () => void | Promise<void>;
  readonly pair: NonNullable<OperationSession["pair"]>;
  readonly validateUnlink: () => void | Promise<void>;
  readonly unlink: NonNullable<OperationSession["unlink"]>;
}): OperationSession {
  return {
    send(to, content, options) {
      const session = input.current();
      if (!session.send) throw new TypeError("runtime session does not support sends");
      return session.send(to, content, options);
    },
    markRead(refs) {
      const session = input.current();
      if (!session.markRead) throw new TypeError("runtime session does not support markRead");
      return session.markRead(refs);
    },
    setTyping(chatId, on) {
      const session = input.current();
      if (!session.setTyping) throw new TypeError("runtime session does not support setTyping");
      return session.setTyping(chatId, on);
    },
    requestHistory(anchor, options) {
      const session = input.current();
      if (!session.requestHistory)
        throw new TypeError("runtime session does not support requestHistory");
      return session.requestHistory(anchor, options);
    },
    validatePair: input.validatePair,
    pair: input.pair,
    validateUnlink: input.validateUnlink,
    unlink: input.unlink,
  };
}
