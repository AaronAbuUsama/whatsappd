/**
 * One text message through the whole product path: the deterministic session
 * drives the public runtime, and every assertion reads the public client or the
 * backend contracts. No harness, no fixtures, no sleeps.
 */
import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import {
  StaleAccountClaimError,
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
import type { InboundMessage } from "../src/model/message.ts";
import { SubscriptionHandlerError } from "../src/subscription.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";

const PERSON = "person@s.whatsapp.net";
const ROOM = "room@g.us";
const SELF = "15551230000@s.whatsapp.net";
const AT = 1_700_000_000_000;

/** Let queued microtasks and one macrotask turn drain — never a timed wait. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Keep timer-driven public behavior observable on Node even when its timer is unreferenced. */
async function withDeadline<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

const fixedLeaseStore = (fencingToken: number): AccountLeaseStore => ({
  async acquire(accountId, holderId, ttlMs) {
    return {
      acquired: true,
      lease: { accountId, holderId, fencingToken, expiresAt: Date.now() + ttlMs },
    };
  },
  async renew(lease, ttlMs) {
    return { renewed: true, lease: { ...lease, expiresAt: Date.now() + ttlMs } };
  },
  async release() {
    return true;
  },
});

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

const image = (download: () => Promise<Buffer>): InboundMessage => ({
  id: "image-1",
  chatId: PERSON,
  sender: { id: PERSON, mode: "pn" },
  fromMe: false,
  timestamp: AT,
  live: true,
  isGroup: false,
  kind: "image",
  media: {
    mimetype: "image/png",
    fileLength: 4,
    width: 2,
    height: 2,
    caption: "proof",
    download,
  },
});

const voiceNote = (download: () => Promise<Buffer>): InboundMessage => ({
  id: "voice-1",
  chatId: PERSON,
  sender: { id: PERSON, mode: "pn" },
  fromMe: false,
  timestamp: AT,
  live: true,
  isGroup: false,
  kind: "audio",
  media: {
    mimetype: "audio/ogg; codecs=opus",
    fileLength: 5,
    seconds: 2,
    ptt: true,
    download,
  },
});

const attachment = (
  kind: "video" | "document" | "sticker",
  id: string,
  mimetype: string,
  download: () => Promise<Buffer>,
): InboundMessage => ({
  id,
  chatId: PERSON,
  sender: { id: PERSON, mode: "pn" },
  fromMe: false,
  timestamp: AT,
  live: true,
  isGroup: false,
  kind,
  media: { mimetype, download },
});

/** The Snapshot Window of an account nothing has been observed for yet. */
const empty = (accountId: string): WhatsAppSnapshot => ({
  accountId,
  revision: 0,
  account: { accountId },
  chats: [],
  contacts: [],
  contactAliases: {},
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

test("an image is stored before one accepted state reaches the Client, page, and source", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let downloaded = false;
  const data = memoryDataStore();
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    media: memoryMediaStore(),
    data: {
      ...data,
      async accept(accountId, events, fencingToken) {
        assert.equal(downloaded, true, "media download must finish before data acceptance starts");
        return data.accept(accountId, events, fencingToken);
      },
    },
  };
  const { driver, runtime, client } = lane("personal", { backend });
  await runtime.start();
  const seen = watching(client);
  await tick();

  await driver.emit({
    type: "message",
    message: image(async () => {
      await tick();
      downloaded = true;
      return bytes;
    }),
  });
  await tick();

  const page = await client.messages(PERSON);
  assert.equal(page.messages.length, 1);
  const message = page.messages[0]!;
  assert.equal(message.kind, "image");
  assert.equal(message.media.state, "stored");
  assert.equal(message.media.byteLength, bytes.byteLength);
  assert.deepEqual(
    await backend.media.read({ accountId: "personal", ref: message.media.ref }),
    Uint8Array.from(bytes),
  );

  const expected = {
    accountId: "personal",
    chatId: PERSON,
    messageId: "image-1",
    sender: { id: PERSON, mode: "pn" },
    fromMe: false,
    timestamp: AT,
    kind: "image",
    media: {
      state: "stored",
      ref: message.media.ref,
      byteLength: 4,
      mimetype: "image/png",
      fileLength: 4,
      width: 2,
      height: 2,
      caption: "proof",
    },
  };
  const messageUpsert = patchesOf(seen.frames)[0]?.upserts.find(
    (record) => record.type === "message",
  );
  assert.deepEqual(messageUpsert, { type: "message", message: expected });

  const accepted = await backend.data.accepted("personal", 0);
  expect(accepted[0]?.events).toEqual([
    {
      observedAt: accepted[0]?.events[0]?.observedAt,
      event: {
        type: "message",
        message: {
          id: "image-1",
          chatId: PERSON,
          sender: { id: PERSON, mode: "pn" },
          fromMe: false,
          timestamp: AT,
          live: true,
          isGroup: false,
          kind: "image",
          media: expected.media,
        },
      },
    },
  ]);

  await seen.close();
  await runtime.stop();
});

test("a voice note keeps its original audio bytes without a transcription dependency", async () => {
  const bytes = Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x21]);
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();

  await driver.emit({ type: "message", message: voiceNote(async () => bytes) });

  const [message] = (await client.messages(PERSON)).messages;
  assert.equal(message?.kind, "audio");
  assert.equal(message.media.state, "stored");
  assert.equal(message.media.ptt, true);
  assert.deepEqual(
    await backend.media.read({ accountId: "personal", ref: message.media.ref }),
    Uint8Array.from(bytes),
  );

  await runtime.stop();
});

