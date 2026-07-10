import { expect, test } from "./_expect.ts";
import type { RouteHandlerArgs, Session } from "eve/channels";
import {
  createEventHandlers,
  createEventRoute,
  createFetchFile,
  toUserContent,
  whatsappChannel,
  type WhatsAppEveState,
} from "../src/adapters/eve.ts";
import type { SidecarEvent, WireMessage } from "../src/sidecar/wire.ts";

const SIDECAR = "http://sidecar.local:8788";

function wireText(text: string, over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: "M1",
    chatId: "111@s.whatsapp.net",
    from: "111@s.whatsapp.net",
    pushName: "Ann",
    fromMe: false,
    timestamp: 1675888000,
    isGroup: false,
    kind: "text",
    text,
    ...over,
  } as WireMessage;
}

function messageEvent(message: WireMessage): SidecarEvent {
  return {
    type: "message",
    accountId: "acc",
    chatId: message.chatId,
    isGroup: message.isGroup,
    from: message.from,
    pushName: message.pushName,
    message,
  };
}

/** Fake `args.send` that records what the channel asked Eve to run. */
function fakeSend() {
  const calls: { input: unknown; options: Record<string, unknown> }[] = [];
  const send = async (input: unknown, options: unknown): Promise<Session> => {
    calls.push({ input, options: options as Record<string, unknown> });
    return {
      id: "SESSION1",
      continuationToken: "whatsapp:111@s.whatsapp.net",
      getEventStream: () => Promise.reject(new Error("not used")),
    };
  };
  return { calls, send };
}

function routeArgs(send: unknown): RouteHandlerArgs<WhatsAppEveState> {
  return { send } as unknown as RouteHandlerArgs<WhatsAppEveState>;
}

function postReq(body: unknown, token?: string): Request {
  return new Request("http://app.local/event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

/** The URL of a fetch input, without [object Object] surprises. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Records outbound fetches and answers with a canned response. */
function fakeFetch(status = 200, body = "{}", headers?: Record<string, string>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: urlOf(input), init });
    return new Response(body, { status, headers });
  };
  return { calls, fetchFn };
}

// ── toUserContent ──

test("toUserContent maps text to a single text part", () => {
  expect(toUserContent(wireText("hello"), SIDECAR)).toEqual([{ type: "text", text: "hello" }]);
});

test("toUserContent adds a file part for media with a sidecar URL", () => {
  const msg = wireText("", {
    kind: "image",
    media: { mimetype: "image/jpeg", caption: "sunset", url: "/media/acc/M1" },
    text: undefined,
  });
  const parts = toUserContent(msg, SIDECAR);
  expect(parts.length).toBe(2);
  expect(parts[0]).toEqual({ type: "text", text: "sunset" });
  const file = parts[1] as { type: "file"; data: URL; mediaType: string };
  expect(file.data.href).toBe(`${SIDECAR}/media/acc/M1`);
  expect(file.mediaType).toBe("image/jpeg");
});

test("toUserContent falls back to a [kind] preview without a media URL", () => {
  const msg = wireText("", { kind: "sticker", media: {}, text: undefined });
  expect(toUserContent(msg, SIDECAR)).toEqual([{ type: "text", text: "[sticker]" }]);
});

// ── POST /event route ──

test("message events start a session keyed by chatId", async () => {
  const { calls, send } = fakeSend();
  const route = createEventRoute({ sidecarUrl: SIDECAR });
  const res = await route(postReq(messageEvent(wireText("hi"))), routeArgs(send));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sessionId: "SESSION1" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.input).toEqual([{ type: "text", text: "hi" }]);
  expect(calls[0]!.options.continuationToken).toBe("111@s.whatsapp.net");
  expect(calls[0]!.options.state).toEqual({ accountId: "acc", chatId: "111@s.whatsapp.net" });
  expect(calls[0]!.options.title).toBe("WhatsApp: Ann");
  const auth = calls[0]!.options.auth as {
    authenticator: string;
    principalId: string;
    attributes: Record<string, string>;
  };
  expect(auth.authenticator).toBe("whatsapp-baileys");
  expect(auth.principalId).toBe("111@s.whatsapp.net");
  expect(auth.attributes.accountId).toBe("acc");
  expect(auth.attributes.isGroup).toBe("false");
  expect(auth.attributes.pushName).toBe("Ann");
});

test("update, status, and fromMe events are ignored", async () => {
  const { calls, send } = fakeSend();
  const route = createEventRoute({ sidecarUrl: SIDECAR });

  const status = await route(
    postReq({ type: "status", accountId: "acc", status: { phase: "online" } }),
    routeArgs(send),
  );
  expect(await status.json()).toEqual({ ignored: true });

  const fromMe = await route(
    postReq(messageEvent(wireText("me", { fromMe: true }))),
    routeArgs(send),
  );
  expect(await fromMe.json()).toEqual({ ignored: true });
  expect(calls.length).toBe(0);
});

