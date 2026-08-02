import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "./_expect.ts";

import {
  createWhatsAppClient,
  memoryBackend,
  WhatsAppClientClosedError,
  type WhatsAppBackendResource,
  type WhatsAppClientOptions,
} from "../src/index.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";

const ACCOUNT = "personal";
const ALPHA = "alpha@s.whatsapp.net";
const BRAVO = "bravo@s.whatsapp.net";
const LID = "100000000000001@lid";
const ROOM = "room@g.us";
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
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

function openClient(
  backend: WhatsAppBackendResource,
  driver: ReturnType<typeof createTestWhatsAppSession>,
  tuning: Pick<WhatsAppClientOptions, "freshnessMs" | "holderId" | "leaseTtlMs"> = {},
) {
  return createWhatsAppClient({
    accountId: ACCOUNT,
    openBackend: () => backend,
    openSession: () => driver.session,
    ...tuning,
  });
}

test("one awaited Client owns startup, hydration, live state, and shutdown", async () => {
  const stored = memoryBackend();
  let backendCloses = 0;
  const backend = {
    ...stored,
    async close() {
      backendCloses += 1;
    },
  };
  const driver = createTestWhatsAppSession();
  let sessionStops = 0;
  const client = await createWhatsAppClient({
    accountId: ACCOUNT,
    openBackend: () => backend,
    openSession: () => ({
      ...driver.session,
      async stop() {
        sessionStops += 1;
        await driver.session.stop?.();
      },
    }),
  });
  assert.deepEqual(client.account.get().record, { accountId: ACCOUNT });

  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [
        { id: ALPHA, isGroup: false, subject: "Alpha", lastMessageAt: 100 },
        { id: BRAVO, isGroup: false, subject: "Bravo", lastMessageAt: 200 },
      ],
      contacts: [],
      messages: [],
    },
  });

  assert.deepEqual(
    client.chats.list().map((chat) => [chat.chatId, chat.subject]),
    [
      [BRAVO, "Bravo"],
      [ALPHA, "Alpha"],
    ],
  );
  assert.equal(client.chats.get(ALPHA)?.subject, "Alpha");

  const published: string[][] = [];
  const unsubscribe = client.chats.subscribe((chats) => {
    published.push(chats.map((chat) => chat.chatId));
  });
  assert.deepEqual(published, []);

  await driver.emit({
    type: "message",
    message: textMessage({ id: "new", chatId: ALPHA, text: "new", timestamp: 300 }),
  });
  assert.deepEqual(published, [[ALPHA, BRAVO]]);

  unsubscribe();
  const closing = client.close();
  assert.equal(client.close(), closing);
  await closing;
  assert.equal(sessionStops, 1);
  assert.equal(backendCloses, 1);
  assert.throws(() => client.chats.list(), WhatsAppClientClosedError);
  assert.equal((await stored.leases.acquire(ACCOUNT, "replacement", 30_000)).acquired, true);
});

test("Runtime termination rejects Client creation while initial hydration is blocked", async () => {
  const base = memoryBackend();
  let snapshotReady!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    snapshotReady = resolve;
  });
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        snapshotReady();
        await snapshotGate;
        return base.data.snapshot(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const creating = openClient(backend, driver);

  await snapshotStarted;
  try {
    await driver.session.stop?.();
    await assert.rejects(withDeadline(creating), WhatsAppClientClosedError);
  } finally {
    releaseSnapshot();
  }
});

test("Client creation failure attempts every owned cleanup and releases the account", async () => {
  const base = memoryBackend();
  const hydrationFailure = new Error("initial snapshot failed");
  const sessionFailure = new Error("session stop failed");
  const backendFailure = new Error("backend close failed");
  let sessionStops = 0;
  let backendCloses = 0;
  const backend = {
    ...base,
    data: {
      ...base.data,
      async snapshot(): Promise<never> {
        throw hydrationFailure;
      },
    },
    async close() {
      backendCloses += 1;
      throw backendFailure;
    },
  };
  const driver = createTestWhatsAppSession();

  await assert.rejects(
    createWhatsAppClient({
      accountId: ACCOUNT,
      openBackend: () => backend,
      openSession: () => ({
        ...driver.session,
        async stop() {
          sessionStops += 1;
          await driver.session.stop?.();
          throw sessionFailure;
        },
      }),
    }),
    (error) => error === hydrationFailure,
  );
  assert.equal(sessionStops, 1);
  assert.equal(backendCloses, 1);
  assert.equal((await base.leases.acquire(ACCOUNT, "replacement", 30_000)).acquired, true);
});

test("an awaited Client hydrates account, contacts, aliases, and groups", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [
        {
          id: ROOM,
          isGroup: true,
          subject: "Room",
          participants: [{ id: ALPHA, role: "admin" }],
        },
      ],
      contacts: [
        { id: BRAVO, nativeIds: [BRAVO], displayName: "Bravo" },
        { id: ALPHA, nativeIds: [ALPHA, LID], displayName: "Alpha" },
      ],
      messages: [],
    },
  });
  assert.deepEqual(client.account.get().record, { accountId: ACCOUNT });
  assert.deepEqual(
    client.contacts.list().map((contact) => contact.contactId),
    [ALPHA, BRAVO],
  );
  assert.equal(client.contacts.get(ALPHA)?.displayName, "Alpha");
  assert.equal(client.contacts.resolve(ALPHA), client.contacts.get(ALPHA));
  assert.equal(client.contacts.resolve(LID), client.contacts.get(ALPHA));
  assert.deepEqual(client.groups.list(), [
    {
      accountId: ACCOUNT,
      groupId: ROOM,
      subject: "Room",
      participants: [{ id: ALPHA, role: "admin" }],
    },
  ]);
  assert.equal(client.groups.get(ROOM)?.subject, "Room");

  await client.close();
});

