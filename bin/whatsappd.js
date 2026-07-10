#!/usr/bin/env node
/**
 * whatsappd — the WhatsApp daemon CLI.
 *
 * Runs one WhatsApp account session behind an HTTP surface, configured entirely
 * through environment variables (see `whatsappd/sidecar` for the full list).
 * First run prints a QR (or pairing code) to link the device.
 *
 *   WHATSAPP_FORWARD_URLS=https://my-app.example/api/channels/whatsapp/event \
 *   WHATSAPP_SIDECAR_TOKEN=secret \
 *   npx whatsappd
 */
import { runSidecar } from "../dist/sidecar/index.mjs";

runSidecar().catch((err) => {
  console.error(err);
  process.exit(1);
});
