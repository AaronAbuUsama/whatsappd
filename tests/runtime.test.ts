/**
 * One text message through the whole product path: the deterministic session
 * drives the public runtime, and every assertion reads the public client or the
 * backend contracts. No harness, no fixtures, no sleeps.
 */
import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import {
  StaleAccountClaimError,
  UnsupportedDurableEventError,
  type WhatsAppBackend,
  type WhatsAppClient,
  type WhatsAppClientFrame,
  type WhatsAppDataEvent,
  type WhatsAppPatch,
  type WhatsAppSnapshot,
} from "../src/runtime/contracts.ts";
import {
  memoryBackend,
  memoryDataStore,
  memoryLeaseStore,
  memoryMediaStore,
} from "../src/runtime/memory.ts";
import {
  createInProcessWhatsAppClient,
  createWhatsAppRuntime,
  type WhatsAppRuntime,
} from "../src/runtime/runtime.ts";
import { memoryStore } from "../src/stores/memory.ts";
import { SubscriptionHandlerError } from "../src/subscription.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";

const PERSON = "person@s.whatsapp.net";
const ROOM = "room@g.us";
const SELF = "15551230000@s.whatsapp.net";
const AT = 1_700_000_000_000;

/** Let queued microtasks and one macrotask turn drain — never a timed wait. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One account worker: a deterministic session, a runtime, and its client. */
function lane(
  accountId: string,
  options: { backend?: WhatsAppBackend; freshnessMs?: number } = {},
): {
  driver: ReturnType<typeof createTestWhatsAppSession>;
  backend: WhatsAppBackend;
  runtime: WhatsAppRuntime;
  client: WhatsAppClient;
  opened: () => number;
} {
  const backend = options.backend ?? memoryBackend();
  const driver = createTestWhatsAppSession();
  let opened = 0;
  const runtime = createWhatsAppRuntime({
    accountId,
    backend,
    openSession: () => {
      opened += 1;
      return driver.session;
    },
    ...(options.freshnessMs !== undefined && { freshnessMs: options.freshnessMs }),
  });
  return {
    driver,
    backend,
    runtime,
    client: createInProcessWhatsAppClient(runtime),
    opened: () => opened,
  };
}

/** Drain a client watch in the background so frame arrival is observable. */
function watching(client: WhatsAppClient): {
  frames: WhatsAppClientFrame[];
  close(): Promise<void>;
} {
  const frames: WhatsAppClientFrame[] = [];
  const controller = new AbortController();
  const pump = (async () => {
    for await (const frame of client.watch({ signal: controller.signal })) frames.push(frame);
  })();
  return {
    frames,
    async close() {
      controller.abort();
      await pump;
    },
  };
}

const patchesOf = (frames: readonly WhatsAppClientFrame[]): WhatsAppPatch[] =>
  frames
    .filter(
      (frame): frame is Extract<WhatsAppClientFrame, { type: "patch" }> => frame.type === "patch",
    )
    .map((frame) => frame.patch);

const snapshotsOf = (frames: readonly WhatsAppClientFrame[]): WhatsAppSnapshot[] =>
  frames
    .filter(
      (frame): frame is Extract<WhatsAppClientFrame, { type: "snapshot" }> =>
        frame.type === "snapshot",
    )
    .map((frame) => frame.snapshot);

const hello = (id = "m1", text = "Hello"): ReturnType<typeof textMessage> =>
  textMessage({ id, chatId: PERSON, text, timestamp: AT });