test("opening a chat merges its newest saved page with matching live upserts", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [
        textMessage({ id: "saved-old", chatId: ALPHA, text: "old", timestamp: 100, live: false }),
        textMessage({ id: "saved-new", chatId: ALPHA, text: "new", timestamp: 200, live: false }),
      ],
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 2 });

  await driver.emit({
    type: "message",
    message: textMessage({ id: "live", chatId: ALPHA, text: "live", timestamp: 300 }),
  });

  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["live", "saved-new", "saved-old"],
  );
  assert.equal(conversation.get().loadingOlder, false);
  assert.equal(conversation.get().hasOlderSaved, false);

  conversation.close();
  await client.close();
});

test("one committed message patch publishes one coherent conversation state", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  const conversation = await client.chats.open(ALPHA);
  const published: Array<{
    readonly messages: readonly string[];
    readonly lastMessageAt?: number;
  }> = [];
  conversation.subscribe((state) => {
    published.push({
      messages: state.messages.map((message) => message.messageId),
      ...(state.chat && { lastMessageAt: state.chat.lastMessageAt }),
    });
  });
  const crossRead: typeof published = [];
  client.chats.subscribe(() => {
    const state = conversation.get();
    crossRead.push({
      messages: state.messages.map((message) => message.messageId),
      ...(state.chat && { lastMessageAt: state.chat.lastMessageAt }),
    });
  });

  await driver.emit({
    type: "message",
    message: textMessage({ id: "m1", chatId: ALPHA, text: "one", timestamp: 100 }),
  });

  assert.deepEqual(published, [{ messages: ["m1"], lastMessageAt: 100 }]);
  assert.deepEqual(crossRead, [{ messages: ["m1"], lastMessageAt: 100 }]);

  conversation.close();
  await client.close();
});

test("one committed patch stages every conversation before notifying any", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  const alpha = await client.chats.open(ALPHA);
  const bravo = await client.chats.open(BRAVO);
  const crossRead: string[][] = [];
  alpha.subscribe((state) => {
    if (state.messages.some((message) => message.messageId === "alpha-new"))
      crossRead.push(bravo.get().messages.map((message) => message.messageId));
  });

  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "recent", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [
        textMessage({
          id: "alpha-new",
          chatId: ALPHA,
          text: "alpha",
          timestamp: 100,
          live: false,
        }),
        textMessage({
          id: "bravo-new",
          chatId: BRAVO,
          text: "bravo",
          timestamp: 100,
          live: false,
        }),
      ],
    },
  });

  assert.deepEqual(crossRead, [["bravo-new"]]);

  alpha.close();
  bravo.close();
  await client.close();
});

test("opening reconciles a page/live collision and keeps a backdated live insertion ordered", async () => {
  const base = memoryBackend();
  let pageReady!: () => void;
  const pageStarted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async messages(...args: Parameters<typeof base.data.messages>) {
        const page = await base.data.messages(...args);
        pageReady();
        await pageGate;
        return page;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [
        textMessage({ id: "older", chatId: ALPHA, text: "older", timestamp: 200, live: false }),
        textMessage({ id: "collision", chatId: ALPHA, text: "saved", timestamp: 300, live: false }),
      ],
    },
  });
  const opening = client.chats.open(ALPHA, { pageSize: 2 });
  await pageStarted;
  await driver.emit({
    type: "update",
    update: {
      kind: "edit",
      ref: { id: "collision", chatId: ALPHA, fromMe: false },
      message: textMessage({ id: "ignored", chatId: ALPHA, text: "live edit", timestamp: 999 }),
    },
  });
  await driver.emit({
    type: "message",
    message: textMessage({ id: "late", chatId: ALPHA, text: "late", timestamp: 250 }),
  });
  releasePage();
  const conversation = await opening;

  assert.deepEqual(
    conversation
      .get()
      .messages.map((message) => [message.messageId, message.kind === "text" && message.text]),
    [
      ["collision", "live edit"],
      ["late", "late"],
      ["older", "older"],
    ],
  );

  conversation.close();
  await client.close();
});

test("Client identifier ordering matches the stores' binary ordering", async () => {
  const upperContact = "B@s.whatsapp.net";
  const lowerContact = "a@s.whatsapp.net";
  const upperGroup = "B@g.us";
  const lowerGroup = "a@g.us";
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [
        { id: lowerGroup, isGroup: true, participants: [] },
        { id: upperGroup, isGroup: true, participants: [] },
      ],
      contacts: [
        { id: lowerContact, nativeIds: [lowerContact] },
        { id: upperContact, nativeIds: [upperContact] },
      ],
      messages: [
        textMessage({ id: "B", chatId: ALPHA, text: "upper", timestamp: 100, live: false }),
        textMessage({ id: "a", chatId: ALPHA, text: "lower", timestamp: 100, live: false }),
      ],
    },
  });
  const conversation = await client.chats.open(ALPHA);
  assert.deepEqual(
    client.chats.list().map((chat) => chat.chatId),
    [ALPHA, upperGroup, lowerGroup],
  );
  assert.deepEqual(
    client.contacts.list().map((contact) => contact.contactId),
    [upperContact, lowerContact],
  );
  assert.deepEqual(
    client.groups.list().map((group) => group.groupId),
    [upperGroup, lowerGroup],
  );
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["a", "B"],
  );

  conversation.close();
  await client.close();
});

