import { expect, test } from "./_expect.ts";
import { loadAuth } from "../src/baileys/authState.ts";
import type { SessionStore } from "../src/ports.ts";

/** In-memory KV store — the smallest possible SessionStore. */
function memStore(): SessionStore & { dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return {
    read: (key) => Promise.resolve(m.get(key) ?? null),
    write: async (entries) => {
      for (const [k, v] of Object.entries(entries)) {
        if (v === null) m.delete(k);
        else m.set(k, v);
      }
    },
    clear: async () => m.clear(),
    dump: () => Object.fromEntries(m),
  };
}

test("fresh store yields unregistered creds with a registrationId", async () => {
  const auth = await loadAuth(memStore());
  expect(auth.registered).toBe(false);
  expect(typeof auth.creds.registrationId).toBe("number");
});

test("saveCreds persists, and a reload restores the same identity (no Baileys types cross the port)", async () => {
  const store = memStore();
  const a = await loadAuth(store);
  await a.saveCreds();
  // the persisted value is an opaque string under "creds"
  expect(typeof store.dump().creds).toBe("string");

  const b = await loadAuth(store);
  expect(b.creds.registrationId).toBe(a.creds.registrationId);
});

test("signal keys round-trip through the opaque KV store", async () => {
  const store = memStore();
  const a = await loadAuth(store);
  await a.keys.set({
    "pre-key": { "7": { public: new Uint8Array([1, 2, 3]), private: new Uint8Array([4, 5, 6]) } },
  });

  // stored under a namespaced key, as a string
  expect(typeof store.dump()["pre-key:7"]).toBe("string");

  const b = await loadAuth(store);
  const got = await b.keys.get("pre-key", ["7"]);
  expect(Array.from(got["7"]!.public)).toEqual([1, 2, 3]);
});

test("clear wipes the session", async () => {
  const store = memStore();
  const a = await loadAuth(store);
  await a.saveCreds();
  await store.clear();
  expect(store.dump()).toEqual({});
});
