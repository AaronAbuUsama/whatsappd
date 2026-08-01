import type { BaileysEventMap } from "baileys";
import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import { toMessagesUpsertEvents } from "../src/baileys/socket.ts";
import { createSession } from "../src/session.ts";
import { pairingAuth, qrAuth } from "../src/ports.ts";
import { memoryStore } from "../src/stores/memory.ts";
import { baseMessage, SELF } from "./fixtures.ts";
import { textMessage } from "../src/testing.ts";

// createSession is inert until start() — it opens no socket — so the public
// subscription wiring and command guards can be exercised without a phone.
const make = (): ReturnType<typeof createSession> =>
  createSession({ store: memoryStore(), auth: qrAuth() });

test("subscribe accepts a handler subset and returns one cleanup function", () => {
  const s = make();
  const unsubscribe = s.subscribe({ message: () => {} });
  expect(typeof unsubscribe).toBe("function");
  unsubscribe();
  unsubscribe();
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

test("session failure precedence is subscriber, teardown, then run error", async () => {
  const bodies = ["ok", "run", "subscriber"] as const;
  const endings = ["ok", "error", "undefined"] as const;
  const supervisors = ["ok", "rejects"] as const;

  for (const body of bodies) {
    for (const ending of endings) {
      for (const supervisor of supervisors) {
        const runFailure = new Error(`run:${body}:${ending}:${supervisor}`);
        const subscriberFailure = new Error(`subscriber:${body}:${ending}:${supervisor}`);
        const supervisorFailure = new Error(`supervisor:${body}:${ending}:${supervisor}`);
        const teardownFailure =
          ending === "undefined" ? undefined : new Error(`end:${body}:${ending}:${supervisor}`);
        const fakeConn = {
          events: (async function* () {
            if (body === "ok") {
              yield {
                t: "close",
                fault: { reason: "intentional", retryable: false, disposition: "retryable" },
              } as const;
            } else if (body === "run") {
              yield { t: "qr", qr: "socket-ready" } as const;
            } else {
              yield {
                t: "message",
                msg: textMessage({
                  id: "m1",
                  chatId: "person@s.whatsapp.net",
                  text: "Hello",
                }),
              } as const;
            }
          })(),
          requestPairingCode: async () => {
            throw runFailure;
          },
          end: async () => {
            if (ending !== "ok") throw teardownFailure;
          },
        };
        const session = createSession({
          store: memoryStore(),
          auth: pairingAuth("+15551234567"),
          openSocket: async () => fakeConn,
        } as unknown as Parameters<typeof createSession>[0]);
        session.subscribe({
          ...(body === "subscriber"
            ? {
                message() {
                  throw subscriberFailure;
                },
              }
            : {}),
          ...(supervisor === "rejects"
            ? {
                connection(status) {
                  if (status.phase === "disconnected") throw supervisorFailure;
                },
              }
            : {}),
        });

        const outcome = await session.start().then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        const expected =
          supervisor === "rejects"
            ? supervisorFailure
            : body === "subscriber"
              ? subscriberFailure
              : ending !== "ok"
                ? teardownFailure
                : body === "run"
                  ? runFailure
                  : undefined;

        if (expected === undefined && body === "ok" && ending === "ok")
          expect(outcome.status).toBe("fulfilled");
        else {
          const label = `${body}/${ending}/${supervisor}`;
          assert.equal(outcome.status, "rejected", `${label} must reject`);
          if (outcome.status === "rejected") assert.equal(outcome.reason, expected, label);
        }
      }
    }
  }
});

test("a subscriber rejecting the initial connection transition stops before opening a socket", async () => {
  const failure = new Error("cannot record connecting");
  let opened = false;
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => {
      opened = true;
      throw new Error("socket must not open");
    },
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    connection(status) {
      if (status.phase === "connecting") throw failure;
    },
  });

  await assert.rejects(session.start(), failure);
  expect(opened).toBe(false);
  expect(session.status.phase).toBe("disconnected");
});

