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
  type StoredMessageCursor,
  type StoredMessagePage,
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

/** The Snapshot Window of an account nothing has been observed for yet. */
const empty = (accountId: string): WhatsAppSnapshot => ({
  accountId,
  revision: 0,
  account: { accountId },
  chats: [],
  contacts: [],
  groups: [],
});

/** Every stored message id in one chat, newest first, by following the cursor. */
async function pagedIds(
  reader: Pick<WhatsAppClient, "messages">,
  chatId: string,
  limit: number,
  from?: StoredMessageCursor,
): Promise<string[]> {
  const ids: string[] = [];
  let before = from;
  for (;;) {
    const page: StoredMessagePage = await reader.messages(chatId, {
      limit,
      ...(before && { before }),
    });
    ids.push(...page.messages.map((message) => message.messageId));
    if (!page.nextBefore) return ids;
    before = page.nextBefore;
  }
}

test("one text message records the change, updates current state, and takes one revision", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  expect(snapshotsOf(seen.frames)).toEqual([empty("personal")]);

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
  expect(snapshot.chats).toEqual([
    { accountId: "personal", chatId: PERSON, isGroup: false, lastMessageAt: AT },
  ]);
  // The message itself is read as a Stored Message Page, not carried by the
  // snapshot — see the paging tests below.
  expect((await runtime.messages(PERSON)).messages.length).toBe(1);

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
  expect((await runtime.snapshot()).revision).toBe(1);
  expect((await runtime.messages(PERSON)).messages.length).toBe(1);

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

  const stored = [
    ...(await runtime.messages(ROOM)).messages,
    ...(await runtime.messages(PERSON)).messages,
  ];
  expect(stored.map((message) => [message.messageId, message.sender.id, message.fromMe])).toEqual([
    ["g1", PERSON, false],
    ["o1", SELF, true],
  ]);

  await runtime.stop();
});

test("a backend failure publishes nothing and stops processing with the original failure", async () => {
  const outage = new Error("storage unavailable");
  const data = memoryDataStore();
  // Fails once, then works: a store that failed for ever could not tell "stopped
  // processing" apart from "processed and failed again".
  let accepts = 0;
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    data: {
      ...data,
      accept: (accountId, events, fencingToken) => {
        accepts += 1;
        return accepts === 1
          ? Promise.reject(outage)
          : data.accept(accountId, events, fencingToken);
      },
    },
  };
  const { driver, runtime, client } = lane("personal", { backend });
  await runtime.start();
  const seen = watching(client);
  await tick();

  const isOutage = (error: unknown): boolean =>
    error instanceof SubscriptionHandlerError && error.cause === outage;

  await assert.rejects(driver.emit({ type: "message", message: hello() }), isOutage);
  await tick();

  // Not logged and skipped: the runtime is down, and the next event never
  // reaches the store even though the store would now accept it.
  await assert.rejects(driver.emit({ type: "message", message: hello("m2") }), isOutage);
  await tick();
  expect(accepts).toBe(1);

  expect(patchesOf(seen.frames)).toEqual([]);
  // A watcher learns the runtime died, and learns it from the original failure
  // rather than waiting for ever on an update that cannot come.
  const last = seen.frames.at(-1);
  expect(last?.type).toBe("closed");
  expect(last?.type === "closed" && isOutage(last.error)).toBe(true);

  await seen.close();
  // Reported once, to whoever stops it.
  await assert.rejects(runtime.stop(), isOutage);
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
  // The same chat id in the same store: a page is scoped by the account it was
  // asked for, never by the chat alone.
  expect((await bob.runtime.messages(PERSON)).messages).toEqual([]);

  await bob.driver.emit({ type: "message", message: hello("m1", "For Bob") });
  expect((await alice.runtime.messages(PERSON)).messages).toMatchObject([
    { accountId: "alice", text: "For Alice" },
  ]);
  expect((await bob.runtime.messages(PERSON)).messages).toMatchObject([
    { accountId: "bob", text: "For Bob" },
  ]);
  expect((await alice.runtime.snapshot()).revision).toBe(1);
  expect((await bob.runtime.snapshot()).revision).toBe(1);
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

  expect((await data.snapshot("personal")).revision).toBe(1);
  expect((await data.messages("personal", PERSON)).messages.map((m) => m.messageId)).toEqual([
    "m2",
  ]);
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
  expect((await data.messages("personal", PERSON)).messages.map((m) => m.messageId)).toEqual([
    "m1",
  ]);
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
  expect((await data.messages("personal", PERSON)).messages.length).toBe(1);
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

  // Reconnecting moved only when this account was last connected. Nothing it
  // already knew about the conversation changed.
  const after = await runtime.snapshot();
  expect({ ...after, account: before.account, revision: before.revision }).toEqual(before);
  expect(typeof after.account.lastConnectedAt).toBe("number");
  expect((await runtime.messages(PERSON)).messages.length).toBe(1);
  // The empty sync is still a real observation and is recorded as one, and it
  // is the one that changed nothing.
  const accepted = await backend.data.accepted("personal", 1);
  expect(
    accepted.map((batch) => [batch.events[0]?.event.type, batch.fromRevision === batch.revision]),
  ).toEqual([
    ["account_connection", false],
    ["conversation_sync", true],
  ]);

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
        // Projects cleanly on its own; it must still leave nothing behind when
        // the event after it is refused.
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

  expect(await data.snapshot("personal")).toEqual(empty("personal"));
  expect((await data.messages("personal", PERSON)).messages).toEqual([]);
  // Rejected means nothing was accepted: the source log is untouched too.
  expect(await data.accepted("personal", 0)).toEqual([]);
});