test("video, document, and sticker bytes use the same durable media contract", async () => {
  const cases = [
    ["video", "video/mp4"],
    ["document", "application/pdf"],
    ["sticker", "image/webp"],
  ] as const;
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();

  for (const [kind, mimetype] of cases) {
    const bytes = Buffer.from(`${kind}-bytes`);
    const id = `${kind}-1`;
    await driver.emit({
      type: "message",
      message: attachment(kind, id, mimetype, async () => bytes),
    });
    const message = (await client.messages(PERSON)).messages.find(
      (candidate) => candidate.messageId === id,
    );
    assert.equal(message?.kind, kind);
    assert.equal(message.media.state, "stored");
    assert.deepEqual(
      await backend.media.read({ accountId: "personal", ref: message.media.ref }),
      Uint8Array.from(bytes),
    );
  }

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
  // client — the conversation comes back unchanged.
  const replacement = lane("personal", { backend });
  await replacement.runtime.start();
  const seen = watching(replacement.client);
  await tick();

  const [restored] = snapshotsOf(seen.frames);
  assert.ok(restored);
  expect({ ...restored, account: stored.account, revision: stored.revision }).toEqual(stored);
  expect((await replacement.runtime.messages(PERSON)).messages).toEqual(
    (await runtime.messages(PERSON)).messages,
  );
  // The only thing the stop moved: the account now knows when it last went
  // offline, which is history rather than a status (ADR-0020).
  expect(typeof restored.account.lastDisconnectedAt).toBe("number");
  expect(restored.revision).toBe(stored.revision + 1);

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
  // Counted separately from the teardown's own disconnect stamp, which is not
  // a WhatsApp change and is the only other thing that writes here.
  let messageAccepts = 0;
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    data: {
      ...data,
      accept: (accountId, events, fencingToken) => {
        accepts += 1;
        if (events.some((observation) => observation.event.type === "message")) messageAccepts += 1;
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
  expect(messageAccepts).toBe(1);

  // The failed change reached no client: nothing a watcher saw carries a
  // message, and the mirror still holds none.
  expect(
    patchesOf(seen.frames).flatMap((patch) =>
      patch.upserts.filter((upsert) => upsert.type === "message"),
    ),
  ).toEqual([]);
  expect((await runtime.messages(PERSON)).messages).toEqual([]);
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

test("memory data values are owned by the store across every public seam", async () => {
  const data = memoryDataStore();
  const observation: WhatsAppDataEvent = {
    observedAt: AT,
    event: { type: "message", message: hello() },
  };
  const committed = await data.accept("personal", [observation], 1);

  (observation.event as { message: { text: string } }).message.text = "mutated input";
  const committedMessage = committed.patch.upserts.find((record) => record.type === "message");
  assert.ok(committedMessage?.type === "message");
  (committedMessage.message as { text: string }).text = "mutated result";
  const snapshot = await data.snapshot("personal");
  (snapshot.chats[0] as { lastMessageAt: number }).lastMessageAt = 0;
  const page = await data.messages("personal", PERSON);
  (page.messages[0] as { text: string }).text = "mutated page";
  const source = await data.accepted("personal", 0);
  const sourceEvent = source[0]?.events[0]?.event;
  assert.ok(sourceEvent?.type === "message" && sourceEvent.message.kind === "text");
  (sourceEvent.message as { text: string }).text = "mutated source";

  expect((await data.messages("personal", PERSON)).messages[0]?.text).toBe("Hello");
  expect((await data.snapshot("personal")).chats[0]?.lastMessageAt).toBe(AT);
  const retainedEvent = (await data.accepted("personal", 0))[0]?.events[0]?.event;
  assert.ok(retainedEvent?.type === "message" && retainedEvent.message.kind === "text");
  expect(retainedEvent.message.text).toBe("Hello");
});

test("mutating a delivered patch cannot mutate the committed mirror", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();
  let laterText: string | undefined;
  runtime.onFrame((frame) => {
    if (frame.type !== "patch") return;
    const message = frame.patch.upserts.find((record) => record.type === "message");
    if (message?.type === "message") (message.message as { text: string }).text = "observer edit";
  });
  runtime.onFrame((frame) => {
    if (frame.type !== "patch") return;
    const message = frame.patch.upserts.find((record) => record.type === "message");
    if (message?.type === "message") laterText = message.message.text;
  });

  await driver.emit({ type: "message", message: hello() });

  expect((await runtime.messages(PERSON)).messages[0]?.text).toBe("Hello");
  expect(laterText).toBe("Hello");
  await runtime.stop();
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

test("an update is retained in accepted source without inventing a projection", async () => {
  const data = memoryDataStore();

  const accepted = await data.accept(
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
  );

  expect(accepted).toMatchObject({ seq: 1, fromRevision: 0, revision: 0, patch: { upserts: [] } });
  expect((await data.snapshot("personal")).revision).toBe(0);
  expect((await data.accepted("personal", 0))[0]?.events[0]?.event.type).toBe("update");
});

test("conversation sync captures media in source order and accepts one durable batch", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  const order: string[] = [];

  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "recent", projection: { mode: "upsert" } },
      chats: [{ id: PERSON, isGroup: false }],
      contacts: [],
      messages: [
        {
          ...image(async () => {
            order.push("image");
            return Buffer.from("sync-image");
          }),
          id: "sync-image",
          live: false,
        },
        {
          ...voiceNote(async () => {
            order.push("voice");
            return Buffer.from("sync-voice");
          }),
          id: "sync-voice",
          live: false,
        },
      ],
    },
  });

  expect(order).toEqual(["image", "voice"]);
  const accepted = await backend.data.accepted("personal", 0);
  assert.equal(accepted.length, 1);
  const event = accepted[0]?.events[0]?.event;
  assert.ok(event?.type === "conversation_sync");
  assert.equal(event.batch.messages.length, 2);
  for (const message of event.batch.messages) {
    assert.ok(
      message.kind === "image" ||
        message.kind === "video" ||
        message.kind === "audio" ||
        message.kind === "document" ||
        message.kind === "sticker",
    );
    assert.equal(message.media.state, "stored");
    assert.equal("download" in message.media, false);
  }
  expect(
    (await client.messages(PERSON)).messages.map((message) => message.messageId).sort(),
  ).toEqual(["sync-image", "sync-voice"]);

  await runtime.stop();
});

