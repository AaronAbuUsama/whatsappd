import type { MediaStore } from "../src/index.ts";

export const sourceOf = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});

export const writeMedia = (
  store: MediaStore,
  input: Omit<Parameters<MediaStore["write"]>[0], "source"> & { readonly bytes: Uint8Array },
) => {
  const { bytes, ...request } = input;
  return store.write({ ...request, source: sourceOf(bytes) });
};

export async function collectMedia(
  source: AsyncIterable<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (!source) return null;
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(Uint8Array.from(chunk));
  return Uint8Array.from(Buffer.concat(chunks));
}

export const readMedia = async (
  store: MediaStore,
  input: Parameters<MediaStore["open"]>[0],
): Promise<Uint8Array | null> => collectMedia(await store.open(input));