test("everything a live account delivers alongside a message keeps the runtime up", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  // The bootstrap sync a real account opens with, then the traffic around a
  // chat: receipts, contact and group updates. A receipt still has no
  // projection in this slice; none of them may take the account down.
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
    contact: { id: PERSON, nativeIds: [PERSON, "55555@lid"], profileName: "Someone Else" },
  });
  await driver.emit({
    type: "group",
    group: { kind: "metadata", id: ROOM, subject: "The Room", at: AT },
  });
  await tick();

  // The message inside that sync was stored, and the account is still consumed.
  expect((await runtime.messages(PERSON)).messages.map((m) => m.messageId)).toEqual(["m1"]);
  const snapshot = await runtime.snapshot();
  // The sync's contact and the later contact event are one record: the update
  // adds what it knows without blanking the display name the sync established.
  expect(snapshot.contacts).toEqual([
    {
      accountId: "personal",
      contactId: PERSON,
      nativeIds: [PERSON, "55555@lid"],
      displayName: "Someone",
      profileName: "Someone Else",
    },
  ]);
  expect(snapshot.groups).toEqual([
    { accountId: "personal", groupId: ROOM, subject: "The Room", participants: [] },
  ]);
  // The receipt is still observed by nobody and projects nowhere: it is not in
  // the source log, and the store would refuse it if a caller offered one.
  const accepted = await backend.data.accepted("personal", 0);
  expect(accepted.map((batch) => batch.events[0]?.event.type)).toEqual([
    "conversation_sync",
    "contact",
    "group",
  ]);

  await driver.emit({ type: "message", message: hello("m2", "Still here") });
  await tick();
  expect((await runtime.messages(PERSON)).messages.map((m) => m.messageId)).toEqual(["m2", "m1"]);
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
    messages: () => Promise.reject(new Error("not read by this test")),
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
  let current: WhatsAppSnapshot = empty("personal");
  const listeners = new Set<(frame: WhatsAppClientFrame) => void>();
  const runtime: WhatsAppRuntime = {
    accountId: "personal",
    start: async () => {},
    stop: async () => {},
    snapshot: async () => current,
    messages: () => Promise.reject(new Error("not read by this test")),
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
  current = { ...empty("personal"), revision: 3 };
  publish(2, 3);
  await tick();

  expect(seen.frames.map((frame) => frame.type)).toEqual(["snapshot", "patch", "snapshot"]);
  expect(snapshotsOf(seen.frames).map((snapshot) => snapshot.revision)).toEqual([0, 3]);

  await seen.close();
});

test("connection and presence expire and never become stored truth", async () => {
  const { backend, driver, runtime, client } = lane("personal", { freshnessMs: 5_000 });
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

  // Neither status is anywhere in the mirror: the account record has no phase
  // to restore and the contact record has no presence kind (ADR-0020).
  const snapshot = await runtime.snapshot();
  expect(Object.keys(snapshot).sort()).toEqual([
    "account",
    "accountId",
    "chats",
    "contacts",
    "groups",
    "revision",
  ]);
  expect(Object.keys(snapshot.account).sort()).toEqual(["accountId", "lastConnectedAt"]);
  expect(Object.keys(snapshot.contacts[0] ?? {}).sort()).toEqual([
    "accountId",
    "contactId",
    "lastSeenAt",
    "nativeIds",
  ]);
  // Nothing in the source log names a live status either — an accepted
  // observation carries an instant, and `online`/`typing` are not storable
  // event types at all.
  const stored = (await backend.data.accepted("personal", 0)).flatMap((batch) => batch.events);
  expect(stored.map((observation) => observation.event.type).sort()).toEqual([
    "account_connection",
    "last_seen",
    "message",
  ]);
  expect(JSON.stringify(stored)).not.toContain("typing");
  expect(JSON.stringify(stored)).not.toContain("online");

  await seen.close();
  await runtime.stop();
});

