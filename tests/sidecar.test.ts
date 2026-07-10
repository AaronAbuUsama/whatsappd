import { expect, test } from "./_expect.ts";
import { createSidecarServer, type SidecarServer } from "../src/sidecar/server.ts";
import type {
  ChannelEvent,
  ChannelHandlers,
  WhatsAppChannelAdapter,
} from "../src/channel/types.ts";
import type { InboundMessage, MediaHandle } from "../src/model/message.ts";
import type { Outbound, SendOptions } from "../src/model/outbound.ts";
import type { PresenceKind } from "../src/model/presence.ts";
import type { SidecarEvent } from "../src/sidecar/wire.ts";

/** A fake adapter that records outbound calls and lets tests inject events. */
function fakeAdapter(accountId: string) {
  const handlers = new Set<ChannelHandlers>();
  const sends: { to: string; content: Outbound; opts?: SendOptions }[] = [];
  const markReadCalls: string[] = [];
  const typingCalls: { chatId: string; kind: PresenceKind }[] = [];
  const adapter: WhatsAppChannelAdapter = {
    accountId,
    async start() {},
    async send(to, content, opts) {
      sends.push({ to, content, opts });
      return { id: "SENT1", chatId: to, fromMe: true };
    },
    async markRead(chatId) {
      markReadCalls.push(chatId);
    },
    async setTyping(chatId, kind) {
      typingCalls.push({ chatId, kind });
    },
    subscribe(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    async stop() {},
  };
  /** Push an event through every subscriber, awaiting async handlers. */
  const emit = (event: ChannelEvent): Promise<unknown> =>
    Promise.all([...handlers].map(async (h) => h.onEvent(event)));
  return { adapter, sends, markReadCalls, typingCalls, emit, handlers };
}

function inbound(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "M1",
    chatId: "111@s.whatsapp.net",
    from: "111@s.whatsapp.net",
    pushName: "Ann",
    fromMe: false,
    timestamp: 1675888000,
    live: true,
    isGroup: false,
    kind: "text",
    text,
    ...over,
  } as InboundMessage;
}

function messageEvent(msg: InboundMessage): ChannelEvent {
  return {
    type: "message",
    ref: { chatId: msg.chatId, isGroup: msg.isGroup, from: msg.from, pushName: msg.pushName },
    message: msg,
  };
}

/** The URL of a fetch input, without [object Object] surprises. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Captures every forwarded event the sidecar POSTs at a framework. */
function fakeForwardSink() {
  const posts: { url: string; auth: string | null; event: SidecarEvent }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    posts.push({
      url: urlOf(input),
      auth: new Headers(init?.headers).get("authorization"),
      event: JSON.parse(init?.body as string) as SidecarEvent,
    });
    return new Response("{}", { status: 200 });
  };
  return { posts, fetchFn };
}

async function withServer(
  options: Parameters<typeof createSidecarServer>[0],
  run: (base: string, server: SidecarServer) => Promise<void>,
): Promise<void> {
  const server = createSidecarServer(options);
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    await run(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.close();
  }
}

