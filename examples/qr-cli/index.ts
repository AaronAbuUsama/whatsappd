import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { createSession, fileStore, qrAuth } from "../../packages/whatsappd/src/index.ts";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), ".data");
const session = createSession({
  store: fileStore(directory),
  auth: qrAuth(),
  logger: pino({ level: "silent" }),
});

let onlineShown = false;
session.subscribe({
  connection(status) {
    if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
      if (!status.pairing.qr) return;
      console.log("\nScan in WhatsApp → Linked devices → Link a device:\n");
      qrcode.generate(status.pairing.qr, { small: true });
      return;
    }

    if (status.phase === "online" && !onlineShown) {
      console.log("\nConnected. Press Ctrl+C to close cleanly.");
      onlineShown = true;
      return;
    }

    if (status.phase === "logged_out" || status.phase === "suspended") {
      console.error(`The account entered terminal state: ${status.phase}.`);
      process.exitCode = 1;
      void session.stop();
    }
  },
});

const stop = (): void => {
  void session.stop().catch(() => {
    process.exitCode = 1;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.log(`Using ${path.relative(process.cwd(), directory) || directory}`);
try {
  await session.start();
} catch {
  process.exitCode = 1;
  console.error("The QR example stopped before the account came online.");
}
