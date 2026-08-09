/**
 * Links a real account into a durable proof profile, once, so that every later
 * real-account run resumes with nobody present.
 *
 *   pnpm proof:profile client-read
 *   pnpm proof:profile lifecycle
 *
 * The first run prints a QR. Scan it in WhatsApp → Linked devices. Every run
 * after that resumes from the credentials in the profile's own database and
 * exits without asking for anything, which is the property being established:
 * `libsqlBackend()` persists credentials and `createWhatsAppRuntime` hands that
 * store to the session (`src/runtime/runtime.ts:714`), so a profile that keeps
 * its database file keeps its link.
 *
 * That matters because a P4 receipt is bound to an exact head, so any code
 * change forces a rerun. If a rerun meant a rescan, the proof would cost a
 * human per commit and would stop being run. See "A linked test account is a
 * one-time human cost" in `docs/standing-decisions.md`, and #127.
 *
 * Everything lives under the gitignored `proofs/private/<profile>/`. Nothing
 * here prints or stores a phone number, JID, message body or credential — the
 * summary is counts only.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import {
  createSession,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  createWhatsAppRuntime,
  type CredentialStore,
} from "../../packages/whatsappd/src/index.ts";
// The friendly Client is not a root export until #107 cuts the public surface.
import { createWhatsAppClient } from "../../packages/whatsappd/src/runtime/client.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const profile = process.argv.slice(2).find((arg) => arg !== "--") ?? "client-read";
const directory = path.join(root, "proofs", "private", profile);

/** How long to wait for a link before giving up, with and without a human. */
const RESUME_TIMEOUT_MS = 90_000;
const SCAN_TIMEOUT_MS = 300_000;
/** How long the mirror must stop growing before the account counts as settled. */
const QUIET_MS = 5_000;
const SETTLE_TIMEOUT_MS = 180_000;

const logger = pino({
  level: process.env.LOG_LEVEL ?? "warn",
  transport: { target: "pino-pretty", options: { colorize: true } },
});

mkdirSync(directory, { recursive: true, mode: 0o700 });

const media = fileMediaStore({ directory });
const backend = libsqlBackend({
  url: `file:${path.join(directory, "whatsapp.db")}`,
  accountId: profile,
  media,
});

/**
 * Set when a challenge is displayed, which is also how this run knows whether
 * it paired or resumed. Asking the credential store would answer a different
 * question: a stored credential that WhatsApp has since revoked still reads as
 * present, and the run that has to re-scan is the one that matters here.
 */
let scanned = false;

const runtime = createWhatsAppRuntime({
  accountId: profile,
  backend,
  openSession(credentials: CredentialStore) {
    const session = createSession({ store: credentials, auth: qrAuth(), logger });
    // A throwing subscriber becomes a session failure (ADR-0021), so this one
    // only ever prints.
    session.subscribe({
      connection(status) {
        if (status.phase !== "pairing") return;
        const { pairing } = status;
        if (pairing.step === "challenge_live" && pairing.qr) {
          scanned = true;
          console.log("\n📱 Scan in WhatsApp → Linked devices:\n");
          qrcode.generate(pairing.qr, { small: true });
        } else if (pairing.step === "restart_pending") {
          console.log("✅ paired — expect a 515 restart, then ONLINE…");
        }
      },
    });
    return session;
  },
});

const started = Date.now();
await runtime.start();
const client = await createWhatsAppClient(runtime);

/** Resolves once `read()` returns a value, or rejects at the deadline. */
function until<T>(read: () => T | undefined, deadline: () => number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (): boolean => {
      const value = read();
      if (value === undefined) return false;
      cleanup();
      resolve(value);
      return true;
    };
    const timer = setInterval(() => {
      if (settle()) return;
      if (Date.now() > deadline()) {
        cleanup();
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 250);
    const offAccount = client.account.subscribe(() => void settle());
    const offChats = client.chats.subscribe(() => void settle());
    const cleanup = (): void => {
      clearInterval(timer);
      offAccount();
      offChats();
    };
    settle();
  });
}

try {
  await until(
    () => (client.account.get().connection?.phase === "online" ? true : undefined),
    () => started + (scanned ? SCAN_TIMEOUT_MS : RESUME_TIMEOUT_MS),
    "the account to come online",
  );
  console.log(`🟢 ONLINE — ${scanned ? "paired" : "resumed"} in ${Date.now() - started}ms`);

  // Initial sync arrives in batches; the account is settled when it stops.
  let lastChange = Date.now();
  let seen = -1;
  await until(
    () => {
      const chats = client.chats.list().length;
      if (chats !== seen) {
        seen = chats;
        lastChange = Date.now();
      }
      return Date.now() - lastChange > QUIET_MS ? true : undefined;
    },
    () => started + SETTLE_TIMEOUT_MS,
    "the mirror to settle",
  );

  console.log(
    `📦 ${profile}: ${client.chats.list().length} chats, ` +
      `${client.contacts.list().length} contacts, ${client.groups.list().length} groups`,
  );
  console.log(`   ${path.relative(root, directory)} — rerun to resume, no scan.`);
} finally {
  // Application-owned order: Client, then Runtime, then Backend.
  await client.close();
  await runtime.stop();
  await backend.close();
}
