import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  type PairingOperation,
  type WhatsAppClient,
} from "../../src/index.ts";

// The fallback logger is intentionally ordinary and unredacted. This example
// prints only its own lifecycle messages and QR art.
process.env.WA_LOG_LEVEL = "silent";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), ".data");
const accountId = "qr-cli-example";
await mkdir(directory, { recursive: true, mode: 0o700 });

const media = fileMediaStore({ directory });
const backend = libsqlBackend({
  url: `file:${path.join(directory, "whatsapp.db")}`,
  accountId,
  media,
});
const runtime = createWhatsAppRuntime({ accountId, backend });

let client: WhatsAppClient | undefined;
let pairing: PairingOperation | undefined;
let qrShown = false;
let onlineShown = false;
let stopping = false;
let requestStop!: () => void;
const stopped = new Promise<void>((resolve) => {
  requestStop = resolve;
});
const stop = (): void => {
  stopping = true;
  requestStop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runtime.start();
  client = await createWhatsAppClient(runtime);
  console.log(`Using ${path.relative(process.cwd(), directory) || directory}`);

  while (!stopping) {
    const state = client.account.get();
    if (state.closed || state.error) throw new Error("the WhatsApp Client stopped");

    if (!pairing && state.link?.status === "needs_pairing") {
      pairing = await client.account.pair({ method: "qr" });
    }

    if (!qrShown && pairing && state.link?.status === "pairing" && state.link.challengeId) {
      const challenge = await pairing.consumeChallenge();
      if (challenge?.method === "qr") {
        console.log("\nScan in WhatsApp → Linked devices → Link a device:\n");
        qrcode.generate(challenge.value, { small: true });
        qrShown = true;
      }
    }

    if (!onlineShown && state.link?.status === "linked" && state.connection?.phase === "online") {
      console.log("\nConnected. Press Ctrl+C to close cleanly.");
      onlineShown = true;
    }

    await Promise.race([sleep(100), stopped]);
  }
} catch {
  process.exitCode = 1;
  console.error("The QR example stopped before the account came online.");
} finally {
  await client?.close().catch(() => {});
  await runtime.stop().catch(() => {});
  await backend.close().catch(() => {});
}