test("a rejected subscription handler fails the session pipeline", async () => {
  const failure = new Error("acceptance failed");
  let updateDelivered = false;
  let ended = false;
  const fakeConn = {
    events: (async function* () {
      yield {
        t: "message",
        msg: textMessage({
          id: "m1",
          chatId: "person@s.whatsapp.net",
          text: "Hello",
        }),
      } as const;
      yield {
        t: "update",
        update: {
          kind: "receipt",
          ref: { id: "m1", chatId: "person@s.whatsapp.net", fromMe: false },
          status: "read",
        },
      } as const;
    })(),
    end: () => {
      ended = true;
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);

  session.subscribe({
    message: () => {
      throw failure;
    },
    update: () => {
      updateDelivered = true;
    },
  });

  await assert.rejects(session.start(), failure);
  expect(updateDelivered).toBe(false);
  expect(ended).toBe(true);
});

test("timer transitions wait for message delivery and fail the session pipeline", async () => {
  const store = memoryStore();
  await store.write({
    creds: JSON.stringify({
      registered: true,
      me: { id: "15551234567:1@s.whatsapp.net" },
      accountSyncCounter: 1,
    }),
  });
  let markMessageStarted!: () => void;
  const messageStarted = new Promise<void>((resolve) => {
    markMessageStarted = resolve;
  });
  let releaseMessage!: () => void;
  const suspended = new Promise<void>((resolve) => {
    releaseMessage = resolve;
  });
  let onlineDelivered = false;
  let ended = false;
  const fakeConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      yield {
        t: "message",
        msg: textMessage({
          id: "m1",
          chatId: "person@s.whatsapp.net",
          text: "Hello",
        }),
      } as const;
      await new Promise<void>(() => {});
    })(),
    end: () => {
      ended = true;
    },
  };
  const session = createSession({
    store,
    auth: qrAuth(),
    syncGraceMs: 5,
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  const failure = new Error("online persistence failed");
  session.subscribe({
    message: async () => {
      markMessageStarted();
      await suspended;
    },
    connection(status) {
      if (status.phase === "online") {
        onlineDelivered = true;
        throw failure;
      }
    },
  });

  const started = session.start();
  await messageStarted;
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(onlineDelivered).toBe(false);
  releaseMessage();
  await assert.rejects(started, failure);
  expect(onlineDelivered).toBe(true);
  expect(ended).toBe(true);
});

test("requestHistory submits the anchored request and returns the correlation receipt", async () => {
  // ADR-0010: the on-demand backfill command is a per-chat protocol request
  // anchored at the oldest known message. Submission must yield a receipt whose
  // id a consumer can match against `conversationSync` batches carrying
  // `context.requestSessionId` — without one, returned history is uncorrelatable.
  const store = memoryStore();
  await store.write({
    creds: JSON.stringify({
      registered: true,
      me: { id: "15551234567:1@s.whatsapp.net" },
      accountSyncCounter: 1,
    }),
  });
  const requests: Array<{ count: number; ref: unknown; timestamp: number }> = [];
  let online!: () => void;
  const whenOnline = new Promise<void>((r) => (online = r));
  let emitClose!: () => void;
  const closed = new Promise<void>((r) => (emitClose = r));
  const fakeConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      await closed;
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    requestHistory: async (count: number, ref: unknown, timestamp: number) => {
      requests.push({ count, ref, timestamp });
      return "REQ-1";
    },
    end: () => {
      emitClose();
    },
  };
  const session = createSession({
    store,
    auth: qrAuth(),
    syncGraceMs: 1,
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    connection(status) {
      if (status.phase === "online") online();
    },
  });
  void session.start();
  await whenOnline;

  const anchor = {
    ref: { id: "OLDEST1", chatId: "person@s.whatsapp.net", fromMe: false },
    timestamp: 1_700_000_000_000,
  };
  const receipt = await session.requestHistory(anchor, { count: 25 });
  expect(receipt).toEqual({ requestId: "REQ-1" });
  expect(requests).toEqual([{ count: 25, ref: anchor.ref, timestamp: anchor.timestamp }]);

  await session.stop();
});

