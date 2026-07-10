/**
 * One behavioural spec for the `SessionStore` port, run against every
 * implementation (memory / file / libsql). If a store passes this, it's a legal
 * credential backend — the session orchestrator can't tell them apart.
 *
 * `makeStore` must return a FRESH, isolated store on each call.
 */
import { expect, test } from "./_expect.ts";
import type { SessionStore } from "../src/ports.ts";

// A value that exercises the things real creds contain: braces, quotes, newlines,
// unicode — proving the store treats the blob as opaque bytes, not structured data.
const TRICKY = '{"k":"v","b":"AQID//8=","emoji":"🔐","nl":"a\nb"}';

export function conformsToStore(
  name: string,
  makeStore: () => SessionStore | Promise<SessionStore>,
): void {
  test(`[${name}] read of a missing key → null`, async () => {
    const store = await makeStore();
    expect(await store.read("creds")).toBe(null);
  });

  test(`[${name}] write then read round-trips an opaque blob`, async () => {
    const store = await makeStore();
    await store.write({ creds: TRICKY });
    expect(await store.read("creds")).toBe(TRICKY);
  });

  test(`[${name}] write overwrites an existing key`, async () => {
    const store = await makeStore();
    await store.write({ "pre-key:1": "a" });
    await store.write({ "pre-key:1": "b" });
    expect(await store.read("pre-key:1")).toBe("b");
  });

  test(`[${name}] a null value deletes the key`, async () => {
    const store = await makeStore();
    await store.write({ "session:x": "live" });
    await store.write({ "session:x": null });
    expect(await store.read("session:x")).toBe(null);
  });

  test(`[${name}] one write applies many entries atomically`, async () => {
    const store = await makeStore();
    await store.write({ creds: "C", "pre-key:1": "P1", "sender-key:g": "S" });
    expect(await store.read("creds")).toBe("C");
    expect(await store.read("pre-key:1")).toBe("P1");
    expect(await store.read("sender-key:g")).toBe("S");
  });

  test(`[${name}] mixed set + delete in a single write`, async () => {
    const store = await makeStore();
    await store.write({ a: "1", b: "2" });
    await store.write({ a: "1b", b: null, c: "3" });
    expect(await store.read("a")).toBe("1b");
    expect(await store.read("b")).toBe(null);
    expect(await store.read("c")).toBe("3");
  });

  test(`[${name}] an empty write is a no-op`, async () => {
    const store = await makeStore();
    await store.write({ a: "1" });
    await store.write({});
    expect(await store.read("a")).toBe("1");
  });

  test(`[${name}] clear wipes the whole session`, async () => {
    const store = await makeStore();
    await store.write({ creds: "C", "pre-key:1": "P1" });
    await store.clear();
    expect(await store.read("creds")).toBe(null);
    expect(await store.read("pre-key:1")).toBe(null);
  });

  test(`[${name}] usable again after clear`, async () => {
    const store = await makeStore();
    await store.write({ creds: "C" });
    await store.clear();
    await store.write({ creds: "C2" });
    expect(await store.read("creds")).toBe("C2");
  });
}
