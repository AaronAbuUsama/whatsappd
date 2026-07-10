/**
 * Sidecar HTTP server — wraps one account's {@link WhatsAppChannelAdapter}
 * behind a plain HTTP surface so framework adapters (Eve, or any HTTP client)
 * never touch the WhatsApp socket. One sidecar process = one WhatsApp account;
 * run more processes for more numbers (they can all forward into the same app —
 * events carry `accountId` so the receiver can tell them apart):
 *
 *   POST /send       { accountId, chatId, content, opts? }  → { ref }
 *   POST /markRead   { accountId, chatId }                  → { ok }
 *   POST /setTyping  { accountId, chatId, kind? }           → { ok }
 *   GET  /media/:accountId/:messageId                       → decrypted bytes
 *   GET  /health                                            → { ok, accounts }
 *
 * Inbound WhatsApp events are pushed the other way: the server subscribes to
 * the adapter and POSTs each event (as a `SidecarEvent`) to the configured
 * forward targets. Media bytes never travel in events — messages carry a
 * `/media/...` URL and the consumer pulls bytes on demand (the handles are
 * kept in a bounded in-memory cache).
 *
 * All routes (and forwarded events) carry `Authorization: Bearer <token>`
 * when a token is configured.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { ChannelEvent, WhatsAppChannelAdapter } from "../channel/types.ts";
import type { MediaHandle } from "../model/message.ts";
import {
  messagePreview,
  reviveOutbound,
  toWireMessage,
  toWireUpdate,
  type MarkReadRequest,
  type SendRequest,
  type SetTypingRequest,
  type SidecarEvent,
} from "./wire.ts";

/** One URL the sidecar POSTs inbound `SidecarEvent`s to (e.g. Eve's `/event`). */
export interface ForwardTarget {
  readonly url: string;
  /** Sent as `Authorization: Bearer <token>` on every forwarded event. */
  readonly token?: string;
}

export interface SidecarServerOptions {
  /** The account this sidecar serves. */
  readonly adapter: WhatsAppChannelAdapter;
  /** Where to POST inbound events. Empty = events are not forwarded. */
  readonly forward?: readonly ForwardTarget[];
  /** When set, every incoming request must carry `Authorization: Bearer <token>`. */
  readonly token?: string;
  /** Absolute base for media URLs in events; relative `/media/...` when unset. */
  readonly baseUrl?: string;
  readonly logger?: Logger;
  /** How many recent media handles to keep downloadable. Default 512. */
  readonly mediaCacheSize?: number;
  /** Testing seam — defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

export interface SidecarServer {
  /** The underlying Node server, for hosts that need to attach to it. */
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number }>;
  /** Unsubscribe from the adapter and close the HTTP server. */
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