test("loadOlder joins concurrent reads, preserves state on failure, retries, and exhausts the cursor", async () => {
  const base = memoryBackend();
  const failure = new Error("page failed");
  let reads = 0;
  let failOlder = true;
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async messages(...args: Parameters<typeof base.data.messages>) {
        reads += 1;
        if (reads === 2 && failOlder) {
          await failureGate;
          throw failure;
        }
        return base.data.messages(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2, 3, 4, 5].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 2 });
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m5", "m4"],
  );

  const first = conversation.loadOlder();
  const joined = conversation.loadOlder();
  assert.equal(first, joined);
  releaseFailure();
  await assert.rejects(first, failure);
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m5", "m4"],
  );
  assert.equal(conversation.get().error, failure);
  assert.equal(conversation.get().hasOlderSaved, true);

  failOlder = false;
  await conversation.loadOlder();
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m5", "m4", "m3", "m2"],
  );
  assert.equal(conversation.get().error, undefined);
  assert.equal(conversation.get().hasOlderSaved, true);

  await conversation.loadOlder();
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m5", "m4", "m3", "m2", "m1"],
  );
  assert.equal(conversation.get().hasOlderSaved, false);
  const exhaustedAt = reads;
  await conversation.loadOlder();
  assert.equal(reads, exhaustedAt);

  conversation.close();
  await client.close();
});

test("loadOlder waits for recovery instead of publishing an obsolete generation", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let blockOlder = false;
  let olderReady!: () => void;
  const olderStarted = new Promise<void>((resolve) => {
    olderReady = resolve;
  });
  let releaseOlder!: () => void;
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  let snapshotReads = 0;
  let recoveryReady!: () => void;
  const recoveryStarted = new Promise<void>((resolve) => {
    recoveryReady = resolve;
  });
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        const snapshot = await base.data.snapshot(...args);
        snapshotReads += 1;
        if (snapshotReads === 2) {
          recoveryReady();
          await recoveryGate;
        }
        return snapshot;
      },
      async messages(...args: Parameters<typeof base.data.messages>) {
        const page = await base.data.messages(...args);
        if (blockOlder && args[2]?.before) {
          blockOlder = false;
          olderReady();
          await olderGate;
        }
        return page;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2, 3, 4, 5].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 2 });
  let obsoletePublications = 0;
  conversation.subscribe((state) => {
    if (
      state.messages.some((message) => message.messageId === "m3") &&
      client.chats.get(ALPHA)?.lastMessageAt !== 700
    )
      obsoletePublications += 1;
  });

  blockOlder = true;
  const loading = conversation.loadOlder();
  let loadingSettled = false;
  void loading.then(
    () => {
      loadingSettled = true;
    },
    () => {
      loadingSettled = true;
    },
  );
  await withDeadline(olderStarted);
  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 600,
        event: {
          type: "message",
          message: textMessage({ id: "m6", chatId: ALPHA, text: "m6", timestamp: 600 }),
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m7", chatId: ALPHA, text: "m7", timestamp: 700 }),
  });
  await withDeadline(recoveryStarted);
  releaseOlder();
  try {
    await tick();
    assert.equal(loadingSettled, false);
    assert.equal(obsoletePublications, 0);
    assert.deepEqual(
      conversation.get().messages.map((message) => message.messageId),
      ["m5", "m4"],
    );
  } finally {
    releaseRecovery();
  }
  await withDeadline(loading);

  assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 700);
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m7", "m6", "m5", "m4"],
  );

  conversation.close();
  await client.close();
});

test("loadOlder joins the complete recovery before reading from its committed cursor", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let blockRecoveryWindow = false;
  let recoveryWindowReady!: () => void;
  const recoveryWindowStarted = new Promise<void>((resolve) => {
    recoveryWindowReady = resolve;
  });
  let releaseRecoveryWindow!: () => void;
  const recoveryWindowGate = new Promise<void>((resolve) => {
    releaseRecoveryWindow = resolve;
  });
  let snapshotReads = 0;
  let secondRecoveryReady!: () => void;
  const secondRecoveryStarted = new Promise<void>((resolve) => {
    secondRecoveryReady = resolve;
  });
  let releaseSecondRecovery!: () => void;
  const secondRecoveryGate = new Promise<void>((resolve) => {
    releaseSecondRecovery = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        const snapshot = await base.data.snapshot(...args);
        snapshotReads += 1;
        if (snapshotReads === 3) {
          secondRecoveryReady();
          await secondRecoveryGate;
        }
        return snapshot;
      },
      async messages(...args: Parameters<typeof base.data.messages>) {
        if (blockRecoveryWindow) {
          blockRecoveryWindow = false;
          recoveryWindowReady();
          await recoveryWindowGate;
        }
        return base.data.messages(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2, 3, 4].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 2 });
  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 500,
        event: {
          type: "message",
          message: textMessage({ id: "m5", chatId: ALPHA, text: "m5", timestamp: 500 }),
        },
      },
    ],
    fencingToken,
  );
  blockRecoveryWindow = true;
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m6", chatId: ALPHA, text: "m6", timestamp: 600 }),
  });
  await withDeadline(recoveryWindowStarted);

  const loading = conversation.loadOlder();
  const joined = conversation.loadOlder();
  let loadingSettled = false;
  void loading.then(
    () => {
      loadingSettled = true;
    },
    () => {
      loadingSettled = true;
    },
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m7", chatId: ALPHA, text: "m7", timestamp: 700 }),
  });
  releaseRecoveryWindow();
  await withDeadline(secondRecoveryStarted);
  try {
    await tick();
    assert.equal(joined, loading);
    assert.equal(loadingSettled, false);
    assert.deepEqual(
      conversation.get().messages.map((message) => message.messageId),
      ["m4", "m3"],
    );
  } finally {
    releaseSecondRecovery();
  }
  await withDeadline(loading);

  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m7", "m6", "m5", "m4"],
  );

  conversation.close();
  await client.close();
});