test("historical last-seen survives a restart while expired presence does not", async () => {
  const shared = memoryBackend();
  const first = lane("personal", { backend: shared, freshnessMs: 1 });
  await first.runtime.start();

  // The peer was typing a while ago, and the account was online then offline.
  await first.driver.emit({
    type: "presence",
    presence: { chatId: PERSON, kind: "available", at: AT },
  });
  await first.driver.emit({ type: "connection", status: { phase: "online" } });
  await first.driver.emit({ type: "connection", status: { phase: "disconnected" } });
  await first.runtime.stop();

  // A replacement worker for the same account, long after every live frame
  // above has expired.
  const replacement = lane("personal", { backend: shared });
  await replacement.runtime.start();
  const seen = watching(replacement.client);
  await tick();

  const [snapshot] = snapshotsOf(seen.frames);
  assert.ok(snapshot);
  // The timestamps came back...
  expect(snapshot.contacts).toEqual([
    { accountId: "personal", contactId: PERSON, nativeIds: [PERSON], lastSeenAt: AT },
  ]);
  expect(typeof snapshot.account.lastConnectedAt).toBe("number");
  expect(typeof snapshot.account.lastDisconnectedAt).toBe("number");
  // ...and nothing replayed a status: no connection or presence frame is served
  // from storage, so a client has nothing stale to treat as current.
  expect(seen.frames.map((frame) => frame.type)).toEqual(["snapshot"]);

  await seen.close();
  await replacement.runtime.stop();
});

test("a last-seen only ever moves forward, and a repeat moves nothing", async () => {
  const data = memoryDataStore();
  const seenAt = (at: number): Promise<{ revision: number; fromRevision: number }> =>
    data.accept(
      "personal",
      [{ observedAt: at, event: { type: "last_seen", contactId: PERSON, at } }],
      1,
    );

  expect((await seenAt(AT)).revision).toBe(1);
  // The same observation again changes nothing, so it takes no revision.
  const repeat = await seenAt(AT);
  expect(repeat.revision).toBe(repeat.fromRevision);
  // A late-arriving older observation is still true, and does not rewind the
  // instant a newer one already established.
  const older = await seenAt(AT - 60_000);
  expect(older.revision).toBe(older.fromRevision);
  expect((await data.snapshot("personal")).contacts[0]?.lastSeenAt).toBe(AT);

  expect((await seenAt(AT + 1)).revision).toBe(2);
  expect((await data.snapshot("personal")).contacts[0]?.lastSeenAt).toBe(AT + 1);
});

test("a group's presence records the participant, not the chat it arrived on", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  await driver.emit({
    type: "presence",
    presence: { chatId: ROOM, participant: PERSON, kind: "typing", at: AT },
  });

  expect((await runtime.snapshot()).contacts).toEqual([
    { accountId: "personal", contactId: PERSON, nativeIds: [PERSON], lastSeenAt: AT },
  ]);

  await runtime.stop();
});

test("a transitional connection status stamps neither timestamp", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  // Reconnecting is not being connected, and it is not being gone either.
  await driver.emit({ type: "connection", status: { phase: "connecting" } });
  await driver.emit({
    type: "connection",
    status: { phase: "authenticated", sync: { step: "draining" } },
  });

  expect(await runtime.snapshot()).toEqual(empty("personal"));

  // A dropped socket goes straight to backing_off without passing through
  // `disconnected`, so that phase has to count as gone or the commonest
  // disconnection there is would never be recorded.
  await driver.emit({
    type: "connection",
    status: {
      phase: "backing_off",
      reason: "connection_lost",
      retryAttempt: 1,
      nextRetryAt: AT,
    },
  });
  expect(typeof (await runtime.snapshot()).account.lastDisconnectedAt).toBe("number");

  // A terminal status is a disconnection, and being online is a connection.
  await driver.emit({
    type: "connection",
    status: { phase: "logged_out", reason: "logged_out_remote" },
  });
  expect(typeof (await runtime.snapshot()).account.lastDisconnectedAt).toBe("number");
  expect((await runtime.snapshot()).account.lastConnectedAt).toBe(undefined);

  await runtime.stop();
});

