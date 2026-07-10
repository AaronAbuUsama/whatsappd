/**
 * Proof harness — connect a real WhatsApp device against the session surface.
 *
 *   QR login:            node --experimental-strip-types tests/proof.ts
 *   Pairing-code login:  node --experimental-strip-types tests/proof.ts +15551234567
 *
 * Scan the QR (or enter the printed code). On "🟢 ONLINE", message the device
 * "ping" from another phone and it replies "pong". Auth persists in ./.wa-auth.
 * LOG_LEVEL=debug to see the protocol trace.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createSession, fileStore, pairingAuth, qrAuth } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const authDir = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.join(here, "..", ".wa-auth");
const phone = process.argv[2];

const logger = pino({
  level: process.env.LOG_LEVEL ?? "warn",
  transport: { target: "pino-pretty", options: { colorize: true } },
});

const session = createSession({
  store: fileStore(authDir),
  auth: phone ? pairingAuth(phone) : qrAuth(),
  logger,
});

// Loop 1 — status transitions (the "status = events" stream).
void (async () => {
  for await (const ev of session.connection) {
    switch (ev.phase) {
      case "pairing": {
        const p = ev.pairing;
        if (p.step === "challenge_live" && p.qr) {
          console.log("\n📱 Scan in WhatsApp → Linked devices:\n");
          qrcode.generate(p.qr, { small: true });
        } else if (p.step === "challenge_live" && p.code) {
          console.log(`\n🔑 Enter this code on ${phone}: ${p.code}\n`);
        } else if (p.step === "restart_pending") {
          console.log("✅ paired — expect a 515 restart, then ONLINE…");
        }
        break;
      }
      case "authenticated":
        console.log(`… ${ev.sync.step}`);
        break;
      case "online":
        console.log("🟢 ONLINE — connected and synced");
        break;
      case "backing_off":
        console.log(
          `🔻 ${ev.reason} — retrying at ${new Date(ev.nextRetryAt).toLocaleTimeString()}`,
        );
        break;
      case "logged_out":
        console.log(`🚪 logged out (${ev.reason}) — .wa-auth wiped, re-pair.`);
        process.exit(1);
        break;
      case "suspended":
        console.log(`⛔ suspended (${ev.reason}) — account/device problem, re-pairing won't help.`);
        process.exit(1);
        break;
    }
  }
})();

// Loop 2 — inbound messages (the "messages = events" stream).
void (async () => {
  for await (const m of session.inbound) {
    if (m.fromMe || !m.live) continue;
    const desc = m.kind === "text" ? m.text : `[${m.kind}]`;
    console.log(`📩 ${m.from}: ${desc}`);
    if (m.kind === "text" && m.text.trim().toLowerCase() === "ping") {
      await session.send(m.chatId, { text: "pong" });
      console.log(`📤 replied "pong" to ${m.chatId}`);
    }
    // Live media check: pull bytes on demand and save to disk.
    if (
      m.kind === "image" ||
      m.kind === "video" ||
      m.kind === "audio" ||
      m.kind === "document" ||
      m.kind === "sticker"
    ) {
      try {
        const bytes = await m.media.download();
        const ext =
          (m.media.mimetype ?? "application/octet-stream").split("/")[1]?.split(";")[0] ?? "bin";
        const file = path.join(here, "..", `media-${m.id}.${ext}`);
        await writeFile(file, bytes);
        console.log(`💾 downloaded ${m.kind} (${bytes.length} bytes) → ${file}`);
      } catch (err) {
        console.error(`media download failed:`, err);
      }
    }
  }
})();

process.on("SIGINT", () => {
  console.log("\n…stopping");
  void session.stop().then(() => process.exit(0));
});

console.log(phone ? `Starting pairing-code login for ${phone}…` : "Starting QR login…");
await session.start();