test("a lease-expired Client recovers page reads from its replacement mirror revision", async () => {
  const shared = memoryBackend();
  let oldLeaseExpiresAt = 0;
  let renewalReady!: () => void;
  const renewalStarted = new Promise<void>((resolve) => {
    renewalReady = resolve;
  });
  let releaseRenewal!: () => void;
  const renewalGate = new Promise<void>((resolve) => {
    releaseRenewal = resolve;
  });
  const oldBackend = {
    ...shared,
    leases: {
      ...shared.leases,
      async renew(...args: Parameters<typeof shared.leases.renew>) {
        oldLeaseExpiresAt = args[0].expiresAt;
        renewalReady();
        await renewalGate;
        return shared.leases.renew(...args);
      },
    },
  };
  const oldDriver = createTestWhatsAppSession();
  const oldClient = await openClient(oldBackend, oldDriver, {
    holderId: "old",
    leaseTtlMs: 20,
  });
  let replacementClient: Awaited<ReturnType<typeof openClient>> | undefined;
  let alpha: Awaited<ReturnType<typeof oldClient.chats.open>> | undefined;
  let bravo: Awaited<ReturnType<typeof oldClient.chats.open>> | undefined;
  try {
    await oldDriver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
        chats: [
          { id: ALPHA, isGroup: false, subject: "Alpha old", lastMessageAt: 200 },
          { id: BRAVO, isGroup: false, subject: "Bravo old", lastMessageAt: 100 },
        ],
        contacts: [],
        messages: [
          textMessage({ id: "alpha-old-1", chatId: ALPHA, text: "old 1", timestamp: 100 }),
          textMessage({ id: "alpha-old-2", chatId: ALPHA, text: "old 2", timestamp: 200 }),
          textMessage({ id: "bravo-old", chatId: BRAVO, text: "old", timestamp: 100 }),
        ],
      },
    });
    alpha = await oldClient.chats.open(ALPHA, { pageSize: 1 });
    await oldDriver.emit({ type: "connection", status: { phase: "online" } });
    await oldDriver.emit({ type: "presence", presence: { chatId: ALPHA, kind: "typing" } });
    assert.deepEqual(oldClient.account.get().connection?.status, { phase: "online" });
    assert.deepEqual(alpha.get().presence, [{ chatId: ALPHA, kind: "typing" }]);
    await withDeadline(renewalStarted);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, oldLeaseExpiresAt - Date.now() + 2)),
    );

    const replacementDriver = createTestWhatsAppSession();
    replacementClient = await openClient(shared, replacementDriver, {
      holderId: "replacement",
      leaseTtlMs: 1_000,
    });
    await replacementDriver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "recent", projection: { mode: "upsert" } },
        chats: [
          { id: ALPHA, isGroup: false, subject: "Alpha new", lastMessageAt: 300 },
          { id: BRAVO, isGroup: false, subject: "Bravo new", lastMessageAt: 400 },
        ],
        contacts: [],
        messages: [
          textMessage({ id: "alpha-new", chatId: ALPHA, text: "new", timestamp: 300 }),
          textMessage({ id: "bravo-new", chatId: BRAVO, text: "new", timestamp: 400 }),
        ],
      },
    });
    assert.equal(oldClient.chats.get(ALPHA)?.lastMessageAt, 200);
    assert.equal(oldClient.chats.get(BRAVO)?.lastMessageAt, 100);

    const opening = oldClient.chats.open(BRAVO);
    const loading = alpha.loadOlder();
    const [openedBravo] = await withDeadline(Promise.all([opening, loading]));
    bravo = openedBravo;

    assert.equal(oldClient.chats.get(ALPHA)?.lastMessageAt, 300);
    assert.equal(oldClient.chats.get(BRAVO)?.lastMessageAt, 400);
    assert.deepEqual(alpha.get().chat, oldClient.chats.get(ALPHA));
    assert.deepEqual(
      alpha.get().messages.map((message) => message.messageId),
      ["alpha-new", "alpha-old-2"],
    );
    assert.deepEqual(bravo.get().chat, oldClient.chats.get(BRAVO));
    assert.deepEqual(
      bravo.get().messages.map((message) => message.messageId),
      ["bravo-new", "bravo-old"],
    );
    assert.equal(oldClient.account.get().connection, undefined);
    assert.deepEqual(alpha.get().presence, []);

    const closed = new Promise<void>((resolve) => {
      oldClient.account.subscribe((state) => {
        if (state.closed) resolve();
      });
    });
    releaseRenewal();
    await withDeadline(closed);
  } finally {
    releaseRenewal();
    alpha?.close();
    bravo?.close();
    await oldClient.close().catch(() => {});
    await replacementClient?.close().catch(() => {});
  }
});

test("a revision gap replaces all global Client state from one fresh Runtime snapshot", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [{ id: ALPHA, isGroup: false, subject: "Alpha", lastMessageAt: 100 }],
      contacts: [],
      messages: [],
    },
  });

  // This accepted change reaches the real store but deliberately misses this
  // Client's Runtime feed. The next real Runtime patch therefore exposes a gap.
  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 200,
        event: {
          type: "conversation_sync",
          batch: {
            context: { source: "recent", projection: { mode: "upsert" } },
            chats: [
              {
                id: ROOM,
                isGroup: true,
                subject: "Room",
                participants: [{ id: BRAVO }],
                lastMessageAt: 200,
              },
            ],
            contacts: [{ id: BRAVO, nativeIds: [BRAVO, LID], displayName: "Bravo" }],
            messages: [],
          },
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "after-gap", chatId: ALPHA, text: "after", timestamp: 300 }),
  });
  await tick();

  assert.deepEqual(
    client.chats.list().map((chat) => chat.chatId),
    [ALPHA, ROOM],
  );
  assert.equal(client.contacts.resolve(LID)?.contactId, BRAVO);
  assert.equal(client.groups.get(ROOM)?.subject, "Room");

  await client.close();
});

