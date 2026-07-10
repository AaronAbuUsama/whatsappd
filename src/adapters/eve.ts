/**
 * Eve channel adapter — a plug-and-play WhatsApp channel for the Eve
 * framework, bridged to the WhatsApp sidecar over HTTP.
 *
 * The sidecar owns the socket to WhatsApp; this adapter is a thin HTTP
 * client on both directions:
 *
 *   inbound   sidecar → POST /event → `send()` starts/resumes the session
 *             (`continuationToken` = chatId, so one WhatsApp conversation
 *             maps to one Eve session)
 *   outbound  "message.completed" → POST sidecar /send
 *             "turn.started"      → POST sidecar /markRead + /setTyping
 *   media     inbound media arrives as a sidecar URL; `fetchFile` stages
 *             the bytes with the shared bearer token
 *
 * Drop it into an Eve app as `agent/channels/whatsapp.ts`:
 *
 *   export { default } from "whatsappd/adapters/eve";
 *
 * or configure explicitly:
 *
 *   import { whatsappChannel } from "whatsappd/adapters/eve";
 *   export default whatsappChannel({ sidecarUrl: "http://localhost:8788" });
 *
 * @packageDocumentation
 */
import {
  defineChannel,
  POST,
  type Channel,
  type ChannelEvents,
  type RouteHandlerArgs,
} from "eve/channels";
import { messagePreview, type SidecarEvent, type WireMessage } from "../sidecar/wire.ts";

/** Durable per-session adapter state — enough to address the sidecar. */
export interface WhatsAppEveState {
  accountId: string;
  chatId: string;

  [key: string]: unknown;
}

/** The `channel` context handed to event handlers. */
export interface WhatsAppEveContext {
  readonly accountId: string;
  readonly chatId: string;
}

/** Observability projection (a type alias so it satisfies eve's Record constraint). */
export type WhatsAppEveMetadata = { readonly accountId: string; readonly chatId: string };

