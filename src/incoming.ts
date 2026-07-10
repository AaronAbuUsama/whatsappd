/**
 * An inbound message paired with a `reply` bound to its chat: the raw
 * {@link InboundMessage} plus a one-call answer that quotes it. `session.onMessage`
 * delivers this shape; `session.inbound` carries the bare {@link InboundMessage}.
 */
import type { InboundMessage } from "./model/message.ts";
import { refOf, type MessageRef, type Outbound, type SendOptions } from "./model/outbound.ts";

/** What `reply` accepts: a full {@link Outbound}, or a bare string as shorthand for text. */
export type ReplyContent = Outbound | string;

/** The session's send verb, threaded into `reply`. */
export type Send = (to: string, msg: Outbound, opts?: SendOptions) => Promise<MessageRef>;

/** An {@link InboundMessage} plus a `reply` bound to its chat. */
export type IncomingMessage = InboundMessage & {
  /**
   * Reply in this message's chat, quoting it by default.
   *
   * @param content - An {@link Outbound}, or a string sent as text.
   * @param opts - Send options; an explicit `quote` overrides the default.
   */
  reply(content: ReplyContent, opts?: SendOptions): Promise<MessageRef>;
};

/** Enrich a raw inbound message with a `reply` bound to `send`. */
export function incoming(message: InboundMessage, send: Send): IncomingMessage {
  return {
    ...message,
    reply: (content, opts) =>
      send(message.chatId, typeof content === "string" ? { text: content } : content, {
        quote: refOf(message),
        ...opts,
      }),
  } as IncomingMessage;
}
