import type { InboundMessage } from "../../packages/whatsappd/src/model/index.ts";

export async function replyToProofPing(
  message: InboundMessage,
  send: (chatId: string, text: "pong") => Promise<void>,
): Promise<boolean> {
  if (!message.live || message.kind !== "text" || message.text.trim().toLowerCase() !== "ping") {
    return false;
  }
  await send(message.chatId, "pong");
  return true;
}