const post = (base: string, path: string, body: unknown, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

// ── outbound endpoints ──

test("POST /send delivers text through the adapter and returns the ref", async () => {
  const a = fakeAdapter("acc");
  await withServer({ adapter: a.adapter }, async (base) => {
    const res = await post(base, "/send", {
      accountId: "acc",
      chatId: "111@s.whatsapp.net",
      content: { text: "hello" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: { id: string } };
    expect(body.ref.id).toBe("SENT1");
    expect(a.sends.length).toBe(1);
    expect((a.sends[0]!.content as { text: string }).text).toBe("hello");
  });
});

test("POST /send revives b64 media into a Buffer", async () => {
  const a = fakeAdapter("acc");
  await withServer({ adapter: a.adapter }, async (base) => {
    await post(base, "/send", {
      accountId: "acc",
      chatId: "111@s.whatsapp.net",
      content: { image: { b64: Buffer.from("img").toString("base64") }, caption: "pic" },
    });
    const content = a.sends[0]!.content as { image: Buffer };
    expect(Buffer.isBuffer(content.image)).toBe(true);
    expect(content.image.toString()).toBe("img");
  });
});

test("POST /markRead and /setTyping reach the adapter; wrong accountId is rejected", async () => {
  const a = fakeAdapter("a1");
  await withServer({ adapter: a.adapter }, async (base) => {
    await post(base, "/markRead", { accountId: "a1", chatId: "c@s.whatsapp.net" });
    await post(base, "/setTyping", { accountId: "a1", chatId: "c@s.whatsapp.net" });
    expect(a.markReadCalls).toEqual(["c@s.whatsapp.net"]);
    expect(a.typingCalls[0]!.kind).toBe("typing");

    // A misaddressed request (another sidecar's account) must not deliver here.
    const wrong = await post(base, "/markRead", { accountId: "a2", chatId: "c@s.whatsapp.net" });
    expect(wrong.status).toBe(404);
    expect(a.markReadCalls.length).toBe(1);
  });
});

test("unknown account → 404, bad JSON → 400, unknown route → 404", async () => {
  const a = fakeAdapter("acc");
  await withServer({ adapter: a.adapter }, async (base) => {
    const missing = await post(base, "/send", { accountId: "nope", chatId: "c", content: {} });
    expect(missing.status).toBe(404);
    const bad = await fetch(`${base}/send`, { method: "POST", body: "{oops" });
    expect(bad.status).toBe(400);
    const nowhere = await fetch(`${base}/nope`);
    expect(nowhere.status).toBe(404);
  });
});

test("token guards every route", async () => {
  const a = fakeAdapter("acc");
  await withServer({ adapter: a.adapter, token: "s3cret" }, async (base) => {
    const denied = await post(base, "/markRead", { accountId: "acc", chatId: "c" });
    expect(denied.status).toBe(401);
    expect(a.markReadCalls.length).toBe(0);
    const allowed = await post(base, "/markRead", { accountId: "acc", chatId: "c" }, "s3cret");
    expect(allowed.status).toBe(200);
    const health = await fetch(`${base}/health`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(health.status).toBe(200);
  });
});

test("GET /health reports the account", async () => {
  const a = fakeAdapter("a1");
  await withServer({ adapter: a.adapter }, async (base) => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ ok: true, accounts: ["a1"] });
  });
});

// ── event forwarding ──

test("inbound messages are forwarded as wire events with the token", async () => {
  const a = fakeAdapter("acc");
  const sink = fakeForwardSink();
  await withServer(
    {
      adapter: a.adapter,
      forward: [{ url: "https://app.example/event", token: "s3cret" }],
      fetchFn: sink.fetchFn,
    },
    async () => {
      await a.emit(messageEvent(inbound("hi there")));
      expect(sink.posts.length).toBe(1);
      expect(sink.posts[0]!.url).toBe("https://app.example/event");
      expect(sink.posts[0]!.auth).toBe("Bearer s3cret");
      const event = sink.posts[0]!.event;
      if (event.type !== "message") throw new Error("expected message event");
      expect(event.accountId).toBe("acc");
      expect(event.chatId).toBe("111@s.whatsapp.net");
      expect(event.pushName).toBe("Ann");
      if (event.message.kind !== "text") throw new Error("expected text");
      expect(event.message.text).toBe("hi there");
    },
  );
});

test("own (fromMe) messages are NOT forwarded — no reply loops", async () => {
  const a = fakeAdapter("acc");
  const sink = fakeForwardSink();
  await withServer(
    {
      adapter: a.adapter,
      forward: [{ url: "https://app.example/event" }],
      fetchFn: sink.fetchFn,
    },
    async () => {
      await a.emit(messageEvent(inbound("me talking", { fromMe: true })));
      expect(sink.posts.length).toBe(0);
    },
  );
});

test("update and status events are forwarded too", async () => {
  const a = fakeAdapter("acc");
  const sink = fakeForwardSink();
  await withServer(
    {
      adapter: a.adapter,
      forward: [{ url: "https://app.example/event" }],
      fetchFn: sink.fetchFn,
    },
    async () => {
      await a.emit({
        type: "update",
        ref: { chatId: "111@s.whatsapp.net", isGroup: false },
        update: {
          kind: "receipt",
          ref: { id: "M1", chatId: "111@s.whatsapp.net", fromMe: true },
          status: "read",
        },
      });
      await a.emit({ type: "status", accountId: "acc", status: { phase: "online" } });
      expect(sink.posts.map((p) => p.event.type)).toEqual(["update", "status"]);
    },
  );
});

// ── media bridge ──

test("media messages carry a URL and GET /media serves the bytes", async () => {
  const a = fakeAdapter("acc");
  const sink = fakeForwardSink();
  const media: MediaHandle = {
    mimetype: "image/jpeg",
    caption: "sunset",
    download: async () => Buffer.from("jpegbytes"),
  };
  const msg = inbound("", { id: "IMG1", kind: "image", media, text: undefined });
  await withServer(
    {
      adapter: a.adapter,
      forward: [{ url: "https://app.example/event" }],
      fetchFn: sink.fetchFn,
    },
    async (base) => {
      await a.emit(messageEvent(msg));
      const event = sink.posts[0]!.event;
      if (event.type !== "message" || event.message.kind !== "image")
        throw new Error("expected image event");
      expect(event.message.media.url).toBe("/media/acc/IMG1");

      const res = await fetch(`${base}${event.message.media.url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("jpegbytes");
    },
  );
});

test("media URLs are absolute when baseUrl is configured", async () => {
  const a = fakeAdapter("acc");
  const sink = fakeForwardSink();
  const msg = inbound("", {
    id: "IMG2",
    kind: "image",
    media: { download: async () => Buffer.from("x") },
    text: undefined,
  });
  await withServer(
    {
      adapter: a.adapter,
      forward: [{ url: "https://app.example/event" }],
      baseUrl: "https://sidecar.example",
      fetchFn: sink.fetchFn,
    },
    async () => {
      await a.emit(messageEvent(msg));
      const event = sink.posts[0]!.event;
      if (event.type !== "message" || event.message.kind !== "image")
        throw new Error("expected image event");
      expect(event.message.media.url).toBe("https://sidecar.example/media/acc/IMG2");
    },
  );
});

test("expired media returns 404", async () => {
  const a = fakeAdapter("acc");
  await withServer({ adapter: a.adapter }, async (base) => {
    const res = await fetch(`${base}/media/acc/GONE`);
    expect(res.status).toBe(404);
  });
});

test("media cache evicts the oldest entries beyond capacity", async () => {
  const a = fakeAdapter("acc");
  const sink = fakeForwardSink();
  await withServer(
    {
      adapter: a.adapter,
      forward: [{ url: "https://x/event" }],
      mediaCacheSize: 2,
      fetchFn: sink.fetchFn,
    },
    async (base) => {
      for (const id of ["A", "B", "C"]) {
        await a.emit(
          messageEvent(
            inbound("", {
              id,
              kind: "image",
              media: { download: async () => Buffer.from(id) },
              text: undefined,
            }),
          ),
        );
      }
      expect((await fetch(`${base}/media/acc/A`)).status).toBe(404); // evicted
      expect((await fetch(`${base}/media/acc/B`)).status).toBe(200);
      expect((await fetch(`${base}/media/acc/C`)).status).toBe(200);
    },
  );
});

test("close() unsubscribes from the adapter", async () => {
  const a = fakeAdapter("acc");
  const server = createSidecarServer({ adapter: a.adapter });
  expect(a.handlers.size).toBe(1);
  await server.listen(0, "127.0.0.1");
  await server.close();
  expect(a.handlers.size).toBe(0);
});
