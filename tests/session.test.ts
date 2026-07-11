import { expect, test } from "./_expect.ts";
import { createSession } from "../src/session.ts";
import { qrAuth } from "../src/ports.ts";
import { memoryStore } from "../src/stores/memory.ts";

// createSession is inert until start() — it opens no socket — so the public
// registrar wiring and command guards can be exercised without a phone.
const make = (): ReturnType<typeof createSession> =>
  createSession({ store: memoryStore(), auth: qrAuth() });

test("every onX registrar returns an unsubscribe function", () => {
  const s = make();
  const unsubs = [
    s.onStatus(() => {}),
    s.onMessage(() => {}),
    s.onUpdate(() => {}),
    s.onConversationSync(() => {}),
    s.onContact(() => {}),
    s.onGroup(() => {}),
    s.onPresence(() => {}),
  ];
  for (const off of unsubs) {
    expect(typeof off).toBe("function");
    off(); // unsubscribing is safe to call
  }
});

test("send before online throws (guarded by phase)", async () => {
  const s = make();
  let threw = false;
  try {
    await s.send("c@s.whatsapp.net", { text: "x" });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("stop() during socket startup tears down the late-opened socket and awaits teardown", async () => {
  // Regression: the channel adapter now launches session.start() detached, so
  // stop() can land while openSocket() is still in flight — conn is undefined,
  // so stop()'s `conn?.end()` is a no-op. The supervisor must tear down the
  // socket that opens afterwards, and stop() must not resolve until it has.
  let onOpen!: () => void;
  const openCalled = new Promise<void>((r) => (onOpen = r));
  let releaseSocket!: (conn: unknown) => void;
  const socket = new Promise((r) => (releaseSocket = r));
  let ended = false;

  const fakeConn = {
    end: () => {
      ended = true;
    },
    events: (async function* () {})(), // never reached once the guard fires
  };

  const s = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    // test seam (see session.ts): drive the socket lifecycle by hand
    openSocket: () => {
      onOpen();
      return socket;
    },
  } as unknown as Parameters<typeof createSession>[0]);

  void s.start(); // detached, as the adapter now does
  await openCalled; // openSocket is in flight; conn is still undefined

  const stopped = s.stop(); // stop mid-startup
  releaseSocket(fakeConn); // ...and only now does openSocket resolve

  let timer: ReturnType<typeof setTimeout>;
  const outcome = await Promise.race([
    stopped.then(() => "stopped" as const),
    new Promise<"hung">((r) => {
      timer = setTimeout(() => r("hung"), 1000);
    }),
  ]);
  clearTimeout(timer!);

  expect(outcome).toBe("stopped"); // stop() resolved, didn't hang
  expect(ended).toBe(true); // the late-opened socket was torn down
});
