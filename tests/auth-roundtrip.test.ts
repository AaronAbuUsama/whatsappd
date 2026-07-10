/**
 * Integration: the real credential-serialization path over each store. This is
 * the no-phone half of the store proof — it exercises exactly what a live
 * reconnect relies on (encoded creds + signal keys surviving a write → read
 * round-trip with byte-identical Buffers), without a WhatsApp connection. The
 * live half (actually reconnecting from the store) is `npm run store-proof`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./_expect.ts";
import { loadAuth } from "../src/baileys/authState.ts";
import type { SessionStore } from "../src/ports.ts";
import { memoryStore } from "../src/stores/memory.ts";
import { fileStore } from "../src/stores/file.ts";
import { libsqlStore } from "../src/stores/libsql.ts";

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

function roundTrips(name: string, makeStore: () => SessionStore): void {
  test(`[${name}] fresh store → unregistered creds`, async () => {
    const auth = await loadAuth(makeStore());
    expect(auth.registered).toBe(false);
  });

  test(`[${name}] creds survive saveCreds → reload, Buffers byte-identical`, async () => {
    const store = makeStore();
    const a = await loadAuth(store);
    // initAuthCreds() seeds real Buffers (noiseKey, signedIdentityKey, …).
    a.creds.registered = true;
    a.creds.me = { id: "1234567890:1@s.whatsapp.net", name: "Test" };
    await a.saveCreds();

    const b = await loadAuth(store);
    expect(b.registered).toBe(true);
    expect(b.creds.me?.id).toBe("1234567890:1@s.whatsapp.net");
    // The Buffer that matters most for a real reconnect:
    expect(b64(b.creds.noiseKey.private)).toBe(b64(a.creds.noiseKey.private));
    expect(b64(b.creds.signedIdentityKey.private)).toBe(b64(a.creds.signedIdentityKey.private));
  });

  test(`[${name}] signal keys set → get round-trips a Buffer value`, async () => {
    const store = makeStore();
    const { keys } = await loadAuth(store);
    const secret = Buffer.from([1, 2, 3, 250, 251, 255]);
    await keys.set({ "pre-key": { "7": { public: secret, private: secret } as never } });
    const got = await keys.get("pre-key", ["7"]);
    expect(b64((got["7"] as { public: Uint8Array }).public)).toBe(b64(secret));
  });

  test(`[${name}] signal key set to null deletes it`, async () => {
    const store = makeStore();
    const { keys } = await loadAuth(store);
    await keys.set({ "pre-key": { "9": { public: Buffer.from([9]) } as never } });
    await keys.set({ "pre-key": { "9": null as never } });
    const got = await keys.get("pre-key", ["9"]);
    expect(got["9"]).toBe(null);
  });
}

roundTrips("memory", () => memoryStore());
roundTrips("file", () => fileStore(mkdtempSync(join(tmpdir(), "wa-auth-"))));
roundTrips("libsql", () => libsqlStore({ url: ":memory:" }));