test("a revision gap re-reads and replaces every opened conversation window", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2, 3, 4].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 4 });
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m4", "m3", "m2", "m1"],
  );

  await base.data.accept(
    ACCOUNT,
    [5, 6].map((number) => ({
      observedAt: number * 100,
      event: {
        type: "message" as const,
        message: textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
        }),
      },
    })),
    fencingToken,
  );
  const replaced = new Promise<void>((resolve) => {
    conversation.subscribe((state) => {
      if (state.messages.map((message) => message.messageId).join(",") === "m7,m6,m5,m4") resolve();
    });
  });
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m7", chatId: ALPHA, text: "m7", timestamp: 700 }),
  });
  await withDeadline(replaced);

  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m7", "m6", "m5", "m4"],
  );

  conversation.close();
  await client.close();
});

test("a revision gap publishes only after every fresh conversation window is ready", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let recovering = false;
  let bravoRecoveryReady!: () => void;
  const bravoRecoveryStarted = new Promise<void>((resolve) => {
    bravoRecoveryReady = resolve;
  });
  let releaseBravoRecovery!: () => void;
  const bravoRecoveryGate = new Promise<void>((resolve) => {
    releaseBravoRecovery = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async messages(...args: Parameters<typeof base.data.messages>) {
        if (recovering && args[1] === BRAVO) {
          bravoRecoveryReady();
          await bravoRecoveryGate;
        }
        return base.data.messages(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [
        textMessage({
          id: "alpha-old",
          chatId: ALPHA,
          text: "alpha old",
          timestamp: 100,
          live: false,
        }),
        textMessage({
          id: "bravo-old",
          chatId: BRAVO,
          text: "bravo old",
          timestamp: 100,
          live: false,
        }),
      ],
    },
  });
  const alpha = await client.chats.open(ALPHA, { pageSize: 2 });
  const bravo = await client.chats.open(BRAVO, { pageSize: 2 });
  let chatNotifications = 0;
  client.chats.subscribe(() => {
    chatNotifications += 1;
  });
  let alphaNotifications = 0;
  let bravoNotifications = 0;
  const crossRead: Array<{
    readonly messages: string[];
    readonly lastMessageAt: number | undefined;
  }> = [];
  let replacementReady!: () => void;
  const replacement = new Promise<void>((resolve) => {
    replacementReady = resolve;
  });
  bravo.subscribe((state) => {
    if (state.messages[0]?.messageId === "bravo-during") bravoNotifications += 1;
  });
  alpha.subscribe((state) => {
    if (state.messages[0]?.messageId !== "alpha-after") return;
    alphaNotifications += 1;
    const bravoMessages = bravo.get().messages.map((message) => message.messageId);
    const bravoLastMessageAt = client.chats.get(BRAVO)?.lastMessageAt;
    crossRead.push({ messages: bravoMessages, lastMessageAt: bravoLastMessageAt });
    if (bravoMessages[0] === "bravo-during" && bravoLastMessageAt === 400) replacementReady();
  });

  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 200,
        event: {
          type: "conversation_sync",
          batch: {
            context: { source: "recent", projection: { mode: "upsert" } },
            chats: [],
            contacts: [],
            messages: [
              textMessage({
                id: "alpha-missed",
                chatId: ALPHA,
                text: "alpha missed",
                timestamp: 200,
                live: false,
              }),
              textMessage({
                id: "bravo-missed",
                chatId: BRAVO,
                text: "bravo missed",
                timestamp: 200,
                live: false,
              }),
            ],
          },
        },
      },
    ],
    fencingToken,
  );
  recovering = true;
  await driver.emit({
    type: "message",
    message: textMessage({ id: "alpha-after", chatId: ALPHA, text: "after", timestamp: 300 }),
  });
  await withDeadline(bravoRecoveryStarted);
  await driver.emit({
    type: "message",
    message: textMessage({ id: "bravo-during", chatId: BRAVO, text: "during", timestamp: 400 }),
  });
  await tick();

  assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 100);
  assert.equal(chatNotifications, 0);
  assert.equal(alphaNotifications, 0);

  releaseBravoRecovery();
  await withDeadline(replacement);
  assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 300);
  assert.equal(client.chats.get(BRAVO)?.lastMessageAt, 400);
  assert.equal(chatNotifications, 1);
  assert.equal(alphaNotifications, 1);
  assert.equal(bravoNotifications, 1);
  assert.deepEqual(crossRead, [
    {
      messages: ["bravo-during", "bravo-missed"],
      lastMessageAt: 400,
    },
  ]);

  alpha.close();
  bravo.close();
  await client.close();
});

test("queued revision gaps publish only the final recovered Client generation", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let snapshotReads = 0;
  let recovering = false;
  let firstWindowReady!: () => void;
  const firstWindowStarted = new Promise<void>((resolve) => {
    firstWindowReady = resolve;
  });
  let releaseFirstWindow!: () => void;
  const firstWindowGate = new Promise<void>((resolve) => {
    releaseFirstWindow = resolve;
  });
  let secondRecoveryReady!: () => void;
  const secondRecoveryStarted = new Promise<void>((resolve) => {
    secondRecoveryReady = resolve;
  });
  let releaseSecondRecovery!: () => void;
  const secondRecoveryGate = new Promise<void>((resolve) => {
    releaseSecondRecovery = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        const snapshot = await base.data.snapshot(...args);
        snapshotReads += 1;
        if (snapshotReads === 3) {
          secondRecoveryReady();
          await secondRecoveryGate;
        }
        return snapshot;
      },
      async messages(...args: Parameters<typeof base.data.messages>) {
        if (recovering) {
          recovering = false;
          firstWindowReady();
          await firstWindowGate;
        }
        return base.data.messages(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m1", chatId: ALPHA, text: "m1", timestamp: 100 }),
  });
  const conversation = await client.chats.open(ALPHA);
  let chatNotifications = 0;
  client.chats.subscribe(() => {
    chatNotifications += 1;
  });
  let conversationNotifications = 0;
  let finalReady!: () => void;
  const finalGeneration = new Promise<void>((resolve) => {
    finalReady = resolve;
  });
  conversation.subscribe((state) => {
    conversationNotifications += 1;
    if (state.messages[0]?.messageId === "m5" && client.chats.get(ALPHA)?.lastMessageAt === 500)
      finalReady();
  });

  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 200,
        event: {
          type: "message",
          message: textMessage({ id: "m2", chatId: ALPHA, text: "m2", timestamp: 200 }),
        },
      },
    ],
    fencingToken,
  );
  recovering = true;
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m3", chatId: ALPHA, text: "m3", timestamp: 300 }),
  });
  await withDeadline(firstWindowStarted);
  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 400,
        event: {
          type: "message",
          message: textMessage({ id: "m4", chatId: ALPHA, text: "m4", timestamp: 400 }),
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m5", chatId: ALPHA, text: "m5", timestamp: 500 }),
  });
  releaseFirstWindow();
  await withDeadline(secondRecoveryStarted);
  try {
    await tick();
    assert.equal(chatNotifications, 0);
    assert.equal(conversationNotifications, 0);
    assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 100);
    assert.deepEqual(
      conversation.get().messages.map((message) => message.messageId),
      ["m1"],
    );
  } finally {
    releaseSecondRecovery();
  }
  await withDeadline(finalGeneration);

  assert.equal(chatNotifications, 1);
  assert.equal(conversationNotifications, 1);
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m5", "m4", "m3", "m2", "m1"],
  );

  conversation.close();
  await client.close();
});