test("a media edit captures bytes and replaces the Client-visible durable record", async () => {
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();
  await driver.emit({
    type: "message",
    message: { ...image(async () => Buffer.from("old")), id: "m1" },
  });

  await driver.emit({
    type: "update",
    update: {
      kind: "edit",
      ref: { id: "m1", chatId: PERSON, fromMe: false },
      message: {
        id: "m1",
        chatId: PERSON,
        sender: { id: PERSON, mode: "pn" },
        fromMe: false,
        timestamp: AT,
        live: true,
        isGroup: false,
        kind: "image",
        media: {
          mimetype: "image/jpeg",
          width: 640,
          height: 480,
          async download() {
            return Buffer.from("edited-image");
          },
        },
      },
    },
  });

  const event = (await backend.data.accepted("personal", 1))[0]?.events[0]?.event;
  assert.ok(event?.type === "update" && event.update.kind === "edit");
  assert.equal(event.update.message.kind, "image");
  if (event.update.message.kind === "image") {
    expect(event.update.message.media).toMatchObject({
      mimetype: "image/jpeg",
      width: 640,
      height: 480,
      state: "stored",
      byteLength: 12,
    });
    expect("download" in event.update.message.media).toBe(false);
  }
  const [message] = (await client.messages(PERSON)).messages;
  assert.equal(message?.kind, "image");
  assert.equal(message.media.state, "stored");
  assert.deepEqual(
    await backend.media.read({ accountId: "personal", ref: message.media.ref }),
    Uint8Array.from(Buffer.from("edited-image")),
  );

  await runtime.stop();
});

test("typed download and store failures reach the Client while later messages continue", async () => {
  const stored = memoryMediaStore();
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    media: {
      async put(input) {
        if (input.message.id === "store-failed") throw new Error("disk unavailable");
        return stored.put(input);
      },
      read: (input) => stored.read(input),
    },
  };
  const { driver, runtime, client } = lane("personal", { backend });
  await runtime.start();

  await driver.emit({
    type: "message",
    message: {
      ...image(async () => {
        throw new Error("expired media handle");
      }),
      id: "download-failed",
    },
  });
  await driver.emit({
    type: "message",
    message: { ...image(async () => Buffer.from("downloaded")), id: "store-failed" },
  });
  await driver.emit({ type: "message", message: hello("after-failures", "Still running") });

  const messages = (await client.messages(PERSON)).messages;
  const downloadFailure = messages.find((message) => message.messageId === "download-failed");
  const storeFailure = messages.find((message) => message.messageId === "store-failed");
  const later = messages.find((message) => message.messageId === "after-failures");
  assert.equal(downloadFailure?.kind, "image");
  assert.deepEqual(downloadFailure.media, {
    mimetype: "image/png",
    fileLength: 4,
    width: 2,
    height: 2,
    caption: "proof",
    state: "failed",
    reason: "download_failed",
  });
  assert.equal(storeFailure?.kind, "image");
  assert.equal(storeFailure.media.state, "failed");
  assert.equal(storeFailure.media.reason, "store_failed");
  assert.equal(later?.kind, "text");
  assert.equal(later.text, "Still running");

  await runtime.stop();
});

