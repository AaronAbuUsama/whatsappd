import { createHash } from "node:crypto";
import type { MessageRef } from "../model/outbound.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export const mediaAccountDirectory = (accountId: string): string => digest(accountId);

export function immutableMediaRef(input: {
  readonly accountId: string;
  readonly message: MessageRef;
  readonly kind: "image" | "video" | "audio" | "document" | "sticker";
  readonly bytes: Uint8Array;
}): string {
  const object = createHash("sha256")
    .update(JSON.stringify([input.accountId, input.message.chatId, input.message.id, input.kind]))
    .update("\0")
    .update(input.bytes)
    .digest("hex");
  return `media:v1:${object}`;
}

export const mediaObjectName = (ref: string): string | undefined =>
  /^media:v1:([0-9a-f]{64})$/.exec(ref)?.[1];
