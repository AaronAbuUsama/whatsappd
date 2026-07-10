/**
 * Builds a Baileys auth state (creds + signal key store) backed by the opaque
 * `SessionStore` KV port. This is the ONLY place that knows both Baileys' auth
 * shapes AND how they serialize — so no Baileys type ever crosses the port. A
 * direct re-implementation of `useMultiFileAuthState` over `read/write` instead
 * of files; values are BufferJSON strings, keys are `"creds"` / `"type:id"`.
 */
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type SignalKeyStore,
} from "baileys";
import type { SessionStore } from "../ports.ts";

/** Internal — never exported from the package surface. */
export interface BaileysAuth {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
  saveCreds: () => Promise<void>;
  registered: boolean;
  /** Baileys increments this after the first successful history/app-state sync. */
  initialSyncComplete: boolean;
}

const keyOf = (type: string, id: string): string => `${type}:${id}`;

export async function loadAuth(store: SessionStore): Promise<BaileysAuth> {
  const rawCreds = await store.read("creds");
  const creds: AuthenticationCreds = rawCreds
    ? JSON.parse(rawCreds, BufferJSON.reviver)
    : initAuthCreds();

  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const out: { [id: string]: unknown } = {};
      await Promise.all(
        ids.map(async (id) => {
          const raw = await store.read(keyOf(type, id));
          let value = raw ? JSON.parse(raw, BufferJSON.reviver) : null;
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[id] = value;
        }),
      );
      return out as never;
    },
    set: async (data) => {
      const entries: Record<string, string | null> = {};
      for (const type of Object.keys(data)) {
        const bucket = data[type as keyof typeof data];
        if (!bucket) continue;
        for (const id of Object.keys(bucket)) {
          const value = (bucket as Record<string, unknown>)[id];
          entries[keyOf(type, id)] = value ? JSON.stringify(value, BufferJSON.replacer) : null;
        }
      }
      await store.write(entries);
    },
  };

  return {
    creds,
    keys,
    saveCreds: () => store.write({ creds: JSON.stringify(creds, BufferJSON.replacer) }),
    registered: Boolean(creds.registered),
    initialSyncComplete: Number(creds.accountSyncCounter ?? 0) > 0,
  };
}