test("repeated media reuses its ref while changed edit bytes preserve the old object", async () => {
  const firstBytes = Buffer.from("same-image");
  const editedBytes = Buffer.from("changed-image");
  const { driver, backend, runtime, client } = lane("personal");
  await runtime.start();

  const original = { ...image(async () => firstBytes), id: "repeat-image" };
  await driver.emit({ type: "message", message: original });
  const [first] = (await client.messages(PERSON)).messages;
  assert.equal(first?.kind, "image");
  assert.equal(first.media.state, "stored");
  const firstRef = first.media.ref;

  await driver.emit({ type: "message", message: original });
  const [repeated] = (await client.messages(PERSON)).messages;
  assert.equal(repeated?.kind, "image");
  assert.equal(repeated.media.state, "stored");
  assert.equal(repeated.media.ref, firstRef);

  await driver.emit({
    type: "update",
    update: {
      kind: "edit",
      ref: { id: "repeat-image", chatId: PERSON, fromMe: false },
      message: { ...image(async () => editedBytes), id: "repeat-image" },
    },
  });
  const [edited] = (await client.messages(PERSON)).messages;
  assert.equal(edited?.kind, "image");
  assert.equal(edited.media.state, "stored");
  assert.notEqual(edited.media.ref, firstRef);
  assert.deepEqual(
    await backend.media.read({ accountId: "personal", ref: firstRef }),
    Uint8Array.from(firstBytes),
  );
  assert.deepEqual(
    await backend.media.read({ accountId: "personal", ref: edited.media.ref }),
    Uint8Array.from(editedBytes),
  );

  await runtime.stop();
});

test("failed structured acceptance publishes nothing and leaves the canonical media orphan readable", async () => {
  const data = memoryDataStore();
  const media = memoryMediaStore();
  let storedRef: string | undefined;
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    media: {
      async put(input) {
        const result = await media.put(input);
        storedRef = result.ref;
        return result;
      },
      read: (input) => media.read(input),
    },
    data: {
      ...data,
      async accept() {
        throw new Error("injected acceptance failure");
      },
    },
  };
  const { driver, runtime, client } = lane("personal", { backend });
  await runtime.start();
  const seen = watching(client);
  await tick();
  const bytes = Buffer.from("orphaned-but-complete");

  await assert.rejects(
    driver.emit({ type: "message", message: image(async () => bytes) }),
    SubscriptionHandlerError,
  );
  await tick();

  expect(patchesOf(seen.frames)).toEqual([]);
  expect(await runtime.snapshot()).toEqual(empty("personal"));
  expect(await data.accepted("personal", 0)).toEqual([]);
  expect((await data.messages("personal", PERSON)).messages).toEqual([]);
  assert.ok(storedRef);
  assert.deepEqual(
    await media.read({ accountId: "personal", ref: storedRef }),
    Uint8Array.from(bytes),
  );

  await seen.close();
  await assert.rejects(runtime.stop(), /injected acceptance failure/);
});

test("a stale holder cannot remove media already accepted by its replacement", async () => {
  const data = memoryDataStore();
  const media = memoryMediaStore();
  let oldAcceptEntered!: () => void;
  let releaseOldAccept!: () => void;
  const oldAtBoundary = new Promise<void>((resolve) => {
    oldAcceptEntered = resolve;
  });
  const oldMayContinue = new Promise<void>((resolve) => {
    releaseOldAccept = resolve;
  });
  const oldBackend: WhatsAppBackend = {
    credentials: memoryStore(),
    leases: fixedLeaseStore(1),
    media,
    data: {
      ...data,
      async accept(accountId, events, fencingToken) {
        if (events[0]?.event.type === "message") {
          oldAcceptEntered();
          await oldMayContinue;
        }
        return data.accept(accountId, events, fencingToken);
      },
    },
  };
  const replacementBackend: WhatsAppBackend = {
    credentials: memoryStore(),
    leases: fixedLeaseStore(2),
    media,
    data,
  };
  const old = lane("personal", { backend: oldBackend });
  const replacement = lane("personal", { backend: replacementBackend });
  const bytes = Buffer.from("shared-canonical-image");

  await old.runtime.start();
  const staleWrite = old.driver.emit({ type: "message", message: image(async () => bytes) });
  await oldAtBoundary;

  await replacement.runtime.start();
  await replacement.driver.emit({ type: "message", message: image(async () => bytes) });
  const [accepted] = (await replacement.client.messages(PERSON)).messages;
  assert.equal(accepted?.kind, "image");
  assert.equal(accepted.media.state, "stored");

  releaseOldAccept();
  await assert.rejects(staleWrite, SubscriptionHandlerError);
  assert.deepEqual(
    await media.read({ accountId: "personal", ref: accepted.media.ref }),
    Uint8Array.from(bytes),
  );
  assert.equal((await data.accepted("personal", 0)).length, 1);

  await assert.rejects(
    old.runtime.stop(),
    (error) =>
      error instanceof SubscriptionHandlerError && error.cause instanceof StaleAccountClaimError,
  );
  await replacement.runtime.stop();
});