test("one text message records the change, updates current state, and takes one revision", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  expect(snapshotsOf(seen.frames)).toEqual([
    { accountId: "personal", revision: 0, chats: [], messages: [] },
  ]);

  await driver.emit({ type: "message", message: hello() });
  await tick();

  expect(patchesOf(seen.frames)).toEqual([
    {
      accountId: "personal",
      fromRevision: 0,
      revision: 1,
      upserts: [
        {
          type: "message",
          message: {
            accountId: "personal",
            chatId: PERSON,
            messageId: "m1",
            sender: { id: PERSON, mode: "pn" },
            fromMe: false,
            timestamp: AT,
            kind: "text",
            text: "Hello",
          },
        },
        {
          type: "chat",
          chat: { accountId: "personal", chatId: PERSON, isGroup: false, lastMessageAt: AT },
        },
      ],
    },
  ]);

  const snapshot = await runtime.snapshot();
  expect(snapshot.revision).toBe(1);
  expect(snapshot.messages.length).toBe(1);
  expect(snapshot.chats).toEqual([
    { accountId: "personal", chatId: PERSON, isGroup: false, lastMessageAt: AT },
  ]);

  // The received WhatsApp change is recorded by the same acceptance that moved
  // the mirror to that revision.
  const accepted = await backend.data.accepted("personal", 0);
  expect(accepted.length).toBe(1);
  expect(accepted[0]).toMatchObject({
    accountId: "personal",
    seq: 1,
    fromRevision: 0,
    revision: 1,
    events: [{ event: { type: "message", message: { id: "m1" } } }],
  });

  await seen.close();
  await runtime.stop();
});

test("the client receives no update until acceptance commits", async () => {
  const data = memoryDataStore();
  let commit!: () => void;
  const held = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    data: {
      ...data,
      async accept(accountId, events, fencingToken) {
        await held;
        return data.accept(accountId, events, fencingToken);
      },
    },
  };

  const { driver, runtime, client } = lane("personal", { backend });
  await runtime.start();
  const seen = watching(client);
  await tick();

  const accepting = driver.emit({ type: "message", message: hello() });
  await tick();
  expect(patchesOf(seen.frames)).toEqual([]);
  expect((await runtime.snapshot()).revision).toBe(0);

  commit();
  await accepting;
  await tick();
  expect(patchesOf(seen.frames).length).toBe(1);

  await seen.close();
  await runtime.stop();
});

test("a fresh client reconstructs the same message state and revision", async () => {
  const { driver, backend, runtime } = lane("personal");
  await runtime.start();
  await driver.emit({ type: "message", message: hello() });
  const stored = await runtime.snapshot();
  expect(stored.revision).toBe(1);
  await runtime.stop();

  // A replacement worker for the same account: same backend, new runtime, new
  // client — the mirror and its revision come back unchanged.
  const replacement = lane("personal", { backend });
  await replacement.runtime.start();
  const seen = watching(replacement.client);
  await tick();

  expect(snapshotsOf(seen.frames)).toEqual([stored]);

  await seen.close();
  await replacement.runtime.stop();
});

test("replaying the same WhatsApp message creates no duplicate and no second update", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  await driver.emit({ type: "message", message: hello() });
  // The same message again, live and then through a history sync.
  await driver.emit({ type: "message", message: hello() });
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "recent", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [hello()],
    },
  });
  await tick();

  expect(patchesOf(seen.frames).length).toBe(1);
  const snapshot = await runtime.snapshot();
  expect(snapshot.revision).toBe(1);
  expect(snapshot.messages.length).toBe(1);

  // The replays still happened, so the source log keeps all three
  // observations; only the one that changed current state took a revision.
  const accepted = await backend.data.accepted("personal", 0);
  expect(accepted.map((batch) => [batch.seq, batch.fromRevision, batch.revision])).toEqual([
    [1, 0, 1],
    [2, 1, 1],
    [3, 1, 1],
  ]);
  expect(accepted.slice(1).flatMap((batch) => batch.patch.upserts)).toEqual([]);

  await seen.close();
  await runtime.stop();
});

test("the stored sender is the actual author, never the chat", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  await driver.emit({
    type: "message",
    message: textMessage({ id: "g1", chatId: ROOM, sender: PERSON, text: "In the room" }),
  });
  await driver.emit({
    type: "message",
    message: textMessage({ id: "o1", chatId: PERSON, sender: SELF, fromMe: true, text: "Mine" }),
  });

  const { messages } = await runtime.snapshot();
  expect(messages.map((message) => [message.messageId, message.sender.id, message.fromMe])).toEqual(
    [
      ["g1", PERSON, false],
      ["o1", SELF, true],
    ],
  );

  await runtime.stop();
});