// ── Stored Message Pages (ADR-0010) ───────────────────────────────────────────

/** `count` messages in one chat, oldest first, one second apart. */
const conversation = (count: number, chatId = PERSON): ReturnType<typeof textMessage>[] =>
  Array.from({ length: count }, (_, index) =>
    textMessage({
      id: `m${index + 1}`,
      chatId,
      sender: chatId.endsWith("@g.us") ? PERSON : undefined,
      text: `message ${index + 1}`,
      timestamp: AT + index * 1_000,
    }),
  );

test("the Snapshot Window carries no message window for any chat", async () => {
  const { driver, runtime, client } = lane("personal");
  await runtime.start();
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [
        { id: PERSON, isGroup: false },
        { id: ROOM, isGroup: true, subject: "The Room" },
      ],
      contacts: [{ id: PERSON, displayName: "Someone" }],
      messages: [...conversation(40), ...conversation(40, ROOM)],
    },
  });

  const seen = watching(client);
  await tick();
  const [snapshot] = snapshotsOf(seen.frames);
  assert.ok(snapshot);

  // Account state, chat summaries, contacts, and groups — and no per-chat
  // message window, however many messages those chats hold.
  expect(Object.keys(snapshot).sort()).toEqual([
    "account",
    "accountId",
    "chats",
    "contacts",
    "groups",
    "revision",
  ]);
  expect(snapshot.chats.map((chat) => chat.chatId).sort()).toEqual([PERSON, ROOM]);
  expect(snapshot.contacts.map((contact) => contact.contactId)).toEqual([PERSON]);
  expect(snapshot.groups.map((group) => group.groupId)).toEqual([ROOM]);
  expect(JSON.stringify(snapshot)).not.toContain("message 1");

  await seen.close();
  await runtime.stop();
});

test("opening a chat reads its first saved page, and older pages follow a stable cursor", async () => {
  const { driver, runtime, client } = lane("personal");
  await runtime.start();
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [...conversation(7), ...conversation(3, ROOM)],
    },
  });

  // Opening the chat: the newest saved messages, without naming a cursor.
  const first = await client.messages(PERSON, { limit: 3 });
  expect(first.accountId).toBe("personal");
  expect(first.chatId).toBe(PERSON);
  expect(first.messages.map((message) => message.messageId)).toEqual(["m7", "m6", "m5"]);
  // The cursor is the page's oldest position, by timestamp *and* identity.
  expect(first.nextBefore).toEqual({ timestamp: AT + 4_000, messageId: "m5" });

  const second = await client.messages(PERSON, { limit: 3, before: first.nextBefore });
  expect(second.messages.map((message) => message.messageId)).toEqual(["m4", "m3", "m2"]);

  // Reading the same cursor twice returns the same page: it is a position in
  // the data, not a server-side iterator that consumed anything.
  expect(await client.messages(PERSON, { limit: 3, before: first.nextBefore })).toEqual(second);

  const last = await client.messages(PERSON, { limit: 3, before: second.nextBefore });
  expect(last.messages.map((message) => message.messageId)).toEqual(["m1"]);
  // The oldest saved page says only that nothing older is *stored*. Nothing
  // here claims WhatsApp history is complete, and nothing asked WhatsApp.
  expect(last.nextBefore).toBe(undefined);
  expect(Object.keys(last).sort()).toEqual(["accountId", "chatId", "messages"]);

  // Every message came back exactly once, and only this chat's.
  expect(await pagedIds(client, PERSON, 2)).toEqual(["m7", "m6", "m5", "m4", "m3", "m2", "m1"]);
  expect(await pagedIds(client, ROOM, 2)).toEqual(["m3", "m2", "m1"]);

  // Paging read the backend and nothing else: no WhatsApp history command was
  // issued for any of it (ADR-0010).
  expect(driver.commands.historyRequests).toEqual([]);

  await runtime.stop();
});

test("a page boundary inside a timestamp collision neither drops nor repeats", async () => {
  const data = memoryDataStore();
  // Five messages a history sync landed on one second — the case a
  // timestamp-only cursor cannot page through correctly.
  await data.accept(
    "personal",
    ["a", "b", "c", "d", "e"].map((id) => ({
      observedAt: AT,
      event: {
        type: "message" as const,
        message: textMessage({ id, chatId: PERSON, text: id, timestamp: AT }),
      },
    })),
    1,
  );

  const client: Pick<WhatsAppClient, "messages"> = {
    messages: (chatId, options) => data.messages("personal", chatId, options),
  };
  for (const limit of [1, 2, 3, 4, 5, 6]) {
    expect(await pagedIds(client, PERSON, limit)).toEqual(["e", "d", "c", "b", "a"]);
  }
});