export interface WhatsAppEveOptions {
  /** Sidecar base URL. Default: `WHATSAPP_SIDECAR_URL` env var. */
  readonly sidecarUrl?: string;
  /**
   * Shared bearer token: required on inbound `/event` posts and sent on
   * outbound sidecar calls. Default: `WHATSAPP_SIDECAR_TOKEN` env var.
   */
  readonly token?: string;
  /** Mark the conversation read when the agent starts a turn. Default true. */
  readonly markRead?: boolean;
  /** Show typing presence while the agent works on a turn. Default true. */
  readonly typing?: boolean;
  /** `auth.authenticator` value on started sessions. Default "whatsapp-baileys". */
  readonly authenticator?: string;
  /** Testing seam — defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

interface ResolvedOptions {
  readonly sidecarUrl: string;
  readonly token?: string;
  readonly markRead: boolean;
  readonly typing: boolean;
  readonly authenticator: string;
  readonly fetchFn: typeof fetch;
}

/** Resolve lazily so env vars are read per call, not at import time. */
function resolve(opts: WhatsAppEveOptions): ResolvedOptions {
  const sidecarUrl = opts.sidecarUrl ?? process.env.WHATSAPP_SIDECAR_URL;
  if (!sidecarUrl) throw new Error("whatsappd: set WHATSAPP_SIDECAR_URL or pass { sidecarUrl }");
  return {
    sidecarUrl,
    token: opts.token ?? process.env.WHATSAPP_SIDECAR_TOKEN,
    markRead: opts.markRead ?? true,
    typing: opts.typing ?? true,
    authenticator: opts.authenticator ?? "whatsapp-baileys",
    fetchFn: opts.fetchFn ?? fetch,
  };
}

type ContentPart = { type: "text"; text: string } | { type: "file"; data: URL; mediaType: string };

/**
 * Project a wire message onto Eve `UserContent` parts: the text (or a
 * `[kind]` preview), plus the media as a URL file part the framework stages
 * through `fetchFile`.
 */
export function toUserContent(message: WireMessage, sidecarUrl: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const text = messagePreview(message);
  if (text.length > 0) parts.push({ type: "text", text });
  if ("media" in message && message.media.url) {
    parts.push({
      type: "file",
      data: new URL(message.media.url, sidecarUrl),
      mediaType: message.media.mimetype ?? "application/octet-stream",
    });
  }
  return parts;
}

/**
 * Handler for `POST /event` — the sidecar posts every inbound WhatsApp event
 * here; message events start or resume the Eve session for that chat.
 * Exported for tests; wired into the channel by `whatsappChannel`.
 */
export function createEventRoute(opts: WhatsAppEveOptions) {
  return async (req: Request, args: RouteHandlerArgs<WhatsAppEveState>): Promise<Response> => {
    const c = resolve(opts);
    if (c.token && req.headers.get("authorization") !== `Bearer ${c.token}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const event = (await req.json()) as SidecarEvent;
    if (event.type !== "message" || event.message.fromMe) {
      return Response.json({ ignored: true });
    }

    const { accountId, chatId, isGroup, from, pushName, message } = event;
    const session = await args.send(toUserContent(message, c.sidecarUrl), {
      auth: {
        authenticator: c.authenticator,
        principalType: "contact",
        principalId: from ?? chatId,
        attributes: {
          accountId,
          chatId,
          isGroup: String(isGroup),
          ...(from !== undefined && { from }),
          ...(pushName !== undefined && { pushName }),
        },
      },
      continuationToken: chatId,
      state: { accountId, chatId },
      title: `WhatsApp: ${pushName ?? chatId}`,
    });
    return Response.json({ sessionId: session.id });
  };
}

/**
 * Session lifecycle handlers: agent replies go back to the sidecar for
 * delivery; turn start drives read receipts and typing presence.
 * Exported for tests; wired into the channel by `whatsappChannel`.
 */
export function createEventHandlers(opts: WhatsAppEveOptions): ChannelEvents<WhatsAppEveContext> {
  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    const c = resolve(opts);
    return c.fetchFn(new URL(path, c.sidecarUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(c.token && { authorization: `Bearer ${c.token}` }),
      },
      body: JSON.stringify(body),
    });
  }

  return {
    // Best-effort UX signals — a sidecar hiccup must not fail the turn.
    async "turn.started"(_data, channel): Promise<void> {
      const c = resolve(opts);
      const target = { accountId: channel.accountId, chatId: channel.chatId };
      const signals: Promise<Response>[] = [];
      if (c.markRead) signals.push(post("/markRead", target));
      if (c.typing) signals.push(post("/setTyping", { ...target, kind: "typing" }));
      await Promise.allSettled(signals);
    },

    // Reply delivery is the channel's whole job — let failures surface.
    async "message.completed"(data, channel): Promise<void> {
      if (typeof data.message !== "string" || data.message.length === 0) return;
      const res = await post("/send", {
        accountId: channel.accountId,
        chatId: channel.chatId,
        content: { text: data.message },
      });
      if (!res.ok) {
        throw new Error(`whatsappd: sidecar /send failed with ${res.status}`);
      }
    },
  };
}

/**
 * `fetchFile` hook — stages media file parts whose URL points at the
 * sidecar, attaching the bearer token. Other URLs pass through untouched.
 * Exported for tests; wired into the channel by `whatsappChannel`.
 */
export function createFetchFile(opts: WhatsAppEveOptions) {
  return async (
    url: string,
  ): Promise<{ bytes: Buffer; mediaType?: string; filename?: string } | null> => {
    const c = resolve(opts);
    if (!url.startsWith(new URL("/", c.sidecarUrl).origin)) return null;
    const res = await c.fetchFn(url, {
      headers: { ...(c.token && { authorization: `Bearer ${c.token}` }) },
    });
    if (!res.ok) throw new Error(`whatsappd: media fetch failed with ${res.status}`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mediaType: res.headers.get("content-type") ?? undefined,
    };
  };
}

/**
 * Build the WhatsApp channel for an Eve app. Place the result (or the
 * default export) at `agent/channels/whatsapp.ts` — the file stem becomes
 * the channel id.
 */
export function whatsappChannel(
  opts: WhatsAppEveOptions = {},
): Channel<WhatsAppEveState, Record<string, unknown>, WhatsAppEveMetadata> {
  return defineChannel<
    WhatsAppEveState,
    WhatsAppEveContext,
    Record<string, unknown>,
    WhatsAppEveMetadata
  >({
    kindHint: "whatsapp",
    context: (state) => ({ accountId: state.accountId, chatId: state.chatId }),
    metadata: (state) => ({ accountId: state.accountId, chatId: state.chatId }),
    routes: [POST("/event", createEventRoute(opts))],
    events: createEventHandlers(opts),
    fetchFile: createFetchFile(opts),
  });
}

/** Zero-config channel: reads `WHATSAPP_SIDECAR_URL` / `WHATSAPP_SIDECAR_TOKEN`. */
export default whatsappChannel();