test("a backend failure publishes nothing and stops processing with the original failure", async () => {
  const outage = new Error("storage unavailable");
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    data: { ...memoryDataStore(), accept: () => Promise.reject(outage) },
  };
  const { driver, runtime, client } = lane("personal", { backend });
  await runtime.start();
  const seen = watching(client);
  await tick();

  const isOutage = (error: unknown): boolean =>
    error instanceof SubscriptionHandlerError && error.cause === outage;

  await assert.rejects(driver.emit({ type: "message", message: hello() }), isOutage);
  // Not logged and skipped: the next event never gets processed either.
  await assert.rejects(driver.emit({ type: "message", message: hello("m2") }), isOutage);
  await tick();

  expect(patchesOf(seen.frames)).toEqual([]);

  await seen.close();
  await runtime.stop();
});

test("two accounts remain isolated in one backend", async () => {
  const data = memoryDataStore();
  const leases = memoryLeaseStore();
  const shared = (): WhatsAppBackend => ({
    credentials: memoryStore(),
    data,
    leases,
    media: memoryMediaStore(),
  });
  const alice = lane("alice", { backend: shared() });
  const bob = lane("bob", { backend: shared() });
  await alice.runtime.start();
  await bob.runtime.start();

  await alice.driver.emit({ type: "message", message: hello("m1", "For Alice") });
  expect((await bob.runtime.snapshot()).revision).toBe(0);
  expect((await bob.runtime.snapshot()).messages).toEqual([]);

  await bob.driver.emit({ type: "message", message: hello("m1", "For Bob") });
  expect(await alice.runtime.snapshot()).toMatchObject({
    accountId: "alice",
    revision: 1,
    messages: [{ accountId: "alice", text: "For Alice" }],
  });
  expect(await bob.runtime.snapshot()).toMatchObject({
    accountId: "bob",
    revision: 1,
    messages: [{ accountId: "bob", text: "For Bob" }],
  });
  // Chats are projected on their own path and are scoped by the same account.
  expect((await alice.runtime.snapshot()).chats).toMatchObject([{ accountId: "alice" }]);
  expect((await bob.runtime.snapshot()).chats).toMatchObject([{ accountId: "bob" }]);

  await alice.runtime.stop();
  await bob.runtime.stop();
});

test("a second runtime for the same account fails before opening WhatsApp", async () => {
  const backend = memoryBackend();
  const first = lane("personal", { backend });
  const second = lane("personal", { backend });
  await first.runtime.start();

  await assert.rejects(second.runtime.start(), { name: "AccountAlreadyClaimedError" });
  expect(second.opened()).toBe(0);
  expect(first.opened()).toBe(1);

  // The claim is the only thing in the way: releasing it lets the next worker in.
  await first.runtime.stop();
  await second.runtime.start();
  expect(second.opened()).toBe(1);
  await second.runtime.stop();
});

test("the account lease is a compare-and-swap claim with a fencing token", async () => {
  const leases = memoryLeaseStore();
  const first = await leases.acquire("personal", "worker-a", 30_000);
  assert.ok(first.acquired);
  expect((await leases.acquire("personal", "worker-b", 30_000)).acquired).toBe(false);
  expect((await leases.acquire("other", "worker-b", 30_000)).acquired).toBe(true);

  const renewed = await leases.renew(first.lease, 30_000);
  assert.ok(renewed.renewed);
  expect(renewed.lease.fencingToken).toBe(first.lease.fencingToken);
  expect(renewed.lease.expiresAt >= first.lease.expiresAt).toBe(true);

  expect(await leases.release(first.lease)).toBe(true);
  expect(await leases.renew(first.lease, 30_000)).toEqual({ renewed: false, reason: "lost" });

  const next = await leases.acquire("personal", "worker-b", 30_000);
  assert.ok(next.acquired);
  expect(next.lease.fencingToken > first.lease.fencingToken).toBe(true);
  // The previous holder can no longer touch the claim that replaced it.
  expect(await leases.release(first.lease)).toBe(false);
});

