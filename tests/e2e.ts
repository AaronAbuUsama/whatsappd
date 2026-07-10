// fallow-ignore-file
/**
 * Real end-to-end harness — exercises every OUTBOUND type on the wire against a
 * live device, then self-drives the ref-based ops (quote/react/edit/delete)
 * using the MessageRef that `send()` returns: one command, real encryption,
 * real WhatsApp.
 *
 *   node --experimental-strip-types tests/e2e.ts <number>
 *     <number> = where to send the suite, e.g. your own number for loopback:
 *                node --experimental-strip-types tests/e2e.ts 15551234567
 *
 * Reuses ./.wa-auth (scan a QR once via `npm run proof` if empty). Watch the
 * target chat: you should see text, location, contact, image, a quoted reply,
 * a 👍 reaction appear, the text edit, and a message delete — in order.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createSession, fileStore, qrAuth, refOf } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const number = process.argv[2]?.replace(/[^0-9]/g, "");
if (!number) {
  console.error("usage: e2e.ts <number>   (digits only, e.g. your own number for loopback)");
  process.exit(1);
}
const to = `${number}@s.whatsapp.net`;

const session = createSession({
  store: fileStore(path.join(here, "..", ".wa-auth")),
  auth: qrAuth(),
  logger: pino({ level: process.env.LOG_LEVEL ?? "silent" }),
});

// A minimal valid JPEG (1×1) so the image test needs no network.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==",
  "base64",
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
  } catch (err) {
    console.log(`  ❌ ${label}: ${(err as Error).message}`);
  }
  await sleep(1500); // gentle pacing (anti-ban)
};

async function runSuite(): Promise<void> {
  console.log(`\n📤 sending outbound suite → ${to}\n`);

  let textRef = await session.send(to, { text: "e2e: text ✅" });
  console.log("  ✅ text");
  await sleep(1500);

  await step("location", () =>
    session.send(to, { location: { lat: 51.5074, lng: -0.1278, name: "London" } }),
  );
  await step("contacts", () =>
    session.send(to, {
      contacts: {
        displayName: "E2E Bot",
        vcards: ["BEGIN:VCARD\nVERSION:3.0\nFN:E2E Bot\nEND:VCARD"],
      },
    }),
  );
  await step("image (buffer)", () => session.send(to, { image: TINY_JPEG, caption: "e2e: image" }));
  await step("quote reply", () =>
    session.send(to, { text: "e2e: quoted reply ↩︎" }, { quote: textRef }),
  );
  await step("react 👍", () => session.send(to, { react: { to: textRef, emoji: "👍" } }));
  await step("edit", () =>
    session.send(to, { edit: { target: textRef, text: "e2e: text (edited) ✏️" } }),
  );

  const doomed = await session.send(to, { text: "e2e: delete me 🗑️" });
  await sleep(1500);
  await step("delete", () => session.send(to, { delete: doomed }));

  console.log("\n✅ suite sent — verify the chat shows each item in order.\n");
}

// Connection lifecycle.
void (async () => {
  for await (const ev of session.connection) {
    console.log(`· phase: ${ev.phase}${ev.phase === "authenticated" ? ` (${ev.sync.step})` : ""}`);
    switch (ev.phase) {
      case "pairing":
        if (ev.pairing.step === "challenge_live" && ev.pairing.qr) {
          console.log("\n📱 Scan in WhatsApp → Linked devices:\n");
          qrcode.generate(ev.pairing.qr, { small: true });
        }
        break;
      case "online":
        console.log("🟢 ONLINE");
        await runSuite();
        break;
      case "logged_out":
      case "suspended":
        console.log(`terminal: ${ev.phase} (${ev.reason})`);
        process.exit(1);
    }
  }
})();

// Inbound: echo what arrives, and exercise quote+react+markRead+typing on ping.
void (async () => {
  for await (const m of session.inbound) {
    if (!m.live) continue;
    const summary = m.kind === "text" ? m.text : `[${m.kind}]`;
    console.log(`📩 ${m.fromMe ? "(me)" : m.from}: ${summary}`);
    if (!m.fromMe && m.kind === "text" && m.text.trim().toLowerCase() === "ping") {
      await session.markRead([refOf(m)]); // blue ticks on the sender's side
      // Hold the typing indicator visibly. WhatsApp expires `composing` after a
      // few seconds, so refresh it across the window.
      for (let i = 0; i < 6; i++) {
        await session.setTyping(m.chatId, true);
        await sleep(1000);
      }
      await session.send(m.chatId, { text: "pong" }, { quote: refOf(m) });
      await session.setTyping(m.chatId, false);
      await session.send(m.chatId, { react: { to: refOf(m), emoji: "🏓" } });
      console.log(`  ↪︎ read + typed + replied + reacted to ping`);
    }
  }
})();

// Updates: receipts, reactions, edits, revokes on existing messages.
void (async () => {
  for await (const u of session.updates) {
    switch (u.kind) {
      case "receipt":
        console.log(`🧾 receipt ${u.status}${u.by ? ` by ${u.by}` : ""} → ${u.ref.id}`);
        break;
      case "reaction":
        console.log(
          `💟 reaction ${u.removed ? "(cleared)" : u.emoji}${u.by ? ` by ${u.by}` : ""} → ${u.ref.id}`,
        );
        break;
      case "edit":
        console.log(
          `✏️  edit → ${u.ref.id}: ${u.message.kind === "text" ? u.message.text : `[${u.message.kind}]`}`,
        );
        break;
      case "revoke":
        console.log(`🗑️  revoke${u.by ? ` by ${u.by}` : ""} → ${u.ref.id}`);
        break;
    }
  }
})();

process.on("SIGINT", () => void session.stop().then(() => process.exit(0)));
await session.start();
