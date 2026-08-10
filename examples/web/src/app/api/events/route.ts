import { subscribeApplication } from "@/lib/whatsapp.server";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(request: Request): Promise<Response> {
  let unsubscribe = (): void => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = (): void => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", close, { once: true });
      try {
        unsubscribe = await subscribeApplication(() => {
          try {
            controller.enqueue(encoder.encode("event: change\ndata: {}\n\n"));
          } catch {}
        });
        if (request.signal.aborted) return close();
        controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {}
        }, 15_000);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    },
  });
  return new Response(body, {
    headers: {
      "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