test("a superseded claim cannot write, however long its event was buffered", async () => {
  const data = memoryDataStore();
  const observation = (eventId: string): WhatsAppDataEvent => ({
    eventId,
    observedAt: AT,
    event: { type: "message", message: hello(eventId) },
  });

  // Worker B, holding the newer claim, writes first.
  await data.accept("personal", [observation("m2")], 2);
  // Worker A resumes on its old claim with an event it buffered before pausing.
  await assert.rejects(
    data.accept("personal", [observation("m1")], 1),
    (error: unknown) => error instanceof StaleAccountClaimError,
  );

  const snapshot = await data.snapshot("personal");
  expect(snapshot.revision).toBe(1);
  expect(snapshot.messages.map((message) => message.messageId)).toEqual(["m2"]);
  expect((await data.accepted("personal", 0)).length).toBe(1);
});

test("re-offering an accepted observation returns its batch instead of a second copy", async () => {
  const data = memoryDataStore();
  const observation: WhatsAppDataEvent = {
    eventId: "obs-1",
    observedAt: AT,
    event: { type: "message", message: hello() },
  };

  const first = await data.accept("personal", [observation], 1);
  // The retry a caller makes after an ambiguous backend result.
  expect(await data.accept("personal", [observation], 1)).toBe(first);
  expect((await data.accepted("personal", 0)).length).toBe(1);

  // A genuinely distinct observation of the same thing is still recorded, and
  // still moves nothing, because identity is the caller's, not the payload's.
  const again = await data.accept("personal", [{ ...observation, eventId: "obs-2" }], 1);
  expect([again.seq, again.fromRevision, again.revision]).toEqual([2, 1, 1]);
  expect((await data.snapshot("personal")).messages.length).toBe(1);
});

test("reconnecting with no new history preserves the existing current state", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();
  await driver.emit({ type: "message", message: hello() });
  const before = await runtime.snapshot();

  await driver.emit({ type: "connection", status: { phase: "online" } });
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", isLatest: true, projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [],
    },
  });
  await tick();

  expect(await runtime.snapshot()).toEqual(before);
  expect(patchesOf(seen.frames).length).toBe(1);
  // The empty sync is still a real observation and is recorded as one.
  const accepted = await backend.data.accepted("personal", 1);
  expect(accepted.map((batch) => [batch.seq, batch.revision])).toEqual([[2, 1]]);
  expect(accepted[0]?.events[0]?.event.type).toBe("conversation_sync");

  await seen.close();
  await runtime.stop();
});

test("unsupported durable events fail clearly instead of bypassing storage", async () => {
  const { driver, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();
  await driver.emit({ type: "message", message: hello() });
  const before = await runtime.snapshot();

  const isUnsupported = (error: unknown): boolean =>
    error instanceof SubscriptionHandlerError &&
    error.cause instanceof UnsupportedDurableEventError;

  await assert.rejects(
    driver.emit({
      type: "update",
      update: { kind: "receipt", ref: { id: "m1", chatId: PERSON, fromMe: false }, status: "read" },
    }),
    isUnsupported,
  );
  expect(await runtime.snapshot()).toEqual(before);
  expect(patchesOf(seen.frames).length).toBe(1);

  await seen.close();
  await runtime.stop();
});

test("a batch that hits an unsupported event stores none of it", async () => {
  const { driver, backend, runtime } = lane("personal");
  await runtime.start();

  await assert.rejects(
    driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "recent", projection: { mode: "upsert" } },
        chats: [{ id: PERSON, isGroup: false }],
        contacts: [{ id: PERSON, displayName: "Someone" }],
        messages: [hello()],
      },
    }),
    (error: unknown) =>
      error instanceof SubscriptionHandlerError &&
      error.cause instanceof UnsupportedDurableEventError,
  );

  expect(await runtime.snapshot()).toEqual({
    accountId: "personal",
    revision: 0,
    chats: [],
    messages: [],
  });
  // Rejected means nothing was accepted: the source log is untouched too.
  expect(await backend.data.accepted("personal", 0)).toEqual([]);

  await runtime.stop();
});

