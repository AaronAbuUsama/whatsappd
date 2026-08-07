import { readFile } from "node:fs/promises";
import type { BinaryInput } from "../model/outbound.ts";

export async function bytesOfBinaryInput(input: BinaryInput): Promise<Uint8Array> {
  if (Buffer.isBuffer(input)) return Uint8Array.from(input);
  if ("url" in input) {
    if (input.url.startsWith("data:")) {
      const encoded = input.url.split(",", 2)[1];
      if (encoded === undefined) throw new TypeError("media data URL has no payload");
      return Uint8Array.from(Buffer.from(encoded, "base64"));
    }
    if (input.url.startsWith("http://") || input.url.startsWith("https://")) {
      const response = await fetch(input.url);
      if (!response.ok) throw new Error(`media URL returned ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    return Uint8Array.from(await readFile(input.url));
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of input.stream) {
    if (!(chunk instanceof Uint8Array))
      throw new TypeError("media stream must yield Uint8Array chunks");
    const owned = Uint8Array.from(chunk);
    chunks.push(owned);
    byteLength += owned.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
