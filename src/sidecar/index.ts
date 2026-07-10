/**
 * Sidecar entry point — boots one WhatsApp session, its channel adapter, and
 * the HTTP server. One sidecar process = one WhatsApp account; run more
 * processes for more numbers. Run it standalone:
 *
 *   WHATSAPP_FORWARD_URLS=... node --experimental-strip-types src/sidecar/index.ts
 *
 * Environment:
 *   PORT                    HTTP port (default 8788)
 *   HOST                    bind host (default 0.0.0.0)
 *   WHATSAPP_ACCOUNT        account label on events/requests (default "default")
 *   WHATSAPP_STORE_DIR      credential store directory (default ./.wa-auth)
 *   WHATSAPP_PAIRING_PHONE  E.164 phone for pairing-code login (default: QR)
 *   WHATSAPP_FORWARD_URLS   comma-separated framework endpoints inbound
 *                           events are POSTed to (e.g. the Eve channel's
 *                           https://app.example.com/api/channels/whatsapp/event)
 *   WHATSAPP_SIDECAR_TOKEN  shared bearer token, both directions
 *   WHATSAPP_BASE_URL       this sidecar's public URL, used to build
 *                           absolute media URLs in events
 *   LOG_LEVEL               pino level (default info)
 *
 * First run prints a QR (or pairing code) — link it in WhatsApp → Linked
 * devices. Credentials persist in WHATSAPP_STORE_DIR, so restarts reconnect
 * silently.
 */
import { pathToFileURL } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createChannelAdapter } from "../channel/adapter.ts";
import type { ChannelEvent } from "../channel/types.ts";
import { createSession } from "../session.ts";
import { pairingAuth, qrAuth } from "../ports.ts";
import { fileStore } from "../stores/file.ts";
import { createSidecarServer, type SidecarServer } from "./server.ts";

export interface RunningSidecar {
  readonly port: number;
  readonly server: SidecarServer;
  close(): Promise<void>;
}

function pairingLogger(accountId: string, log: pino.Logger) {
  return (event: ChannelEvent): void => {
    if (event.type !== "status") return;
    const status = event.status;
    switch (status.phase) {
      case "pairing":
        if (status.pairing.step === "challenge_live") {
          if (status.pairing.qr) {
            log.info({ accountId }, "scan this QR in WhatsApp → Linked devices");
            qrcode.generate(status.pairing.qr, { small: true });
          } else if (status.pairing.code) {
            log.info({ accountId, code: status.pairing.code }, "enter this pairing code");
          }
        }
        break;
      case "online":
        log.info({ accountId }, "online — sendable");
        break;
      case "logged_out":
      case "suspended":
        log.error({ accountId, reason: status.reason }, `terminal: ${status.phase}`);
        break;
      default:
        log.debug({ accountId, phase: status.phase }, "status");
    }
  };
}

export async function runSidecar(env: NodeJS.ProcessEnv = process.env): Promise<RunningSidecar> {
  const accountId = env.WHATSAPP_ACCOUNT ?? "default";
  const storeDir = env.WHATSAPP_STORE_DIR ?? "./.wa-auth";
  const token = env.WHATSAPP_SIDECAR_TOKEN;
  const phone = env.WHATSAPP_PAIRING_PHONE;
  const forward = (env.WHATSAPP_FORWARD_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ url, token }));

  const logger = pino({
    level: env.LOG_LEVEL ?? "info",
    transport: { target: "pino-pretty", options: { colorize: true } },
  });

  const session = createSession({
    store: fileStore(storeDir),
    auth: phone ? pairingAuth(phone) : qrAuth(),
    logger,
  });
  const adapter = createChannelAdapter({ session, accountId, logger });

  // Subscribe before start() so the first pairing QR is not missed.
  adapter.subscribe({ onEvent: pairingLogger(accountId, logger) });
  const server = createSidecarServer({
    adapter,
    forward,
    token,
    baseUrl: env.WHATSAPP_BASE_URL,
    logger,
  });

  await adapter.start();
  const { port } = await server.listen(Number(env.PORT ?? 8788), env.HOST);
  logger.info({ port, accountId, forward: forward.map((f) => f.url) }, "sidecar up");

  return {
    port,
    server,
    async close(): Promise<void> {
      await server.close();
      await adapter.stop();
    },
  };
}

export { createSidecarServer } from "./server.ts";
export type { SidecarServer, SidecarServerOptions, ForwardTarget } from "./server.ts";
export * from "./wire.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSidecar().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