test("start returns while the session runs, and the session's end frees the account", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let endSession!: () => void;
  const supervising = new Promise<void>((resolve) => {
    endSession = resolve;
  });
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    // A live session's start() resolves only when the session ends.
    openSession: () => ({ ...driver.session, start: () => supervising }),
  });

  await runtime.start();
  await driver.emit({ type: "message", message: hello() });
  expect((await runtime.snapshot()).revision).toBe(1);
  // Still consuming, so the account is still claimed.
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(false);

  endSession();
  await supervising;
  await tick();

  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(true);
});

test("a stop while the session is opening leaves the account claimed by nobody", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let finishOpening!: () => void;
  const opening = new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: async () => {
      await opening;
      return driver.session;
    },
  });

  const starting = runtime.start();
  await tick();
  await runtime.stop();
  finishOpening();

  await assert.rejects(starting, /stopped while starting/);
  // Never subscribed, so WhatsApp is not being consumed without a claim.
  await driver.emit({ type: "message", message: hello() });
  expect((await runtime.snapshot()).revision).toBe(0);
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(true);
});

test("a terminal session failure is reported by stop, not swallowed", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const died = new Error("socket died");
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => ({ ...driver.session, start: () => Promise.reject(died) }),
  });

  await runtime.start();
  await tick();

  await assert.rejects(runtime.stop(), (error: unknown) => error === died);
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(true);
});

test("a client applies only contiguous patches and re-snapshots after a gap", async () => {
  let current: WhatsAppSnapshot = { accountId: "personal", revision: 0, chats: [], messages: [] };
  const listeners = new Set<(frame: WhatsAppClientFrame) => void>();
  const runtime: WhatsAppRuntime = {
    accountId: "personal",
    start: async () => {},
    stop: async () => {},
    snapshot: async () => current,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (fromRevision: number, revision: number): void => {
    for (const listener of listeners)
      listener({
        type: "patch",
        patch: { accountId: "personal", fromRevision, revision, upserts: [] },
      });
  };

  const seen = watching(createInProcessWhatsAppClient(runtime));
  await tick();
  publish(0, 1);
  await tick();
  publish(0, 1); // the same change repeated
  await tick();

  // Revision 2 never arrives, so revision 3 cannot be applied over the gap.
  current = { accountId: "personal", revision: 3, chats: [], messages: [] };
  publish(2, 3);
  await tick();

  expect(seen.frames.map((frame) => frame.type)).toEqual(["snapshot", "patch", "snapshot"]);
  expect(snapshotsOf(seen.frames).map((snapshot) => snapshot.revision)).toEqual([0, 3]);

  await seen.close();
});

test("connection and presence expire and never become stored truth", async () => {
  const { driver, runtime, client } = lane("personal", { freshnessMs: 5_000 });
  await runtime.start();
  const seen = watching(client);
  await tick();
  await driver.emit({ type: "message", message: hello() });

  await driver.emit({ type: "connection", status: { phase: "online" } });
  await driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
  await tick();

  const connection = seen.frames.find((frame) => frame.type === "connection");
  assert.ok(connection?.type === "connection");
  expect(connection.state.expiresAt - connection.state.observedAt).toBe(5_000);
  expect(connection.state.fencingToken > 0).toBe(true);

  const presence = seen.frames.find((frame) => frame.type === "presence");
  assert.ok(presence?.type === "presence");
  expect(presence.expiresAt > Date.now()).toBe(true);

  // Neither took a revision, and a fresh snapshot has nowhere to put them.
  const snapshot = await runtime.snapshot();
  expect(snapshot.revision).toBe(1);
  expect(Object.keys(snapshot).sort()).toEqual(["accountId", "chats", "messages", "revision"]);

  await seen.close();
  await runtime.stop();
});