test("Runtime termination preempts blocked recovery and preserves the last coherent state", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let snapshotReads = 0;
  let recoveryReady!: () => void;
  const recoveryStarted = new Promise<void>((resolve) => {
    recoveryReady = resolve;
  });
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        const snapshot = await base.data.snapshot(...args);
        snapshotReads += 1;
        if (snapshotReads === 2) {
          recoveryReady();
          await recoveryGate;
        }
        return snapshot;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "message",
    message: textMessage({ id: "coherent", chatId: ALPHA, text: "old", timestamp: 100 }),
  });
  const conversation = await client.chats.open(ALPHA);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  await driver.emit({ type: "presence", presence: { chatId: ALPHA, kind: "typing" } });

  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 200,
        event: {
          type: "message",
          message: textMessage({ id: "missed", chatId: ALPHA, text: "missed", timestamp: 200 }),
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "after-gap", chatId: ALPHA, text: "new", timestamp: 300 }),
  });
  await withDeadline(recoveryStarted);

  const closed = new Promise<void>((resolve) => {
    client.account.subscribe((state) => {
      if (state.closed) resolve();
    });
  });
  try {
    await driver.session.stop?.();
    await withDeadline(closed);
    assert.deepEqual(client.account.get().closed, {});
    assert.equal(client.account.get().connection, undefined);
    assert.deepEqual(conversation.get().presence, []);
  } finally {
    releaseRecovery();
  }
  await tick();

  assert.deepEqual(client.account.get().closed, {});
  assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 100);
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["coherent"],
  );

  conversation.close();
  await client.close();
});

test("Runtime termination rejects a blocked conversation open without changing durable state", async () => {
  const base = memoryBackend();
  let pageReady!: () => void;
  const pageStarted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async messages(...args: Parameters<typeof base.data.messages>) {
        const page = await base.data.messages(...args);
        pageReady();
        await pageGate;
        return page;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "message",
    message: textMessage({ id: "coherent", chatId: ALPHA, text: "old", timestamp: 100 }),
  });
  const opening = client.chats.open(ALPHA);
  await pageStarted;

  try {
    await driver.session.stop?.();
    await assert.rejects(withDeadline(opening), WhatsAppClientClosedError);
  } finally {
    releasePage();
  }
  assert.deepEqual(client.account.get().closed, {});
  assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 100);

  await client.close();
});

test("Runtime termination rejects conversation operations waiting on blocked recovery", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let snapshotReads = 0;
  let recoveryReady!: () => void;
  const recoveryStarted = new Promise<void>((resolve) => {
    recoveryReady = resolve;
  });
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        const snapshot = await base.data.snapshot(...args);
        snapshotReads += 1;
        if (snapshotReads === 2) {
          recoveryReady();
          await recoveryGate;
        }
        return snapshot;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 1 });
  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 200,
        event: {
          type: "message",
          message: textMessage({ id: "missed", chatId: ALPHA, text: "missed", timestamp: 300 }),
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "after-gap", chatId: BRAVO, text: "new", timestamp: 400 }),
  });
  await withDeadline(recoveryStarted);

  const opening = client.chats.open(ALPHA);
  const loading = conversation.loadOlder();
  await tick();
  try {
    await driver.session.stop?.();
    await Promise.all([
      assert.rejects(withDeadline(opening), WhatsAppClientClosedError),
      assert.rejects(withDeadline(loading), WhatsAppClientClosedError),
    ]);
  } finally {
    releaseRecovery();
  }
  assert.deepEqual(client.account.get().closed, {});

  conversation.close();
  await client.close();
});

