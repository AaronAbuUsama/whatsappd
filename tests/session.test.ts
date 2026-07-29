import { expect, test } from "./_expect.ts";
import { createSession } from "../src/session.ts";
import { pairingAuth, qrAuth } from "../src/ports.ts";
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

test("pairing-code session reaches online when the provider rejects requests before QR readiness", async () => {
  const store = memoryStore();
  let socketReady = false;
  const proof = {
    openedSockets: 0,
    requestedCodes: 0,
    requestedBeforeReady: false,
    requestedDigits: "",
    challengeCode: "",
    online: false,
    backedOff: false,
  };

  const firstConn = {
    events: (async function* () {
      yield { t: "connecting" } as const;
      socketReady = true;
      yield { t: "qr", qr: "socket-ready" } as const;
      yield { t: "paired" } as const;
      await store.write({
        creds: JSON.stringify({
          registered: true,
          me: { id: "15551234567:1@s.whatsapp.net" },
          accountSyncCounter: 1,
        }),
      });
      yield {
        t: "close",
        fault: { reason: "restart_required", retryable: true, disposition: "retryable" },
      } as const;
    })(),
    requestPairingCode: async (digits: string) => {
      proof.requestedCodes++;
      proof.requestedDigits = digits;
      if (!socketReady) {
        proof.requestedBeforeReady = true;
        throw Object.assign(new Error("Connection Closed"), { statusCode: 428 });
      }
      return "ABCD-1234";
    },
    end: () => {},
  };
  const returningConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      yield { t: "pending_drained" } as const;
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    requestPairingCode: async () => {
      throw new Error("returning socket must not request another pairing code");
    },
    end: () => {},
  };

  const s = createSession({
    store,
    auth: pairingAuth("+15551234567"),
    openSocket: async () => (++proof.openedSockets === 1 ? firstConn : returningConn),
  } as unknown as Parameters<typeof createSession>[0]);
  s.onStatus((status) => {
    if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
      proof.challengeCode = status.pairing.code ?? "";
    }
    if (status.phase === "online") proof.online = true;
    if (status.phase === "backing_off") {
      proof.backedOff = true;
      void s.stop();
    }
  });

  await s.start();

  expect(proof).toEqual({
    openedSockets: 2,
    requestedCodes: 1,
    requestedBeforeReady: false,
    requestedDigits: "15551234567",
    challengeCode: "ABCD-1234",
    online: true,
    backedOff: false,
  });
});

test("returning sessions reach online without conversation-sync batches", async () => {
  const store = memoryStore();
  await store.write({
    creds: JSON.stringify({
      registered: true,
      me: { id: "15551234567:1@s.whatsapp.net" },
      accountSyncCounter: 1,
    }),
  });

  let online = false;
  let syncBatches = 0;
  const fakeConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      yield { t: "pending_drained" } as const;
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    end: () => {},
  };

  const s = createSession({
    store,
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  s.onStatus((status) => {
    if (status.phase === "online") online = true;
  });
  s.onConversationSync(() => {
    syncBatches++;
  });

  await s.start();

  expect(online).toBe(true);
  expect(syncBatches).toBe(0);
});

test("live fromMe messages stay visible to consumers and can be replied to", async () => {
  const store = memoryStore();
  await store.write({
    creds: JSON.stringify({
      registered: true,
      me: { id: "15551234567:1@s.whatsapp.net" },
      accountSyncCounter: 1,
    }),
  });

  let releaseMessage!: () => void;
  const messageHandled = new Promise<void>((resolve) => (releaseMessage = resolve));
  const sent: unknown[] = [];
  const fakeConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      yield { t: "pending_drained" } as const;
      yield {
        t: "message",
        msg: {
          id: "SELF1",
          chatId: "15551234567@s.whatsapp.net",
          from: "15551234567@s.whatsapp.net",
          fromMe: true,
          timestamp: 1,
          live: true,
          isGroup: false,
          kind: "text",
          text: "ping",
        },
      } as const;
      await messageHandled;
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    send: async (...args: unknown[]) => {
      sent.push(args);
      releaseMessage();
      return {
        id: "PONG1",
        chatId: "15551234567@s.whatsapp.net",
        fromMe: true,
      };
    },
    end: () => {},
  };

  const s = createSession({
    store,
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  let observedFromMe = false;
  s.onMessage(async (message) => {
    observedFromMe = message.fromMe;
    if (message.kind === "text" && message.text.toLowerCase() === "ping") {
      await message.reply("pong");
    }
  });

  await s.start();

  expect(observedFromMe).toBe(true);
  expect(sent).toEqual([
    [
      "15551234567@s.whatsapp.net",
      { text: "pong" },
      {
        quote: {
          id: "SELF1",
          chatId: "15551234567@s.whatsapp.net",
          fromMe: true,
        },
      },
    ],
  ]);
});
