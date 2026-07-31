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
  type AccountLeaseStore,
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
  options: { backend?: WhatsAppBackend; freshnessMs?: number; leaseTtlMs?: number } = {},
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
    ...(options.leaseTtlMs !== undefined && { leaseTtlMs: options.leaseTtlMs }),
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
  const observation = (id: string): WhatsAppDataEvent => ({
    observedAt: AT,
    event: { type: "message", message: hello(id) },
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

test("a replacement's claim fences the previous writer before it writes anything", async () => {
  const data = memoryDataStore();
  const observation = (id: string): WhatsAppDataEvent => ({
    observedAt: AT,
    event: { type: "message", message: hello(id) },
  });

  await data.accept("personal", [observation("m1")], 1);
  // The replacement announces its claim and has not written anything yet.
  await data.claim("personal", 2);

  await assert.rejects(
    data.accept("personal", [observation("m2")], 1),
    (error: unknown) => error instanceof StaleAccountClaimError,
  );
  await assert.rejects(
    data.claim("personal", 1),
    (error: unknown) => error instanceof StaleAccountClaimError,
  );
  expect((await data.snapshot("personal")).messages.map((m) => m.messageId)).toEqual(["m1"]);
});

test("a repeated observation is recorded but moves nothing", async () => {
  const data = memoryDataStore();
  const observation: WhatsAppDataEvent = {
    observedAt: AT,
    event: { type: "message", message: hello() },
  };

  const first = await data.accept("personal", [observation], 1);
  expect([first.seq, first.fromRevision, first.revision]).toEqual([1, 0, 1]);

  // The same thing observed again happened, so it is appended — but the mirror
  // already holds it, so no record changes and no revision is taken.
  const again = await data.accept("personal", [observation], 1);
  expect([again.seq, again.fromRevision, again.revision]).toEqual([2, 1, 1]);
  expect(again.patch.upserts).toEqual([]);
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

test("the store refuses an event it cannot project instead of dropping it", async () => {
  const data = memoryDataStore();

  await assert.rejects(
    data.accept(
      "personal",
      [
        {
          observedAt: AT,
          event: {
            type: "update",
            update: {
              kind: "receipt",
              ref: { id: "m1", chatId: PERSON, fromMe: false },
              status: "read",
            },
          },
        },
      ],
      1,
    ),
    UnsupportedDurableEventError,
  );

  // No caller can route an unprojectable event into the mirror by any path.
  expect((await data.snapshot("personal")).revision).toBe(0);
  expect(await data.accepted("personal", 0)).toEqual([]);
});

test("a batch that hits an unsupported event stores none of it", async () => {
  const data = memoryDataStore();

  await assert.rejects(
    data.accept(
      "personal",
      [
        {
          observedAt: AT,
          event: {
            type: "conversation_sync",
            batch: {
              context: { source: "recent", projection: { mode: "upsert" } },
              chats: [{ id: PERSON, isGroup: false }],
              contacts: [{ id: PERSON, displayName: "Someone" }],
              messages: [hello()],
            },
          },
        },
      ],
      1,
    ),
    UnsupportedDurableEventError,
  );

  expect(await data.snapshot("personal")).toEqual({
    accountId: "personal",
    revision: 0,
    chats: [],
    messages: [],
  });
  // Rejected means nothing was accepted: the source log is untouched too.
  expect(await data.accepted("personal", 0)).toEqual([]);
});

test("everything a live account delivers alongside a message keeps the runtime up", async () => {
  const { driver, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  // The bootstrap sync a real account opens with carries contacts, and the
  // traffic around a chat is mostly receipts, contact and group updates. None
  // of them projects in this slice; none of them may take the account down.
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", isLatest: true, projection: { mode: "upsert" } },
      chats: [{ id: PERSON, isGroup: false }],
      contacts: [{ id: PERSON, displayName: "Someone" }],
      messages: [hello()],
    },
  });
  await driver.emit({
    type: "update",
    update: { kind: "receipt", ref: { id: "m1", chatId: PERSON, fromMe: false }, status: "read" },
  });
  await driver.emit({
    type: "contact",
    contact: { id: PERSON, nativeIds: [PERSON], displayName: "Someone" },
  });
  await driver.emit({
    type: "group",
    group: { kind: "metadata", id: ROOM, subject: "The Room", at: AT },
  });
  await tick();

  // The message inside that sync was stored, and the account is still consumed.
  expect((await runtime.snapshot()).messages.map((message) => message.messageId)).toEqual(["m1"]);
  await driver.emit({ type: "message", message: hello("m2", "Still here") });
  await tick();
  expect((await runtime.snapshot()).messages.map((message) => message.messageId)).toEqual([
    "m1",
    "m2",
  ]);
  expect(seen.frames.some((frame) => frame.type === "closed")).toBe(false);

  await seen.close();
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

test("a stop while the claim is being announced never opens WhatsApp", async () => {
  const data = memoryDataStore();
  let finishClaiming!: () => void;
  const claiming = new Promise<void>((resolve) => {
    finishClaiming = resolve;
  });
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    data: {
      ...data,
      async claim(accountId, fencingToken) {
        await claiming;
        return data.claim(accountId, fencingToken);
      },
    },
  };
  let opened = 0;
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => {
      opened += 1;
      return createTestWhatsAppSession().session;
    },
  });

  const starting = runtime.start();
  await tick();
  await runtime.stop();
  finishClaiming();

  await assert.rejects(starting, /stopped while starting/);
  expect(opened).toBe(0);
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(true);
});

test("concurrent starts share one startup instead of racing for the account", async () => {
  const { runtime, opened } = lane("personal");

  const [first, second] = await Promise.allSettled([runtime.start(), runtime.start()]);

  expect(first.status).toBe("fulfilled");
  expect(second.status).toBe("fulfilled");
  expect(opened()).toBe(1);

  await runtime.stop();
});

test("a stop right after start cancels it instead of missing it", async () => {
  const { runtime, backend, opened } = lane("personal");

  const starting = runtime.start();
  await runtime.stop();

  await assert.rejects(starting, /stopped while starting/);
  expect(opened()).toBe(0);
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(true);
});

test("a write is refused once its claim has expired", async () => {
  const inner = memoryLeaseStore();
  const leases: AccountLeaseStore = {
    ...inner,
    async acquire(accountId, holderId, ttlMs) {
      const result = await inner.acquire(accountId, holderId, ttlMs);
      // The claim the runtime caches is already past its expiry, as it would be
      // for a worker whose loop stalled past the TTL.
      return result.acquired
        ? { acquired: true, lease: { ...result.lease, expiresAt: Date.now() - 1 } }
        : result;
    },
  };
  const { driver, runtime } = lane("personal", {
    backend: { ...memoryBackend(), leases },
  });
  await runtime.start();

  await assert.rejects(
    driver.emit({ type: "message", message: hello() }),
    (error: unknown) => error instanceof SubscriptionHandlerError && /expired/.test(error.message),
  );
  expect((await runtime.snapshot()).revision).toBe(0);
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

test("a session that dies on its own closes the watch with the failure", async () => {
  const driver = createTestWhatsAppSession();
  const died = new Error("socket died");
  let die!: (error: unknown) => void;
  const dying = new Promise<void>((_, reject) => {
    die = reject;
  });
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend: memoryBackend(),
    openSession: () => ({ ...driver.session, start: () => dying }),
  });

  await runtime.start();
  const seen = watching(createInProcessWhatsAppClient(runtime));
  await tick();

  die(died);
  await tick();

  // The watch ends rather than suspending for ever on an account nothing is
  // consuming any more.
  await seen.close();
  expect(seen.frames.at(-1)).toEqual({ type: "closed", error: died });
  await assert.rejects(runtime.stop(), (error: unknown) => error === died);
});

test("a deliberate stop closes the watch with no failure", async () => {
  const { runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  await runtime.stop();
  await seen.close();

  expect(seen.frames.at(-1)).toEqual({ type: "closed" });
});

test("losing the account lease stops the runtime without evicting its new holder", async () => {
  const inner = memoryLeaseStore();
  let released = 0;
  const leases: AccountLeaseStore = {
    ...inner,
    // The account has been taken over: this holder's claim is simply gone.
    renew: async () => ({ renewed: false, reason: "lost" }),
    release: async (lease) => {
      released += 1;
      return inner.release(lease);
    },
  };
  const { runtime, client } = lane("personal", {
    backend: { ...memoryBackend(), leases },
    leaseTtlMs: 2, // the heartbeat renews at half the TTL
  });

  await runtime.start();
  // The watch ending is the signal the runtime stopped — no timed wait.
  const frames: WhatsAppClientFrame[] = [];
  for await (const frame of client.watch()) frames.push(frame);

  expect(frames.at(-1)).toEqual({ type: "closed" });
  // A claim this runtime no longer holds belongs to whoever took the account
  // over, so releasing it would evict them.
  expect(released).toBe(0);
});

test("a stop during an automatic teardown joins it instead of racing it", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const died = new Error("socket died");
  let finishClosing!: () => void;
  const closing = new Promise<void>((resolve) => {
    finishClosing = resolve;
  });
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => ({
      ...driver.session,
      start: () => Promise.reject(died),
      stop: () => closing,
    }),
  });

  await runtime.start();
  await tick(); // the dead session's teardown is now in flight, waiting on stop()

  const stopping = assert.rejects(runtime.stop(), (error: unknown) => error === died);
  await tick();
  // The caller has not been told the runtime stopped while it still holds the
  // account.
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(false);

  finishClosing();
  await stopping;
  expect((await backend.leases.acquire("personal", "other", 1_000)).acquired).toBe(true);
});

test("aborting a watch during a hung snapshot read releases its subscription", async () => {
  const listeners = new Set<(frame: WhatsAppClientFrame) => void>();
  const runtime: WhatsAppRuntime = {
    accountId: "personal",
    start: async () => {},
    stop: async () => {},
    snapshot: () => new Promise<WhatsAppSnapshot>(() => {}), // never settles
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const controller = new AbortController();
  const pump = (async () => {
    for await (const _frame of createInProcessWhatsAppClient(runtime).watch({
      signal: controller.signal,
    }));
  })();

  await tick();
  expect(listeners.size).toBe(1);
  controller.abort();

  const finished = await Promise.race([
    pump.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  expect(finished).toBe(true);
  expect(listeners.size).toBe(0);
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