test("paging interleaved with a live update neither duplicates nor skips a message", async () => {
  const { driver, runtime, client } = lane("personal");
  await runtime.start();
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: conversation(5),
    },
  });
  const seen = watching(client);
  await tick();

  // The reader has the newest page open and is about to scroll back.
  const first = await client.messages(PERSON, { limit: 2 });
  expect(first.messages.map((message) => message.messageId)).toEqual(["m5", "m4"]);

  // A live message arrives mid-scroll — newer than everything already stored.
  await driver.emit({
    type: "message",
    message: textMessage({ id: "live", chatId: PERSON, text: "live", timestamp: AT + 9_000 }),
  });
  await tick();

  const rest = await pagedIds(client, PERSON, 2, first.nextBefore);
  // The live message is not in an older page — it is newer than the cursor, so
  // paging back cannot reach it — and nothing between the cursor and the oldest
  // saved message was skipped by its arrival.
  expect(rest).toEqual(["m3", "m2", "m1"]);

  // It arrived exactly once, on the patch stream, and a reader that applies
  // both surfaces sees every message once.
  const live = patchesOf(seen.frames)
    .flatMap((patch) => patch.upserts)
    .filter((upsert) => upsert.type === "message")
    .map((upsert) => upsert.message.messageId);
  expect(live).toEqual(["live"]);
  expect([...first.messages.map((message) => message.messageId), ...rest, ...live].sort()).toEqual([
    "live",
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
  ]);

  // Re-reading from the top now includes it, in its place.
  expect(await pagedIds(client, PERSON, 3)).toEqual(["live", "m5", "m4", "m3", "m2", "m1"]);
  expect(driver.commands.historyRequests).toEqual([]);

  await seen.close();
  await runtime.stop();
});

test("a stale update is ignored, a future base re-snapshots, and pages read through both", async () => {
  const data = memoryDataStore();
  const listeners = new Set<(frame: WhatsAppClientFrame) => void>();
  const runtime: WhatsAppRuntime = {
    accountId: "personal",
    start: async () => {},
    stop: async () => {},
    snapshot: () => data.snapshot("personal"),
    messages: (chatId, options) => data.messages("personal", chatId, options),
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // Published on the same seam the runtime publishes on, so the client cannot
  // tell these apart from a live runtime's own updates.
  const publish = (fromRevision: number, revision: number): void => {
    for (const listener of listeners)
      listener({
        type: "patch",
        patch: { accountId: "personal", fromRevision, revision, upserts: [] },
      });
  };
  const store = (id: string, index: number): Promise<unknown> =>
    data.accept(
      "personal",
      [
        {
          observedAt: AT,
          event: {
            type: "message",
            message: textMessage({ id, chatId: PERSON, text: id, timestamp: AT + index * 1_000 }),
          },
        },
      ],
      1,
    );

  for (const [index, id] of ["m1", "m2", "m3", "m4"].entries()) await store(id, index);

  const client = createInProcessWhatsAppClient(runtime);
  const seen = watching(client);
  await tick();

  // A conversation is opened and scrolled one page back.
  const opened = await client.messages(PERSON, { limit: 2 });
  expect(opened.messages.map((message) => message.messageId)).toEqual(["m4", "m3"]);

  // A stale update: revision 2 is a change the snapshot already carried.
  publish(1, 2);
  await tick();

  // A future base: revision 5 never arrived, so 6 cannot be applied over the
  // gap and the client replaces its state instead of silently skipping it.
  await store("m5", 4);
  await store("m6", 5);
  publish(5, 6);
  await tick();

  expect(seen.frames.map((frame) => frame.type)).toEqual(["snapshot", "snapshot"]);
  expect(snapshotsOf(seen.frames).map((snapshot) => snapshot.revision)).toEqual([4, 6]);

  // The cursor opened before the gap still pages correctly afterwards, and a
  // reader that reopens the chat sees every stored message exactly once.
  expect(await pagedIds(client, PERSON, 2, opened.nextBefore)).toEqual(["m2", "m1"]);
  expect(await pagedIds(client, PERSON, 4)).toEqual(["m6", "m5", "m4", "m3", "m2", "m1"]);

  await seen.close();
});

test("a page size must be a positive integer", async () => {
  const data = memoryDataStore();
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(data.messages("personal", PERSON, { limit }), RangeError);
  }
});