test("a conversation opened during recovery resolves in the recovered Client generation", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let recovering = false;
  let recoveryWindowReady!: () => void;
  const recoveryWindowStarted = new Promise<void>((resolve) => {
    recoveryWindowReady = resolve;
  });
  let releaseRecoveryWindow!: () => void;
  const recoveryWindowGate = new Promise<void>((resolve) => {
    releaseRecoveryWindow = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async messages(...args: Parameters<typeof base.data.messages>) {
        const page = await base.data.messages(...args);
        if (recovering && args[1] === BRAVO) {
          recoveryWindowReady();
          await recoveryWindowGate;
        }
        return page;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [
        { id: ALPHA, isGroup: false, subject: "Old", lastMessageAt: 100 },
        { id: BRAVO, isGroup: false, subject: "Bravo", lastMessageAt: 100 },
      ],
      contacts: [],
      messages: [
        textMessage({ id: "old", chatId: ALPHA, text: "old", timestamp: 100, live: false }),
        textMessage({ id: "bravo", chatId: BRAVO, text: "bravo", timestamp: 100, live: false }),
      ],
    },
  });
  const bravo = await client.chats.open(BRAVO);

  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 200,
        event: {
          type: "conversation_sync",
          batch: {
            context: { source: "recent", projection: { mode: "upsert" } },
            chats: [{ id: ALPHA, isGroup: false, subject: "Recovered", lastMessageAt: 200 }],
            contacts: [],
            messages: [
              textMessage({
                id: "recovered",
                chatId: ALPHA,
                text: "recovered",
                timestamp: 200,
                live: false,
              }),
            ],
          },
        },
      },
    ],
    fencingToken,
  );
  recovering = true;
  await driver.emit({
    type: "message",
    message: textMessage({ id: "after-gap", chatId: BRAVO, text: "new", timestamp: 300 }),
  });
  await withDeadline(recoveryWindowStarted);

  const opening = client.chats.open(ALPHA);
  let opened = false;
  void opening.then(() => {
    opened = true;
  });
  await tick();
  assert.equal(opened, false);
  releaseRecoveryWindow();
  const alpha = await withDeadline(opening);

  assert.deepEqual(alpha.get().chat, client.chats.get(ALPHA));
  assert.equal(alpha.get().chat?.subject, "Recovered");
  assert.deepEqual(
    alpha.get().messages.map((message) => message.messageId),
    ["recovered", "old"],
  );

  alpha.close();
  bravo.close();
  await client.close();
});

test("a revision gap racing the first page read leaves only the fresh replacement window", async () => {
  const base = memoryBackend();
  let fencingToken = 0;
  let firstPageReady!: () => void;
  const firstPageStarted = new Promise<void>((resolve) => {
    firstPageReady = resolve;
  });
  let releaseFirstPage!: () => void;
  const firstPageGate = new Promise<void>((resolve) => {
    releaseFirstPage = resolve;
  });
  let pageReads = 0;
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async messages(...args: Parameters<typeof base.data.messages>) {
        const page = await base.data.messages(...args);
        pageReads += 1;
        if (pageReads === 1) {
          firstPageReady();
          await firstPageGate;
        }
        return page;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const opening = client.chats.open(ALPHA, { pageSize: 2 });
  await firstPageStarted;

  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 300,
        event: {
          type: "message",
          message: textMessage({ id: "m3", chatId: ALPHA, text: "m3", timestamp: 300 }),
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m4", chatId: ALPHA, text: "m4", timestamp: 400 }),
  });
  await tick();
  releaseFirstPage();

  const conversation = await withDeadline(opening);
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m4", "m3"],
  );

  conversation.close();
  await client.close();
});

test("a failed gap read closes that Client and a fresh owned Client retries hydration", async () => {
  const base = memoryBackend();
  const failure = new Error("recovery snapshot failed");
  let fencingToken = 0;
  let snapshotReads = 0;
  const backend = {
    ...base,
    data: {
      ...base.data,
      async accept(...args: Parameters<typeof base.data.accept>) {
        fencingToken = args[2];
        return base.data.accept(...args);
      },
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        snapshotReads += 1;
        if (snapshotReads === 2) throw failure;
        return base.data.snapshot(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [{ id: ALPHA, isGroup: false, subject: "Alpha" }],
      contacts: [],
      messages: [],
    },
  });
  const failed = new Promise<void>((resolve) => {
    client.account.subscribe((state) => {
      if (state.closed?.error === failure) resolve();
    });
  });

  await base.data.accept(
    ACCOUNT,
    [
      {
        observedAt: 100,
        event: {
          type: "message",
          message: textMessage({ id: "m1", chatId: ALPHA, text: "one", timestamp: 100 }),
        },
      },
    ],
    fencingToken,
  );
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m2", chatId: ALPHA, text: "two", timestamp: 200 }),
  });
  await withDeadline(failed);

  assert.throws(
    () => client.chats.list(),
    (error) => error instanceof WhatsAppClientClosedError && error.cause === failure,
  );
  await client.close();

  const replacementDriver = createTestWhatsAppSession();
  const replacement = await openClient({ ...base }, replacementDriver);
  const conversation = await replacement.chats.open(ALPHA);
  assert.deepEqual(
    conversation.get().messages.map((message) => message.messageId),
    ["m2", "m1"],
  );

  conversation.close();
  await replacement.close();
});