test("a configured token rejects unauthenticated events", async () => {
  const { calls, send } = fakeSend();
  const route = createEventRoute({ sidecarUrl: SIDECAR, token: "s3cret" });

  const denied = await route(postReq(messageEvent(wireText("hi"))), routeArgs(send));
  expect(denied.status).toBe(401);
  expect(calls.length).toBe(0);

  const allowed = await route(postReq(messageEvent(wireText("hi")), "s3cret"), routeArgs(send));
  expect(allowed.status).toBe(200);
  expect(calls.length).toBe(1);
});

// ── session lifecycle events ──

const channelCtx = {
  accountId: "acc",
  chatId: "111@s.whatsapp.net",
  continuationToken: "111@s.whatsapp.net",
  setContinuationToken: () => {},
};

test("message.completed posts the reply to the sidecar /send", async () => {
  const { calls, fetchFn } = fakeFetch();
  const handlers = createEventHandlers({ sidecarUrl: SIDECAR, token: "s3cret", fetchFn });
  await handlers["message.completed"]!(
    { finishReason: "stop", message: "the answer", sequence: 0, stepIndex: 0, turnId: "t1" },
    channelCtx,
    undefined as never,
  );
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe(`${SIDECAR}/send`);
  expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer s3cret");
  expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
    accountId: "acc",
    chatId: "111@s.whatsapp.net",
    content: { text: "the answer" },
  });
});

test("message.completed skips empty assistant messages", async () => {
  const { calls, fetchFn } = fakeFetch();
  const handlers = createEventHandlers({ sidecarUrl: SIDECAR, fetchFn });
  await handlers["message.completed"]!(
    { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId: "t1" },
    channelCtx,
    undefined as never,
  );
  expect(calls.length).toBe(0);
});

test("message.completed surfaces sidecar delivery failures", async () => {
  const { fetchFn } = fakeFetch(502);
  const handlers = createEventHandlers({ sidecarUrl: SIDECAR, fetchFn });
  let error: unknown;
  await Promise.resolve(
    handlers["message.completed"]!(
      { finishReason: "stop", message: "hi", sequence: 0, stepIndex: 0, turnId: "t1" },
      channelCtx,
      undefined as never,
    ),
  ).catch((err: unknown) => (error = err));
  expect(error instanceof Error).toBe(true);
  expect((error as Error).message.includes("502")).toBe(true);
});

test("turn.started marks read and sets typing, best-effort", async () => {
  const { calls, fetchFn } = fakeFetch();
  const handlers = createEventHandlers({ sidecarUrl: SIDECAR, fetchFn });
  await handlers["turn.started"]!({ sequence: 0, turnId: "t1" }, channelCtx, undefined as never);
  expect(calls.map((c) => c.url)).toEqual([`${SIDECAR}/markRead`, `${SIDECAR}/setTyping`]);
});

test("turn.started respects markRead/typing opt-outs and swallows failures", async () => {
  const failing = fakeFetch(500);
  const handlers = createEventHandlers({
    sidecarUrl: SIDECAR,
    typing: false,
    fetchFn: failing.fetchFn,
  });
  // must not throw even though the sidecar answers 500
  await handlers["turn.started"]!({ sequence: 0, turnId: "t1" }, channelCtx, undefined as never);
  expect(failing.calls.map((c) => c.url)).toEqual([`${SIDECAR}/markRead`]);
});

// ── fetchFile ──

test("fetchFile stages sidecar media with the bearer token", async () => {
  const { calls, fetchFn } = fakeFetch(200, "jpegbytes", { "content-type": "image/jpeg" });
  const fetchFile = createFetchFile({ sidecarUrl: SIDECAR, token: "s3cret", fetchFn });
  const result = await fetchFile(`${SIDECAR}/media/acc/M1`);
  expect(result !== null).toBe(true);
  expect(result!.bytes.toString()).toBe("jpegbytes");
  expect(result!.mediaType).toBe("image/jpeg");
  expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer s3cret");
});

test("fetchFile passes non-sidecar URLs through as null", async () => {
  const { calls, fetchFn } = fakeFetch();
  const fetchFile = createFetchFile({ sidecarUrl: SIDECAR, fetchFn });
  expect(await fetchFile("https://elsewhere.example/file.png")).toBe(null);
  expect(calls.length).toBe(0);
});

// ── channel assembly ──

test("whatsappChannel exposes the POST /event route", () => {
  const channel = whatsappChannel({ sidecarUrl: SIDECAR });
  const route = channel.routes.find((r) => r.path === "/event");
  expect(route !== undefined).toBe(true);
  expect(route!.method).toBe("POST");
});
