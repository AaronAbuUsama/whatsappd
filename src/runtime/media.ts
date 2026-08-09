import { createHash } from "node:crypto";
import type { MediaOwner } from "./contracts.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export const mediaAccountDirectory = (accountId: string): string => digest(accountId);

export function immutableMediaRef(input: {
  readonly accountId: string;
  readonly owner: MediaOwner;
  readonly kind: "image" | "video" | "audio" | "document" | "sticker";
  readonly bytes: Uint8Array;
}): string {
  const owner =
    input.owner.type === "message"
      ? [input.owner.message.chatId, input.owner.message.id]
      : ["operation", input.owner.operationId];
  const object = createHash("sha256")
    .update(JSON.stringify([input.accountId, owner, input.kind]))
    .update("\0")
    .update(input.bytes)
    .digest("hex");
  return `media:v1:${object}`;
}

export const mediaObjectName = (ref: string): string | undefined =>
  /^media:v1:([0-9a-f]{64})$/.exec(ref)?.[1];
