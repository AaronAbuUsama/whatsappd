"use client";

import type {
  WhatsAppApplicationCommandResult,
  WhatsAppApplicationView,
  WhatsAppBrowser,
  WhatsAppBrowserSnapshot,
} from "@/lib/whatsappd/web-contract";

export type { WhatsAppBrowser, WhatsAppBrowserSnapshot } from "@/lib/whatsappd/web-contract";

export function createWhatsAppBrowser(initial: WhatsAppApplicationView): WhatsAppBrowser {
  const listeners = new Set<() => void>();
  let snapshot: WhatsAppBrowserSnapshot = { view: initial, pending: 0 };
  let source: EventSource | undefined;
  let refresh: Promise<void> | undefined;

  const announce = (): void => {
    for (const listener of listeners) listener();
  };
  const update = (next: Partial<WhatsAppBrowserSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    announce();
  };
  const reload = async (): Promise<void> => {
    if (refresh) return refresh;
    refresh = (async () => {
      const query = snapshot.selected ? `?chat=${encodeURIComponent(snapshot.selected)}` : "";
      const response = await fetch(`/api/state${query}`, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(errorFrom(body));
      update({ view: body as WhatsAppApplicationView, error: undefined });
    })()
      .catch((error) => update({ error: errorFrom(error) }))
      .finally(() => {
        refresh = undefined;
      });
    return refresh;
  };
  const run = async (
    request: () => Promise<Response>,
  ): Promise<WhatsAppApplicationCommandResult> => {
    update({ pending: snapshot.pending + 1, error: undefined });
    try {
      const response = await request();
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(errorFrom(body));
      await reload();
      return body as WhatsAppApplicationCommandResult;
    } catch (error) {
      const message = errorFrom(error);
      update({ error: message });
      throw new Error(message);
    } finally {
      update({ pending: Math.max(0, snapshot.pending - 1) });
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!source && typeof EventSource !== "undefined") {
        source = new EventSource("/api/events");
        source.addEventListener("change", () => void reload());
        source.addEventListener("ready", () => void reload());
        source.onerror = () => update({ error: "Live updates are reconnecting" });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          source?.close();
          source = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    async select(chat) {
      update({ selected: chat, error: undefined });
      await reload();
    },
    command: (command) =>
      run(() =>
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        }),
      ),
    sendMedia: (metadata, file) =>
      run(() =>
        fetch("/api/commands", {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Blob([JSON.stringify(metadata), "\n", file]),
        }),
      ),
    refresh: reload,
  };
}

function errorFrom(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string")
    return value.error;
  return "WhatsApp command failed";
}