test("requestHistory rejects counts outside the protocol maximum", async () => {
  // ADR-0010: 50 is the validated Baileys request maximum. The guard runs
  // before the phase guard would matter — use an online session.
  const store = memoryStore();
  await store.write({
    creds: JSON.stringify({
      registered: true,
      me: { id: "15551234567:1@s.whatsapp.net" },
      accountSyncCounter: 1,
    }),
  });
  let online!: () => void;
  const whenOnline = new Promise<void>((r) => (online = r));
  let emitClose!: () => void;
  const closed = new Promise<void>((r) => (emitClose = r));
  const submitted: number[] = [];
  const fakeConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      await closed;
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    requestHistory: async (count: number) => {
      submitted.push(count);
      return "REQ-N";
    },
    end: () => {
      emitClose();
    },
  };
  const session = createSession({
    store,
    auth: qrAuth(),
    syncGraceMs: 1,
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    connection(status) {
      if (status.phase === "online") online();
    },
  });
  void session.start();
  await whenOnline;

  const anchor = {
    ref: { id: "OLDEST1", chatId: "person@s.whatsapp.net", fromMe: false },
    timestamp: 1_700_000_000_000,
  };
  for (const count of [0, -1, 51, 2.5]) {
    await assert.rejects(session.requestHistory(anchor, { count }), RangeError);
  }
  expect((await session.requestHistory(anchor, { count: 1 })).requestId).toBe("REQ-N");
  expect((await session.requestHistory(anchor, { count: 50 })).requestId).toBe("REQ-N");
  expect(submitted).toEqual([1, 50]);

  await session.stop();
});

