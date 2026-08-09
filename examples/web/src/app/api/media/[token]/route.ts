import { mediaTarget } from "@/lib/whatsapp.server";

export const dynamic = "force-dynamic";

function safeFileName(value: string): string {
  return value.replace(/[\r\n"\\]/gu, "_");
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const target = await mediaTarget(token);
  if (!target) return new Response("Not found", { status: 404 });

  const iterator = target.source[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": target.mimetype,
  });
  if (target.fileName) {
    headers.set("Content-Disposition", `inline; filename="${safeFileName(target.fileName)}"`);
  }
  return new Response(body, { headers });
}