export function createSidecarServer(options: SidecarServerOptions): SidecarServer {
  const log = options.logger;
  const fetchFn = options.fetchFn ?? fetch;
  const forward = options.forward ?? [];
  const mediaCapacity = options.mediaCacheSize ?? 512;
  const adapter = options.adapter;

  // Bounded insertion-ordered cache of downloadable media, keyed accountId/messageId.
  const media = new Map<string, MediaHandle>();
  function cacheMedia(key: string, handle: MediaHandle): void {
    media.set(key, handle);
    while (media.size > mediaCapacity) {
      const oldest = media.keys().next().value;
      if (oldest === undefined) break;
      media.delete(oldest);
    }
  }

  /**
   * A misaddressed request is a routing bug on the caller's side (e.g. an app
   * serving several sidecars replying to the wrong one) — 404 it rather than
   * silently delivering through the wrong account.
   */
  function requireAccount(accountId: unknown): WhatsAppChannelAdapter {
    if (typeof accountId !== "string" || accountId.length === 0)
      throw new HttpError(400, "accountId is required");
    if (accountId !== adapter.accountId) throw new HttpError(404, `unknown account ${accountId}`);
    return adapter;
  }

  async function forwardEvent(event: SidecarEvent): Promise<void> {
    await Promise.all(
      forward.map(async (target) => {
        try {
          const res = await fetchFn(target.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(target.token && { authorization: `Bearer ${target.token}` }),
            },
            body: JSON.stringify(event),
          });
          if (!res.ok) log?.warn({ url: target.url, status: res.status }, "event forward failed");
        } catch (err) {
          log?.warn({ url: target.url, err }, "event forward failed");
        }
      }),
    );
  }

  function toSidecarEvent(accountId: string, event: ChannelEvent): SidecarEvent | undefined {
    switch (event.type) {
      case "message": {
        // Own messages (sent from this or another linked device) must not
        // re-enter the agent — that way lies an infinite reply loop.
        if (event.message.fromMe) return undefined;
        let mediaUrl: string | undefined;
        if ("media" in event.message) {
          const path = `/media/${encodeURIComponent(accountId)}/${encodeURIComponent(event.message.id)}`;
          cacheMedia(`${accountId}/${event.message.id}`, event.message.media);
          mediaUrl = options.baseUrl ? new URL(path, options.baseUrl).href : path;
        }
        return {
          type: "message",
          accountId,
          chatId: event.ref.chatId,
          isGroup: event.ref.isGroup,
          from: event.ref.from,
          pushName: event.ref.pushName,
          message: toWireMessage(event.message, mediaUrl),
        };
      }
      case "update":
        return {
          type: "update",
          accountId,
          chatId: event.ref.chatId,
          update: toWireUpdate(event.update),
        };
      case "status":
        return { type: "status", accountId, status: event.status };
    }
  }

  const unsubscribe = adapter.subscribe({
    async onEvent(event: ChannelEvent): Promise<void> {
      const wire = toSidecarEvent(adapter.accountId, event);
      if (wire) await forwardEvent(wire);
    },
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`)
      throw new HttpError(401, "unauthorized");

    const url = new URL(req.url ?? "/", "http://sidecar");
    const key = `${req.method} ${url.pathname}`;

    if (key === "GET /health") {
      sendJson(res, 200, { ok: true, accounts: [adapter.accountId] });
      return;
    }

    if (key === "POST /send") {
      const body = await readJson<SendRequest>(req);
      const target = requireAccount(body.accountId);
      const ref = await target.send(body.chatId, reviveOutbound(body.content), body.opts);
      sendJson(res, 200, { ref });
      return;
    }

    if (key === "POST /markRead") {
      const body = await readJson<MarkReadRequest>(req);
      await requireAccount(body.accountId).markRead(body.chatId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (key === "POST /setTyping") {
      const body = await readJson<SetTypingRequest>(req);
      await requireAccount(body.accountId).setTyping(body.chatId, body.kind ?? "typing");
      sendJson(res, 200, { ok: true });
      return;
    }

    const mediaMatch = /^\/media\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && mediaMatch) {
      const cacheKey = `${decodeURIComponent(mediaMatch[1]!)}/${decodeURIComponent(mediaMatch[2]!)}`;
      const handle = media.get(cacheKey);
      if (!handle) throw new HttpError(404, "media not available (expired from cache?)");
      const bytes = await handle.download();
      res.writeHead(200, {
        "content-type": handle.mimetype ?? "application/octet-stream",
        "content-length": bytes.length,
      });
      res.end(bytes);
      return;
    }

    throw new HttpError(404, `no route for ${key}`);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log?.error({ err, url: req.url }, "sidecar request failed");
      const message = err instanceof Error ? err.message : "internal error";
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });

  return {
    server,

    listen(port: number, host = "0.0.0.0"): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          const boundPort = typeof address === "object" && address ? address.port : port;
          log?.info({ port: boundPort }, "sidecar listening");
          resolve({ port: boundPort });
        });
      });
    },

    close(): Promise<void> {
      unsubscribe();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Re-exported so HTTP consumers can share the preview logic. */
export { messagePreview };
