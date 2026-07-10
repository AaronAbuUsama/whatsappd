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
