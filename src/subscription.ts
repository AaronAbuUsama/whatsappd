import type {
  ContactUpdate,
  ConversationSyncBatch,
  GroupUpdate,
  InboundMessage,
  PresenceUpdate,
  Status,
  Update,
} from "./model/index.ts";
import { refOf, type MessageRef, type Outbound, type SendOptions } from "./model/outbound.ts";
import { firstRejection } from "./outcome.ts";

export type Awaitable<T> = T | Promise<T>;
export type Unsubscribe = () => void;
export type ReplyContent = Outbound | string;

export interface MessageHandlerContext {
  readonly reply: (content: ReplyContent, options?: SendOptions) => Promise<MessageRef>;
}

export interface WhatsAppSessionHandlers {
  connection?(status: Status): Awaitable<void>;
  conversationSync?(batch: ConversationSyncBatch): Awaitable<void>;
  message?(message: InboundMessage, context: MessageHandlerContext): Awaitable<void>;
  update?(update: Update): Awaitable<void>;
  contact?(contact: ContactUpdate): Awaitable<void>;
  group?(group: GroupUpdate): Awaitable<void>;
  presence?(presence: PresenceUpdate): Awaitable<void>;
}

export type WhatsAppEvent =
  | { readonly type: "connection"; readonly status: Status }
  | { readonly type: "conversation_sync"; readonly batch: ConversationSyncBatch }
  | { readonly type: "message"; readonly message: InboundMessage }
  | { readonly type: "update"; readonly update: Update }
  | { readonly type: "contact"; readonly contact: ContactUpdate }
  | { readonly type: "group"; readonly group: GroupUpdate }
  | { readonly type: "presence"; readonly presence: PresenceUpdate };

type Send = (to: string, content: Outbound, options?: SendOptions) => Promise<MessageRef>;

export class SubscriptionHandlerError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "session subscription handler failed");
    this.name = "SubscriptionHandlerError";
    this.cause = cause;
  }
}

export function createSubscriptionDispatcher(send: Send): {
  subscribe(
    handlers: WhatsAppSessionHandlers,
    options?: { readonly signal?: AbortSignal },
  ): Unsubscribe;
  dispatch(event: WhatsAppEvent): Promise<void>;
} {
  const subscriptions = new Set<{ readonly handlers: WhatsAppSessionHandlers }>();

  return {
    subscribe(handlers, options) {
      const signal = options?.signal;
      if (signal?.aborted) return () => {};

      const subscription = { handlers };
      const unsubscribe = (): void => {
        subscriptions.delete(subscription);
        signal?.removeEventListener("abort", unsubscribe);
      };
      subscriptions.add(subscription);
      signal?.addEventListener("abort", unsubscribe, { once: true });
      return unsubscribe;
    },
    async dispatch(event) {
      const pending = [...subscriptions].map(({ handlers }) =>
        Promise.resolve().then(() => {
          switch (event.type) {
            case "connection":
              return handlers.connection?.(event.status);
            case "conversation_sync":
              return handlers.conversationSync?.(event.batch);
            case "message":
              return handlers.message?.(event.message, {
                reply: (content, options) =>
                  send(
                    event.message.chatId,
                    typeof content === "string" ? { text: content } : content,
                    { quote: refOf(event.message), ...options },
                  ),
              });
            case "update":
              return handlers.update?.(event.update);
            case "contact":
              return handlers.contact?.(event.contact);
            case "group":
              return handlers.group?.(event.group);
            case "presence":
              return handlers.presence?.(event.presence);
          }
        }),
      );
      const results = await Promise.allSettled(pending);
      const rejected = firstRejection(results);
      if (rejected) throw new SubscriptionHandlerError(rejected.reason);
    },
  };
}
