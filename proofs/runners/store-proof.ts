// fallow-ignore-file
/**
 * libsql store persistence proof. Proves a real session survives a full
 * stop/restart round-trip through the libsql store — the one thing the unit
 * conformance suite can't show.
 *
 *   node --experimental-strip-types proofs/runners/store-proof.ts
 *
 * Run 1 (cold db): scan the QR once → 🟢 ONLINE → it stops itself, then
 * IMMEDIATELY reconnects from the same libsql db. If the second connect reaches
 * 🟢 ONLINE *without ever printing a QR*, persistence round-tripped correctly.
 * Run it again later (warm db) and it should go straight to ONLINE twice.
 *
 * Uses its own db file (.wa-libsql.db) — independent of the fileStore .wa-auth.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createSession, qrAuth } from "../../packages/whatsappd/src/index.ts";
import { libsqlStore } from "../../packages/whatsappd/src/stores/libsql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const url = `file:${path.join(root, "proofs", "private", "store.db")}`;
const logger = pino({ level: process.env.LOG_LEVEL ?? "silent" });

async function connectOnce(label: string): Promise<"online" | "qr-shown"> {
  const session = createSession({
    store: libsqlStore({ url, account: "proof" }),
    auth: qrAuth(),
    logger,
  });
  let sawQr = false;
  let resolve!: (result: "online" | "qr-shown") => void;
  const done = new Promise<"online" | "qr-shown">((doneResolve) => {
    resolve = doneResolve;
  });
  session.subscribe({
    connection(ev) {
      if (ev.phase === "pairing" && ev.pairing.step === "challenge_live" && ev.pairing.qr) {
        sawQr = true;
        console.log(`\n📱 [${label}] Scan in WhatsApp → Linked devices:\n`);
        qrcode.generate(ev.pairing.qr, { small: true });
      }
      if (ev.phase === "authenticated") console.log(`  [${label}] … ${ev.sync.step}`);
      if (ev.phase === "online") {
        console.log(
          `🟢 [${label}] ONLINE${sawQr ? " (after QR)" : " (NO QR — loaded from libsql)"}`,
        );
        resolve(sawQr ? "qr-shown" : "online");
        void session.stop();
      }
      if (ev.phase === "logged_out" || ev.phase === "suspended") {
        console.log(`terminal: ${ev.phase} (${ev.reason})`);
        resolve("qr-shown");
      }
    },
  });

  await session.start();
  return done;
}

// Run 1 may show a QR (cold db). Run 2 must NOT — that's the proof.
await connectOnce("run-1");
console.log("\n— restarting from the SAME libsql db (expect NO QR) —\n");
const second = await connectOnce("run-2");

if (second === "online") {
  console.log("\n✅ PASS — reconnected from libsql with no QR. Real auth state round-tripped.\n");
  process.exit(0);
} else {
  console.log("\n❌ FAIL — second connect needed a QR; creds did not persist through libsql.\n");
  process.exit(1);
}
