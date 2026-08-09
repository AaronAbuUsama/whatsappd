import { createHash } from "node:crypto";
import type { MediaOwner } from "./contracts.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export const mediaAccountDirectory = (accountId: string): string => digest(accountId);

export async function consumeImmutableMedia(input: {
  readonly accountId: string;
  readonly owner: MediaOwner;
  readonly kind: "image" | "video" | "audio" | "document" | "sticker";
  readonly source: AsyncIterable<Uint8Array>;
  readonly consume: (chunk: Uint8Array) => void | Promise<void>;
}): Promise<{ readonly ref: string; readonly byteLength: number }> {
  const owner =
    input.owner.type === "message"
      ? [input.owner.message.chatId, input.owner.message.id]
      : ["operation", input.owner.operationId];
  const hash = createHash("sha256")
    .update(JSON.stringify([input.accountId, owner, input.kind]))
    .update("\0");
  let byteLength = 0;
  for await (const value of input.source) {
    if (!(value instanceof Uint8Array)) throw new TypeError("media source must yield Uint8Array");
    const chunk = Uint8Array.from(value);
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError("media byte length is too large");
    hash.update(chunk);
    await input.consume(chunk);
  }
  return { ref: `media:v1:${hash.digest("hex")}`, byteLength };
}

export const mediaObjectName = (ref: string): string | undefined =>
  /^media:v1:([0-9a-f]{64})$/.exec(ref)?.[1];