test("requestHistory before online throws (guarded by phase)", async () => {
  const s = make();
  let threw = false;
  try {
    await s.requestHistory({
      ref: { id: "OLDEST1", chatId: "c@s.whatsapp.net", fromMe: false },
      timestamp: 1,
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("stop() during socket startup tears down the late-opened socket and awaits teardown", async () => {
  // stop() can land while openSocket() is still in flight — conn is undefined,
  // so stop()'s `conn?.end()` is a no-op. The supervisor must tear down the
  // socket that opens afterwards, and stop() must not resolve until it has.
  let onOpen!: () => void;
  const openCalled = new Promise<void>((r) => (onOpen = r));
  let releaseSocket!: (conn: unknown) => void;
  const socket = new Promise((r) => (releaseSocket = r));
  let ended = false;
  let endStarted!: () => void;
  const didStartEnd = new Promise<void>((resolve) => (endStarted = resolve));
  let releaseEnd!: () => void;
  const endBarrier = new Promise<void>((resolve) => (releaseEnd = resolve));

  const fakeConn = {
    end: async () => {
      ended = true;
      endStarted();
      await endBarrier;
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
  await didStartEnd;
  const stoppedBeforeEnd = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  expect(stoppedBeforeEnd).toBe(false);
  releaseEnd();

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
  expect(s.status.phase).toBe("disconnected");
});

test("a failed credential wipe is surfaced before logged_out is announced", async () => {
  const wipeFailure = new Error("credential wipe failed");
  const inner = memoryStore();
  const phases: string[] = [];
  const session = createSession({
    store: { ...inner, clear: async () => Promise.reject(wipeFailure) },
    auth: qrAuth(),
    openSocket: async () => ({
      events: (async function* () {
        yield {
          t: "close",
          fault: {
            reason: "logged_out_remote",
            retryable: false,
            disposition: "logged_out",
          },
        } as const;
      })(),
      end: () => {},
    }),
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    connection(status) {
      phases.push(status.phase);
    },
  });

  await assert.rejects(session.start(), (error: unknown) => error === wipeFailure);
  expect(phases.includes("logged_out")).toBe(false);
  expect(session.status.phase).toBe("disconnected");
});

test("a detached start owns its terminal rejection", async () => {
  const failure = new Error("acceptance failed");
  let ended!: () => void;
  const didEnd = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => ({
      events: (async function* () {
        yield {
          t: "message",
          msg: textMessage({ id: "m1", chatId: "person@s.whatsapp.net", text: "Hello" }),
        } as const;
      })(),
      end: ended,
    }),
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    message() {
      throw failure;
    },
  });

  let unhandled: unknown;
  const observe = (error: unknown): void => {
    unhandled = error;
  };
  process.once("unhandledRejection", observe);
  void session.start();
  await didEnd;
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", observe);

  expect(unhandled).toBe(undefined);
});

test("pairing-code session reaches online when the provider rejects requests before QR readiness", async () => {
  const store = memoryStore();
  let socketReady = false;
  let firstEndStarted!: () => void;
  const didStartFirstEnd = new Promise<void>((resolve) => (firstEndStarted = resolve));
  let releaseFirstEnd!: () => void;
  const firstEndBarrier = new Promise<void>((resolve) => (releaseFirstEnd = resolve));
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
    end: async () => {
      firstEndStarted();
      await firstEndBarrier;
    },
  };
  const returningConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      yield { t: "pending_drained" } as const;
      yield { t: "conversation_sync_complete" } as const;
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
  s.subscribe({
    connection(status) {
      if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
        proof.challengeCode = status.pairing.code ?? "";
      }
      if (status.phase === "online") proof.online = true;
      if (status.phase === "backing_off") {
        proof.backedOff = true;
        void s.stop();
      }
    },
  });

  const started = s.start();
  const firstEndObserved = await Promise.race([
    didStartFirstEnd.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  expect(firstEndObserved).toBe(true);
  expect(proof.openedSockets).toBe(1);
  releaseFirstEnd();
  await started;

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

test("credential teardown failure ends a scheduled retry before propagating", async () => {
  const failure = new Error("credential persistence failed");
  const phases: string[] = [];
  const fakeConn = {
    events: (async function* () {
      yield {
        t: "close",
        fault: { reason: "connection_lost", retryable: true, disposition: "retryable" },
      } as const;
    })(),
    end: async () => {
      throw failure;
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    connection(status) {
      phases.push(status.phase);
    },
  });

  await assert.rejects(session.start(), failure);
  expect(session.status.phase).toBe("disconnected");
  expect(phases.slice(-2)).toEqual(["backing_off", "disconnected"]);
});

test("a throwing subscriber wins over a rejecting teardown", async () => {
  // Both fail at once: the handler rejects the pipeline AND conn.end() rejects
  // during teardown. The session must still settle disconnected, and start()
  // must surface the handler's error — never mask it with the teardown error.
  const handlerFailure = new Error("acceptance failed");
  const teardownFailure = new Error("credential persistence failed");
  const fakeConn = {
    events: (async function* () {
      yield {
        t: "message",
        msg: textMessage({
          id: "m1",
          chatId: "person@s.whatsapp.net",
          text: "Hello",
        }),
      } as const;
    })(),
    end: async () => {
      throw teardownFailure;
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    message: () => {
      throw handlerFailure;
    },
  });

  await assert.rejects(session.start(), handlerFailure);
  expect(session.status.phase).toBe("disconnected");
});

test("stop() still awaits supervisor teardown when conn.end() rejects", async () => {
  // A failed credential drain makes conn.end() reject inside stop(). stop()
  // must still wait for the supervisor to wind down — never return (or throw)
  // while the session is live — and settle the machine at disconnected.
  const failure = new Error("credential persistence failed");
  let emitClose!: () => void;
  const closed = new Promise<void>((resolve) => (emitClose = resolve));
  let markConsuming!: () => void;
  const consuming = new Promise<void>((resolve) => (markConsuming = resolve));
  let supervisorSettled = false;
  const fakeConn = {
    events: (async function* () {
      markConsuming();
      await closed;
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    end: async () => {
      emitClose();
      throw failure;
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);

  const started = session.start().then(
    () => (supervisorSettled = true),
    () => (supervisorSettled = true),
  );
  await consuming; // the session is live and pumping events before we stop it
  await assert.rejects(session.stop(), failure);
  expect(supervisorSettled).toBe(true);
  expect(session.status.phase).toBe("disconnected");
  await started;
});

test("a teardown failure outranks an ordinary run error", async () => {
  // The run body fails (transport) AND conn.end() rejects. A `finally` cannot
  // override the in-flight exception, so without explicit precedence the
  // transport error escapes and the credential failure is silently lost.
  const runFailure = new Error("transport read failed");
  const teardownFailure = new Error("credential persistence failed");
  const fakeConn = {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw runFailure;
        },
      }),
    },
    end: async () => {
      throw teardownFailure;
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);

  await assert.rejects(session.start(), teardownFailure);
});

test("a handler rejecting the disconnected notification outranks the teardown error", async () => {
  // Clean run, then conn.end() rejects — and the connection handler rejects the
  // resulting `disconnected` notification too. Per ADR-0013 that rejection must
  // fail the pipeline, and the subscriber's error outranks the teardown error.
  const teardownFailure = new Error("credential persistence failed");
  const handlerFailure = new Error("disconnected persistence failed");
  const fakeConn = {
    events: (async function* () {})(), // a clean run: the stream simply ends
    end: async () => {
      throw teardownFailure;
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);
  session.subscribe({
    connection(status) {
      if (status.phase === "disconnected") throw handlerFailure;
    },
  });

  await assert.rejects(session.start(), handlerFailure);
});

test("a falsy teardown rejection still fails start() and stop()", async () => {
  // A store may reject with a falsy reason. Truthiness checks would swallow it
  // and let both start() and stop() resolve despite failed persistence, so the
  // rejection must propagate with its value intact.
  let settled: string | undefined;
  const fakeConn = {
    events: (async function* () {
      yield {
        t: "close",
        fault: { reason: "intentional", retryable: false, disposition: "retryable" },
      } as const;
    })(),
    end: async () => {
      throw undefined; // eslint-disable-line no-throw-literal -- the falsy case under test
    },
  };
  const session = createSession({
    store: memoryStore(),
    auth: qrAuth(),
    openSocket: async () => fakeConn,
  } as unknown as Parameters<typeof createSession>[0]);

  const started = session.start().then(
    () => (settled = "resolved"),
    (error: unknown) => (settled = error === undefined ? "rejected-undefined" : "rejected-other"),
  );
  await started;
  expect(settled).toBe("rejected-undefined");

  let stopSettled: string | undefined;
  await session.stop().then(
    () => (stopSettled = "resolved"),
    (error: unknown) =>
      (stopSettled = error === undefined ? "rejected-undefined" : "rejected-other"),
  );
  expect(stopSettled).toBe("rejected-undefined");
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
  s.subscribe({
    connection(status) {
      if (status.phase === "online") online = true;
    },
    conversationSync() {
      syncBatches++;
    },
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
  const liveEvents = toMessagesUpsertEvents(
    {
      type: "notify",
      messages: [
        baseMessage(
          {
            remoteJid: "15551234567@s.whatsapp.net",
            fromMe: true,
            id: "SELF1",
          },
          { conversation: "ping" },
        ),
      ],
    } as BaileysEventMap["messages.upsert"],
    SELF,
  );
  expect(liveEvents.length).toBe(1);
  expect(liveEvents[0]).toMatchObject({
    t: "message",
    msg: { fromMe: true, live: true, text: "ping", sender: { id: SELF.id } },
  });
  const fakeConn = {
    events: (async function* () {
      yield { t: "open" } as const;
      yield { t: "pending_drained" } as const;
      for (const event of liveEvents) yield event;
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
  s.subscribe({
    async message(message, { reply }) {
      observedFromMe = message.fromMe;
      if (message.kind === "text" && message.text.toLowerCase() === "ping") {
        await reply("pong");
      }
    },
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