test("a connection frame that expires during hydration is never exposed as current", async () => {
  const base = memoryBackend();
  let snapshotReady!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    snapshotReady = resolve;
  });
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const backend = {
    ...base,
    data: {
      ...base.data,
      async snapshot(...args: Parameters<typeof base.data.snapshot>) {
        const snapshot = await base.data.snapshot(...args);
        snapshotReady();
        await snapshotGate;
        return snapshot;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const creating = createWhatsAppClient({
    accountId: ACCOUNT,
    openBackend: () => backend,
    freshnessMs: 5,
    openSession: () => driver.session,
  });
  await snapshotStarted;
  await driver.emit({ type: "connection", status: { phase: "online" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSnapshot();

  const client = await creating;
  assert.equal(client.account.get().connection, undefined);

  await client.close();
});

test("identity and live state are sampled, replaced, expired, and never hydrated after restart", async () => {
  const backend = memoryBackend();
  const identity = {
    jid: "233200000000:1@s.whatsapp.net",
    pushName: "Personal",
    phoneE164: "+233200000000",
  };
  const driver = createTestWhatsAppSession({ identity });
  const client = await openClient(backend, driver, { freshnessMs: 25 });
  const conversation = await client.chats.open(ALPHA);
  assert.deepEqual(client.account.get().identity, identity);

  await driver.emit({ type: "connection", status: { phase: "online" } });
  await driver.emit({ type: "presence", presence: { chatId: ALPHA, kind: "typing" } });
  assert.deepEqual(client.account.get().connection?.status, { phase: "online" });
  assert.deepEqual(conversation.get().presence, [{ chatId: ALPHA, kind: "typing" }]);

  await driver.emit({ type: "presence", presence: { chatId: ALPHA, kind: "recording" } });
  assert.deepEqual(conversation.get().presence, [{ chatId: ALPHA, kind: "recording" }]);
  await driver.emit({ type: "presence", presence: { chatId: ALPHA, kind: "unavailable" } });
  assert.deepEqual(conversation.get().presence, []);

  const presenceExpired = new Promise<void>((resolve) => {
    conversation.subscribe((state) => {
      if (state.presence.length === 0) resolve();
    });
  });
  const connectionExpired = new Promise<void>((resolve) => {
    client.account.subscribe((state) => {
      if (!state.connection) resolve();
    });
  });
  await driver.emit({ type: "presence", presence: { chatId: ALPHA, kind: "typing" } });
  await withDeadline(Promise.all([presenceExpired, connectionExpired]));
  assert.equal(client.account.get().connection, undefined);
  assert.deepEqual(conversation.get().presence, []);

  conversation.close();
  await client.close();

  const replacementDriver = createTestWhatsAppSession();
  const replacement = await openClient({ ...backend }, replacementDriver);
  const reopened = await replacement.chats.open(ALPHA);
  assert.equal(replacement.account.get().connection, undefined);
  assert.equal(replacement.account.get().identity, undefined);
  assert.deepEqual(reopened.get().presence, []);

  reopened.close();
  await replacement.close();
});

test("close and AbortSignal cancel every owned Client resource", async () => {
  const base = memoryBackend();
  let pageReads = 0;
  let olderStarted!: () => void;
  const olderReadStarted = new Promise<void>((resolve) => {
    olderStarted = resolve;
  });
  const never = new Promise<never>(() => {});
  const backend = {
    ...base,
    data: {
      ...base.data,
      async messages(...args: Parameters<typeof base.data.messages>) {
        pageReads += 1;
        if (pageReads === 2) {
          olderStarted();
          return never;
        }
        return base.data.messages(...args);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const client = await openClient(backend, driver);
  await driver.emit({
    type: "conversation_sync",
    batch: {
      context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
      chats: [],
      contacts: [],
      messages: [1, 2].map((number) =>
        textMessage({
          id: `m${number}`,
          chatId: ALPHA,
          text: `m${number}`,
          timestamp: number * 100,
          live: false,
        }),
      ),
    },
  });
  const conversation = await client.chats.open(ALPHA, { pageSize: 1 });
  const clientLifetime = new AbortController();
  client.account.subscribe(() => {}, { signal: clientLifetime.signal });
  client.chats.subscribe(() => {}, { signal: clientLifetime.signal });
  client.contacts.subscribe(() => {}, { signal: clientLifetime.signal });
  client.groups.subscribe(() => {}, { signal: clientLifetime.signal });
  assert.equal(getEventListeners(clientLifetime.signal, "abort").length, 4);
  const conversationLifetime = new AbortController();
  conversation.subscribe(() => {}, { signal: conversationLifetime.signal });
  assert.equal(getEventListeners(conversationLifetime.signal, "abort").length, 1);

  const controller = new AbortController();
  let notified = 0;
  client.chats.subscribe(
    () => {
      notified += 1;
    },
    { signal: controller.signal },
  );
  controller.abort();
  await driver.emit({
    type: "message",
    message: textMessage({ id: "after-abort", chatId: BRAVO, text: "ignored", timestamp: 300 }),
  });
  assert.equal(notified, 0);

  const loading = conversation.loadOlder();
  await olderReadStarted;
  conversation.close();
  assert.equal(getEventListeners(conversationLifetime.signal, "abort").length, 0);
  await assert.rejects(loading, WhatsAppClientClosedError);
  assert.throws(() => conversation.get(), WhatsAppClientClosedError);
  assert.throws(() => conversation.subscribe(() => {}), WhatsAppClientClosedError);
  await assert.rejects(conversation.loadOlder(), WhatsAppClientClosedError);

  await client.close();
  assert.equal(getEventListeners(clientLifetime.signal, "abort").length, 0);
  assert.throws(() => client.chats.list(), WhatsAppClientClosedError);
  assert.throws(() => client.contacts.get(ALPHA), WhatsAppClientClosedError);
  await assert.rejects(client.chats.open(ALPHA), WhatsAppClientClosedError);
});

test("listener failures are isolated and Runtime closure becomes account state", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession({
    identity: { jid: "233200000000:1@s.whatsapp.net" },
  });
  const client = await openClient(backend, driver);
  const listenerFailure = new Error("application listener failed");
  let laterListener = 0;
  let deferredThrow: (() => void) | undefined;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (callback): void => {
    deferredThrow = callback;
  };
  try {
    client.chats.subscribe(() => {
      throw listenerFailure;
    });
    client.chats.subscribe(() => {
      laterListener += 1;
    });
    await driver.emit({
      type: "message",
      message: textMessage({ id: "visible", chatId: ALPHA, text: "visible", timestamp: 100 }),
    });
  } finally {
    globalThis.queueMicrotask = originalQueueMicrotask;
  }
  assert.equal(laterListener, 1);
  assert.equal(client.chats.get(ALPHA)?.lastMessageAt, 100);
  assert.ok(deferredThrow);
  assert.throws(deferredThrow, (error) => error === listenerFailure);

  const closed = new Promise<void>((resolve) => {
    client.account.subscribe((state) => {
      if (state.closed) resolve();
    });
  });
  await driver.session.stop?.();
  await withDeadline(closed);
  assert.deepEqual(client.account.get().closed, {});
  assert.equal(client.account.get().connection, undefined);
  assert.equal(client.account.get().identity, undefined);

  await client.close();
});
