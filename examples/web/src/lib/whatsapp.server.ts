import "server-only";

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
  type WhatsAppRuntime,
} from "whatsappd";
import {
  createWhatsAppApplication,
  type WhatsAppApplication,
  type WhatsAppApplicationCommand,
  type WhatsAppApplicationCommandResult,
  type WhatsAppApplicationView,
} from "@/lib/whatsapp-application";

type Worker = {
  readonly application: WhatsAppApplication;
  readonly runtime: WhatsAppRuntime;
  close(): Promise<void>;
};

declare global {
  var whatsappdExampleWorker: Promise<Worker> | undefined;
}

function requiredEnvironment(name: "WHATSAPPD_ACCOUNT_ID" | "WHATSAPPD_PROFILE_DIR"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the WhatsApp example`);
  return value;
}

async function sendAllowlist(): Promise<{
  readonly destinations: Set<string>;
  readonly groupPeers: ReadonlySet<string>;
}> {
  const path =
    process.env.WHATSAPPD_SEND_ALLOWLIST?.trim() ||
    join(homedir(), "Library", "Application Support", "whatsappd", "proofs", "send-allowlist.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(/* turbopackIgnore: true */ path, "utf8"));
    if (!parsed || typeof parsed !== "object")
      return { destinations: new Set(), groupPeers: new Set() };
    const value = parsed as {
      readonly chats?: unknown;
      readonly groups?: unknown;
      readonly groupPeers?: unknown;
    };
    const destinations = new Set(
      [
        ...(Array.isArray(value.chats) ? value.chats : []),
        ...(Array.isArray(value.groups) ? value.groups : []),
      ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    );
    const groupPeers = new Set(
      (Array.isArray(value.groupPeers) ? value.groupPeers : []).filter(
        (entry): entry is string =>
          typeof entry === "string" && /@(lid|s\.whatsapp\.net)$/.test(entry),
      ),
    );
    return { destinations, groupPeers };
  } catch {
    return { destinations: new Set(), groupPeers: new Set() };
  }
}

async function createWorker(): Promise<Worker> {
  const accountId = requiredEnvironment("WHATSAPPD_ACCOUNT_ID");
  const profile = resolve(requiredEnvironment("WHATSAPPD_PROFILE_DIR"));
  const { destinations: allowed, groupPeers } = await sendAllowlist();
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
      }),
  });
  const client = await createWhatsAppClient(runtime);
  const application = createWhatsAppApplication({
    accountId,
    client,
    media,
    canSend: (chatId) => allowed.has(chatId),
    canCreateGroupWith: (participantId) => groupPeers.has(participantId),
    onGroupCreated: (chatId) => allowed.add(chatId),
  });

  try {
    await runtime.start();
  } catch (error) {
    await application.close();
    await client.close();
    await backend.close();
    throw error;
  }

  return {
    application,
    runtime,
    async close() {
      await application.close();
      await client.close();
      await runtime.stop();
      await backend.close();
    },
  };
}

function worker(): Promise<Worker> {
  return (globalThis.whatsappdExampleWorker ??= createWorker());
}

export async function applicationState(chat?: string): Promise<WhatsAppApplicationView> {
  return (await worker()).application.state(chat);
}

export async function applicationCommand(
  command: WhatsAppApplicationCommand,
): Promise<WhatsAppApplicationCommandResult> {
  return (await worker()).application.command(command);
}

export async function subscribeApplication(listener: () => void): Promise<() => void> {
  return (await worker()).application.subscribe(listener);
}

export async function mediaTarget(token: string) {
  return (await worker()).application.media(token);
}

export async function avatarTarget(token: string): Promise<string | undefined> {
  return (await worker()).application.avatar(token);
}
