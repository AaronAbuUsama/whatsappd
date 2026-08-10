export type MediaResponseTarget = {
  readonly source: AsyncIterable<Uint8Array>;
  readonly byteLength: number;
  readonly mimetype: string;
  readonly fileName?: string;
};

type ByteRange = { readonly start: number; readonly end: number };

function byteRange(value: string, length: number): ByteRange | undefined {
  if (length < 1) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (!first && !last) return undefined;
  if (!first) {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return undefined;
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(first);
  const requestedEnd = last ? Number(last) : length - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= length ||
    requestedEnd < start
  )
    return undefined;
  return { start, end: Math.min(requestedEnd, length - 1) };
}

function bodyOf(
  source: AsyncIterable<Uint8Array>,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let skip = start;
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      while (remaining > 0) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const chunk = next.value;
        if (skip >= chunk.byteLength) {
          skip -= chunk.byteLength;
          continue;
        }
        const available = chunk.subarray(skip, skip + remaining);
        skip = 0;
        remaining -= available.byteLength;
        controller.enqueue(available);
        if (remaining === 0) {
          await iterator.return?.();
          controller.close();
        }
        return;
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

const safeFileName = (value: string): string => value.replace(/[\r\n"\\]/gu, "_");

export function mediaResponse(request: Request, target: MediaResponseTarget): Response {
  const requested = request.headers.get("range");
  const range = requested ? byteRange(requested, target.byteLength) : undefined;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Type": target.mimetype,
  });
  if (target.fileName)
    headers.set("Content-Disposition", `inline; filename="${safeFileName(target.fileName)}"`);
  if (requested && !range) {
    headers.set("Content-Range", `bytes */${target.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? target.byteLength - 1;
  const length = end - start + 1;
  headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${target.byteLength}`);
  return new Response(bodyOf(target.source, start, length), {
    status: range ? 206 : 200,
    headers,
  });
}
