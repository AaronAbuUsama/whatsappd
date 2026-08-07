import type { MessageRef, Outbound, SendOptions } from "../model/outbound.ts";

export interface OperationSession {
  send?(to: string, content: Outbound, options?: SendOptions): Promise<MessageRef>;
  markRead?(refs: MessageRef[]): Promise<void>;
  setTyping?(chatId: string, on: boolean): Promise<void>;
  requestHistory?(
    anchor: { readonly ref: MessageRef; readonly timestamp: number },
    options?: { readonly count?: number },
  ): Promise<{ readonly requestId: string }>;
}
