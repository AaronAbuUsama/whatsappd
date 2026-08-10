import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import {
  createSession,
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
} from "whatsappd";
import {
  createTerminalApplication,
  type TerminalApplication,
} from "./components/whatsappd-tui/lib/whatsapp-terminal.ts";

export interface TerminalWorker {
  readonly application: TerminalApplication;
  close(): Promise<void>;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function sendAllowlist(): Promise<ReadonlySet<string>> {
  const path =
    process.env.WHATSAPPD_SEND_ALLOWLIST?.trim() ||
    join(homedir(), "Library", "Application Support", "whatsappd", "proofs", "send-allowlist.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return new Set();
    const value = parsed as { readonly chats?: unknown; readonly groups?: unknown };
    return new Set(
      [
        ...(Array.isArray(value.chats) ? value.chats : []),
        ...(Array.isArray(value.groups) ? value.groups : []),
      ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    );
  } catch {
    return new Set();
  }
}

export async function createTerminalWorker(): Promise<TerminalWorker> {
  const accountId = requiredEnvironment("WHATSAPPD_ACCOUNT_ID");
  const profile = resolve(requiredEnvironment("WHATSAPPD_PROFILE_DIR"));
  const allowed = await sendAllowlist();
  const media = fileMediaStore({ directory: profile });
  const backend = libsqlBackend({
    accountId,
    media,
    url: pathToFileURL(join(profile, "whatsapp.db")).href,
  });
  const runtime = createWhatsAppRuntime({
    accountId,
    backend,
    openSession: (credentials) =>
      createSession({
        store: credentials,
        auth: qrAuth(),
        logger: pino({ level: "silent" }),
        receiveStatusBroadcast: true,
      }),
  });
  const client = await createWhatsAppClient(runtime);
  const application = createTerminalApplication(client, {
    canSend: (chatId) => allowed.has(chatId),
  });

  try {
    await runtime.start();
  } catch (error) {
    application.close();
    await client.close();
    await backend.close();
    throw error;
  }

  return {
    application,
    async close() {
      application.close();
      await client.close();
      await runtime.stop();
      await backend.close();
    },
  };
}