test("projected and source-only observations commit in one batch", async () => {
  const data = memoryDataStore();

  const accepted = await data.accept(
    "personal",
    [
      {
        observedAt: AT,
        event: {
          type: "conversation_sync",
          batch: {
            context: { source: "recent", projection: { mode: "upsert" } },
            chats: [{ id: PERSON, isGroup: false }],
            contacts: [{ id: PERSON, nativeIds: [PERSON], displayName: "Someone" }],
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
  );

  expect(accepted.events.map((event) => event.event.type)).toEqual(["conversation_sync", "update"]);
  expect(accepted.revision).toBe(1);
  expect(
    (await data.messages("personal", PERSON)).messages.map((message) => message.messageId),
  ).toEqual(["m1"]);
});

test("accepted-source reads are bounded and resume from their own sequence", async () => {
  const data = memoryDataStore();
  for (const id of ["m1", "m2", "m3"])
    await data.accept(
      "personal",
      [{ observedAt: AT, event: { type: "message", message: hello(id) } }],
      1,
    );

  expect((await data.accepted("personal", 0, 2)).map((batch) => batch.seq)).toEqual([1, 2]);
  expect((await data.accepted("personal", 2, 2)).map((batch) => batch.seq)).toEqual([3]);
  await assert.rejects(data.accepted("personal", 0, 0), RangeError);
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
      contacts: [{ id: PERSON, nativeIds: [PERSON], displayName: "Someone" }],
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
  // The receipt has no projection yet, but it is still a durable observation.
  const accepted = await backend.data.accepted("personal", 0);
  expect(accepted.map((batch) => batch.events[0]?.event.type)).toEqual([
    "conversation_sync",
    "update",
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

test("a falsy runtime teardown failure is reported after releasing the account", async () => {
  const backend = memoryBackend();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => ({
      subscribe: () => () => {},
      stop: async () => {
        throw undefined; // eslint-disable-line no-throw-literal -- falsy rejection is the regression
      },
    }),
  });
  await runtime.start();

  let rejected = false;
  await runtime.stop().then(
    () => {},
    (reason: unknown) => {
      rejected = true;
      assert.equal(reason, undefined);
    },
  );

  expect(rejected).toBe(true);
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

test("a Client watch started after stop receives the terminal frame and ends", async () => {
  const { runtime, client } = lane("personal");
  await runtime.start();
  await runtime.stop();

  const frames = await withDeadline(
    (async () => {
      const seen: WhatsAppClientFrame[] = [];
      for await (const frame of client.watch()) seen.push(frame);
      return seen;
    })(),
  );

  expect(frames.map((frame) => frame.type)).toEqual(["closed"]);
});

test("runtime closure interrupts a Client snapshot already in flight", async () => {
  const data = memoryDataStore();
  let startedSnapshot!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    startedSnapshot = resolve;
  });
  const never = new Promise<WhatsAppSnapshot>(() => {});
  const backend: WhatsAppBackend = {
    ...memoryBackend(),
    data: {
      ...data,
      snapshot: () => {
        startedSnapshot();
        return never;
      },
    },
  };
  const { runtime, client } = lane("personal", { backend });
  await runtime.start();
  const first = client.watch()[Symbol.asyncIterator]().next();
  await snapshotStarted;

  await runtime.stop();

  expect(await withDeadline(first)).toEqual({ value: { type: "closed" }, done: false });
});

test("a throwing frame observer cannot block a later observer after commit", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();
  let later = 0;
  runtime.onFrame(() => {
    throw new Error("observer failed");
  });
  runtime.onFrame((frame) => {
    if (frame.type === "patch") later += 1;
  });

  await driver.emit({ type: "message", message: hello() });

  expect((await runtime.messages(PERSON)).messages.map((message) => message.messageId)).toEqual([
    "m1",
  ]);
  expect(later).toBe(1);
  await runtime.stop();
});

test("closed-frame wrappers are isolated while preserving the failure identity", async () => {
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
  runtime.onFrame((frame) => {
    if (frame.type !== "closed") return;
    const mutable = frame as { type: string; error?: unknown };
    mutable.type = "patch";
    delete mutable.error;
  });
  let current: WhatsAppClientFrame | undefined;
  runtime.onFrame((frame) => {
    current = frame;
  });

  die(died);
  await tick();

  expect(current).toEqual({ type: "closed", error: died });
  let late: WhatsAppClientFrame | undefined;
  runtime.onFrame((frame) => {
    late = frame;
  });
  expect(late).toEqual({ type: "closed", error: died });
  await assert.rejects(runtime.stop(), (error: unknown) => error === died);
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
  // The watch ending is the signal the runtime stopped. The deadline is a
  // referenced test handle, so Node 22 does not abandon the pending iterator
  // while the runtime's deliberately-unreferenced heartbeat is still due.
  const frames = await withDeadline(
    (async () => {
      const seen: WhatsAppClientFrame[] = [];
      for await (const frame of client.watch()) seen.push(frame);
      return seen;
    })(),
  );

  expect(frames.at(-1)).toEqual({ type: "closed" });
  // A claim this runtime no longer holds belongs to whoever took the account
  // over, so releasing it would evict them.
  expect(released).toBe(0);
});

test("account lease renewal has at most one request in flight", async () => {
  const inner = memoryLeaseStore();
  let active = 0;
  let maximum = 0;
  let releaseRenewals!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseRenewals = resolve;
  });
  const leases: AccountLeaseStore = {
    ...inner,
    async renew(lease) {
      active += 1;
      maximum = Math.max(maximum, active);
      await held;
      active -= 1;
      return { renewed: true, lease: { ...lease, expiresAt: Date.now() + 1_000 } };
    },
  };
  const { runtime } = lane("personal", {
    backend: { ...memoryBackend(), leases },
    leaseTtlMs: 4,
  });

  await runtime.start();
  try {
    await withDeadline(new Promise<void>((resolve) => setTimeout(resolve, 20)));
    expect(maximum).toBe(1);
  } finally {
    releaseRenewals();
    await tick();
    await runtime.stop();
  }
});

test("a lease backend outage closes the Client and is reported by stop", async () => {
  const outage = new Error("lease backend unavailable");
  const inner = memoryLeaseStore();
  const leases: AccountLeaseStore = {
    ...inner,
    renew: async () => Promise.reject(outage),
  };
  const { runtime, client } = lane("personal", {
    backend: { ...memoryBackend(), leases },
    leaseTtlMs: 4,
  });

  await runtime.start();
  const terminal = await withDeadline(
    (async () => {
      let last: WhatsAppClientFrame | undefined;
      for await (const frame of client.watch()) last = frame;
      return last;
    })(),
  );

  expect(terminal).toEqual({ type: "closed", error: outage });
  await assert.rejects(runtime.stop(), (error: unknown) => error === outage);
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

  // The contact exists first: a presence observation updates one, never
  // invents one (see `projectObserved`).
  await driver.emit({ type: "contact", contact: { id: PERSON, nativeIds: [PERSON] } });
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
    "contactAliases",
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
    "contact",
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

  // The peer was present a while ago, and the account was online then offline.
  await first.driver.emit({ type: "contact", contact: { id: PERSON, nativeIds: [PERSON] } });
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

  // A last-seen lands on a contact that exists; it never invents one, so an
  // observation for an address nothing has named is recorded and moves nothing.
  const unknown = await seenAt(AT);
  expect(unknown.revision).toBe(unknown.fromRevision);
  expect((await data.snapshot("personal")).contacts).toEqual([]);

  await data.accept(
    "personal",
    [
      {
        observedAt: AT,
        event: { type: "contact", contact: { id: PERSON, nativeIds: [PERSON] } },
      },
    ],
    1,
  );
  const known = await seenAt(AT);
  expect(known.revision).toBe(known.fromRevision + 1);
  // The same observation again changes nothing, so it takes no revision.
  const repeat = await seenAt(AT);
  expect(repeat.revision).toBe(repeat.fromRevision);
  // A late-arriving older observation is still true, and does not rewind the
  // instant a newer one already established.
  const older = await seenAt(AT - 60_000);
  expect(older.revision).toBe(older.fromRevision);
  expect((await data.snapshot("personal")).contacts[0]?.lastSeenAt).toBe(AT);

  const newer = await seenAt(AT + 1);
  expect(newer.revision).toBe(newer.fromRevision + 1);
  expect((await data.snapshot("personal")).contacts[0]?.lastSeenAt).toBe(AT + 1);
});

test("a contact reached by either native form stays one record", async () => {
  const data = memoryDataStore();
  const LID = "55555@lid";
  const observe = (event: WhatsAppDataEvent["event"]): Promise<unknown> =>
    data.accept("personal", [{ observedAt: AT, event }], 1);

  // Known first by its phone-number form...
  await observe({ type: "contact", contact: { id: PERSON, nativeIds: [PERSON] } });
  // ...then delivered again keyed by its LID, naming the PN as equivalent.
  await observe({
    type: "contact",
    contact: { id: LID, nativeIds: [LID, PERSON], displayName: "Someone" },
  });

  const { contacts } = await data.snapshot("personal");
  expect(contacts.length).toBe(1);
  expect(contacts[0]).toEqual({
    accountId: "personal",
    // Kept under the identity it was first stored at: a later form joins the
    // record rather than renaming it out from under a consumer.
    contactId: PERSON,
    nativeIds: [PERSON, LID],
    displayName: "Someone",
  });

  // A presence on either form reaches that one record.
  await observe({ type: "last_seen", contactId: LID, at: AT });
  const after = await data.snapshot("personal");
  expect(after.contacts.length).toBe(1);
  expect(after.contacts[0]?.lastSeenAt).toBe(AT);
});

test("a late PN/LID link consolidates existing contacts and publishes the removal", async () => {
  const data = memoryDataStore();
  const LID = "55555@lid";
  const observe = (contact: { id: string; nativeIds: string[]; displayName?: string }) =>
    data.accept("personal", [{ observedAt: AT, event: { type: "contact" as const, contact } }], 1);

  await observe({ id: PERSON, nativeIds: [PERSON], displayName: "Phone name" });
  await observe({ id: LID, nativeIds: [LID], displayName: "LID name" });
  const linked = await observe({ id: LID, nativeIds: [LID, PERSON], displayName: "Linked name" });

  const snapshot = await data.snapshot("personal");
  expect(snapshot.contacts).toEqual([
    {
      accountId: "personal",
      contactId: LID,
      nativeIds: [LID, PERSON],
      displayName: "Linked name",
    },
  ]);
  expect(snapshot.contactAliases).toEqual({ [LID]: LID, [PERSON]: LID });
  expect(linked.patch.deletes).toEqual([{ type: "contact", contactId: PERSON }]);
  expect((await data.accepted("personal", 0)).length).toBe(3);
});

test("message-delivered address equivalence resolves its sender through the public snapshot", async () => {
  const data = memoryDataStore();
  const LID = "55555@lid";
  await data.accept(
    "personal",
    [
      {
        observedAt: AT,
        event: {
          type: "contact",
          contact: { id: PERSON, nativeIds: [PERSON], displayName: "Someone" },
        },
      },
    ],
    1,
  );
  await data.accept(
    "personal",
    [
      {
        observedAt: AT,
        event: {
          type: "message",
          message: { ...hello(), sender: { id: LID, mode: "lid", alt: PERSON } },
        },
      },
    ],
    1,
  );

  const snapshot = await data.snapshot("personal");
  expect(snapshot.contacts).toMatchObject([{ contactId: PERSON, nativeIds: [PERSON, LID] }]);
  expect(snapshot.contactAliases[LID]).toBe(PERSON);
  expect(snapshot.contactAliases[PERSON]).toBe(PERSON);
});

test("a group's presence records the participant, not the chat it arrived on", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  await driver.emit({ type: "contact", contact: { id: PERSON, nativeIds: [PERSON] } });
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
      contacts: [{ id: PERSON, nativeIds: [PERSON], displayName: "Someone" }],
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
    "contactAliases",
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
  // The revision this page reflects, so it can be ordered against patches.
  expect(first.revision).toBe((await runtime.snapshot()).revision);
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
  expect(Object.keys(last).sort()).toEqual(["accountId", "chatId", "messages", "revision"]);

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

test("a backdated message below an open cursor reconciles by identity on both surfaces", async () => {
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

  const first = await client.messages(PERSON, { limit: 2 });
  expect(first.messages.map((message) => message.messageId)).toEqual(["m5", "m4"]);

  // The hard case, and the one #25's backfill makes routine: a message that
  // sorts *below* the cursor the reader is already holding - here between m3
  // and m4. A clock-skewed send does the same thing.
  await driver.emit({
    type: "message",
    message: textMessage({ id: "late", chatId: PERSON, text: "late", timestamp: AT + 2_500 }),
  });
  await tick();

  const rest = await pagedIds(client, PERSON, 2, first.nextBefore);
  // Nothing is skipped: the cursor is a position in the ordering, not an
  // offset, so a record inserted below it falls inside the next page, in order.
  expect(rest).toEqual(["late", "m3", "m2", "m1"]);

  const patched = patchesOf(seen.frames)
    .flatMap((patch) => patch.upserts)
    .filter((upsert) => upsert.type === "message")
    .map((upsert) => upsert.message);
  // It genuinely reaches the reader on both surfaces - the contract's hard
  // case, not a hypothetical, and appending would leave two of it.
  expect(patched.map((message) => message.messageId)).toEqual(["late"]);
  expect(rest.includes("late")).toBe(true);

  // Applying both by record identity - which is how a conversation is fed -
  // leaves exactly one of each message and loses none.
  const identity = (chatId: string, messageId: string): string => `${chatId} ${messageId}`;
  const reconciled = new Set([
    ...first.messages.map((message) => identity(message.chatId, message.messageId)),
    ...patched.map((message) => identity(message.chatId, message.messageId)),
    ...rest.map((messageId) => identity(PERSON, messageId)),
  ]);
  expect([...reconciled].map((key) => key.split(" ")[1]).sort()).toEqual([
    "late",
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
  ]);

  // The page and the patch agree on the record itself, so identity is the only
  // thing a consumer has to reconcile on.
  const paged = (await client.messages(PERSON, { limit: 10 })).messages.find(
    (message) => message.messageId === "late",
  );
  expect(paged).toEqual(patched[0]);
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

test("a real runtime's missed update is detected and replaced with a fresh snapshot", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  // A real client watch over the real runtime and the real backend, with one
  // live update dropped on the way to this watcher — the wire loss the
  // contiguity rule exists to survive. Nothing about the mirror is faked: the
  // snapshots and pages below are the backend's own.
  let drop = 0;
  const lossy: WhatsAppClient = createInProcessWhatsAppClient({
    ...runtime,
    onFrame: (listener) =>
      runtime.onFrame((frame) => {
        if (frame.type === "patch" && drop > 0) {
          drop -= 1;
          return;
        }
        listener(frame);
      }),
  });

  const seen = watching(lossy);
  await tick();
  expect(snapshotsOf(seen.frames).map((snapshot) => snapshot.revision)).toEqual([0]);

  await driver.emit({ type: "message", message: hello("m1") });
  await tick();
  const opened = await lossy.messages(PERSON, { limit: 1 });
  expect(opened.messages.map((message) => message.messageId)).toEqual(["m1"]);

  // The next change never reaches this watcher.
  drop = 1;
  await driver.emit({ type: "message", message: hello("m2") });
  await tick();
  expect(patchesOf(seen.frames).length).toBe(1);

  // The one after it therefore arrives on a base the watcher does not hold, and
  // a fresh snapshot replaces state rather than applying over the hole.
  await driver.emit({ type: "message", message: hello("m3") });
  await tick();

  expect(seen.frames.map((frame) => frame.type)).toEqual(["snapshot", "patch", "snapshot"]);
  const recovered = snapshotsOf(seen.frames).at(-1);
  assert.ok(recovered);
  expect(recovered.revision).toBe((await runtime.snapshot()).revision);
  // Recovery loses nothing: the chat still pages to every stored message, and
  // the missed one is back.
  expect(await pagedIds(lossy, PERSON, 2)).toEqual(["m3", "m2", "m1"]);
  expect(driver.commands.historyRequests).toEqual([]);

  await seen.close();
  await runtime.stop();
});

test("a group's roster follows participant changes without deleting a record", async () => {
  const { driver, runtime, client } = lane("personal");
  await runtime.start();
  const seen = watching(client);
  await tick();

  await driver.emit({
    type: "group",
    group: {
      kind: "metadata",
      id: ROOM,
      subject: "The Room",
      participants: [{ id: PERSON, role: "admin" }],
      at: AT,
    },
  });
  await driver.emit({
    type: "group",
    group: {
      kind: "participants",
      id: ROOM,
      action: "add",
      participants: [{ id: SELF }],
      at: AT,
    },
  });
  await tick();
  expect((await runtime.snapshot()).groups).toEqual([
    {
      accountId: "personal",
      groupId: ROOM,
      subject: "The Room",
      participants: [{ id: PERSON, role: "admin" }, { id: SELF }],
    },
  ]);

  // A promotion edits the participant in place rather than adding a second.
  await driver.emit({
    type: "group",
    group: {
      kind: "participants",
      id: ROOM,
      action: "promote",
      participants: [{ id: SELF, role: "admin" }],
      at: AT,
    },
  });
  // A removal edits the record's roster; it never removes the group record, so
  // no patch carries a deletion (ADR-0019).
  await driver.emit({
    type: "group",
    group: {
      kind: "participants",
      id: ROOM,
      action: "remove",
      participants: [{ id: PERSON }],
      at: AT,
    },
  });
  await tick();

  const groups = (await runtime.snapshot()).groups;
  expect(groups.length).toBe(1);
  expect(groups[0]?.participants).toEqual([{ id: SELF, role: "admin" }]);
  // The subject the metadata event established survived every roster change.
  expect(groups[0]?.subject).toBe("The Room");
  expect(
    patchesOf(seen.frames).flatMap((patch) =>
      patch.upserts.flatMap((upsert) => (upsert.type === "group" ? [upsert.group] : [])),
    ),
  ).toEqual([
    {
      accountId: "personal",
      groupId: ROOM,
      subject: "The Room",
      participants: [{ id: PERSON, role: "admin" }],
    },
    {
      accountId: "personal",
      groupId: ROOM,
      subject: "The Room",
      participants: [{ id: PERSON, role: "admin" }, { id: SELF }],
    },
    {
      accountId: "personal",
      groupId: ROOM,
      subject: "The Room",
      participants: [
        { id: PERSON, role: "admin" },
        { id: SELF, role: "admin" },
      ],
    },
    {
      accountId: "personal",
      groupId: ROOM,
      subject: "The Room",
      participants: [{ id: SELF, role: "admin" }],
    },
  ]);
  expect(
    patchesOf(seen.frames).every((patch) => patch.upserts.every((upsert) => "type" in upsert)),
  ).toBe(true);
  expect(Object.keys(patchesOf(seen.frames)[0] ?? {}).includes("deletes")).toBe(false);

  await seen.close();
  await runtime.stop();
});

test("going unavailable never dates a contact's last-seen to now", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  // The peer was genuinely seen a week ago.
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  await driver.emit({ type: "contact", contact: { id: PERSON, nativeIds: [PERSON] } });
  await driver.emit({
    type: "presence",
    presence: { chatId: PERSON, kind: "available", at: weekAgo },
  });
  const before = (await runtime.snapshot()).contacts[0]?.lastSeenAt;
  expect(before).toBe(weekAgo);

  // WhatsApp reports a long-offline peer as `unavailable`, and the mapping
  // stamps `at` with receipt time rather than a real last-seen — so recording
  // it would move a week-old last-seen to this instant, permanently.
  await driver.emit({
    type: "presence",
    presence: { chatId: PERSON, kind: "unavailable", at: Date.now() },
  });

  expect((await runtime.snapshot()).contacts[0]?.lastSeenAt).toBe(weekAgo);
  await runtime.stop();
});

test("a presence frame arriving without a claim is let go, not fatal", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();
  // The account has been given back; a frame already in flight must not take
  // the session down the way an unpersistable message would.
  await runtime.stop();

  await driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing", at: AT } });
  expect((await runtime.snapshot()).contacts).toEqual([]);
});

test("a live group rename reaches the chat summary, not just the group record", async () => {
  const { driver, runtime } = lane("personal");
  await runtime.start();

  // The sync names the group; a later live rename must not leave the Snapshot
  // Window carrying two different names for it.
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [{ id: ROOM, isGroup: true, subject: "Old" }],
      contacts: [],
      messages: [],
    },
  });
  await driver.emit({
    type: "group",
    group: { kind: "metadata", id: ROOM, subject: "New", at: AT },
  });

  const snapshot = await runtime.snapshot();
  expect(snapshot.groups.map((group) => group.subject)).toEqual(["New"]);
  expect(snapshot.chats.map((chat) => [chat.chatId, chat.subject])).toEqual([[ROOM, "New"]]);

  await runtime.stop();
});
