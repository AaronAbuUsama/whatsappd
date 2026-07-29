import type { InboundMessage } from "../src/model/index.ts";

export function proofReply(message: InboundMessage): "pong" | undefined {
  return message.live && message.kind === "text" && message.text.trim().toLowerCase() === "ping"
    ? "pong"
    : undefined;
}
