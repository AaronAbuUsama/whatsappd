/**
 * The hydrated Client core over a real runtime.
 *
 * Every assertion reads the public path: a runtime created by
 * `createWhatsAppRuntime()`, driven by the deterministic session, observed
 * through the source-module `createWhatsAppClient()`. No SQL, no harness, no
 * sleeps — the deterministic clock is Node's own test-runner mock.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { expect, test } from "./_expect.ts";
import type {
  AccountLeaseStore,
  ChatRecord,
  ContactRecord,
  GroupRecord,
  WhatsAppBackend,
} from "../src/runtime/contracts.ts";
import { memoryBackend } from "../src/runtime/memory.ts";
import {
  createWhatsAppRuntime,
  type RuntimeSession,
  type WhatsAppRuntime,
} from "../src/runtime/runtime.ts";
import { createWhatsAppClient, type WhatsAppClientCore } from "../src/runtime/client.ts";
import type { InboundMessage } from "../src/model/message.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";

const PERSON = "person@s.whatsapp.net";
const PERSON_LID = "77701@lid";
const ROOM = "room@g.us";
const SELF = "15551230000@s.whatsapp.net";
const AT = 1_700_000_000_000;

/**
 * Two identifiers whose binary order is the reverse of their locale order.
 *
 * @remarks
 * `"Z" < "a"` by code unit and `"apple" < "Zed"` by `localeCompare`, so a list
 * asserted in this order fails red the moment an identifier comparison stops
 * being binary. Asserted directly in the ordering test rather than assumed.
 */
const UPPER = "Zed";
const LOWER = "apple";

/** Let queued microtasks and one macrotask turn drain — never a timed wait. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Turn the event loop until `done` holds, then return.
 *
 * @remarks
 * Bounded by turns rather than by wall clock, so it neither sleeps nor passes
 * because a machine was slow. It throws when the condition never arrives, which
 * is what makes a test asserting after it fail red rather than hang.
 */
async function until(done: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (done()) return;
    await tick();
  }
  assert.fail(`condition did not hold within ${turns} event-loop turns`);
}

/**
 * Collect what the process surfaced while `work` ran.
 *
 * @remarks
 * `process.on("warning")` and nothing else — the same environment a worker runs
 * in. A harness that installed an uncaught-exception capture would be proving
 * isolation the production path does not have.
 */
async function surfaced(work: () => Promise<void>): Promise<unknown[]> {
  const warnings: unknown[] = [];
  const collect = (warning: unknown): void => void warnings.push(warning);
  process.on("warning", collect);
  try {
    await work();
    await tick();
  } finally {
    process.off("warning", collect);
  }
  return warnings;
}

/** A lease store whose fencing token this test moves deliberately. */
function movableLeaseStore(): AccountLeaseStore & { replace(): void } {
  let fencingToken = 1;
  return {
    replace() {
      fencingToken += 1;
    },
    async acquire(accountId, holderId, ttlMs) {
      return {
        acquired: true,
        lease: { accountId, holderId, fencingToken, expiresAt: Date.now() + ttlMs },
      };
    },
    async renew(lease, ttlMs) {
      return {
        renewed: true,
        lease: { ...lease, fencingToken, expiresAt: Date.now() + ttlMs },
      };
    },
    async release() {
      return true;
    },
  };
}

interface Lane {
  readonly driver: ReturnType<typeof createTestWhatsAppSession>;
  readonly backend: WhatsAppBackend;
  readonly runtime: WhatsAppRuntime;
  readonly client: WhatsAppClientCore;
  stop(): Promise<void>;
}

/** One started account worker and its hydrated client. */
async function lane(
  options: {
    accountId?: string;
    backend?: WhatsAppBackend;
    freshnessMs?: number;
    leaseTtlMs?: number;
    identity?: { readonly jid: string; readonly pushName?: string };
    before?: (runtime: WhatsAppRuntime, backend: WhatsAppBackend) => Promise<void>;
  } = {},
): Promise<Lane> {
  const accountId = options.accountId ?? "personal";
  const backend = options.backend ?? memoryBackend();
  const driver = createTestWhatsAppSession(
    options.identity ? { identity: options.identity } : undefined,
  );
  const runtime = createWhatsAppRuntime({
    accountId,
    backend,
    openSession: () => driver.session,
    ...(options.freshnessMs !== undefined && { freshnessMs: options.freshnessMs }),
    ...(options.leaseTtlMs !== undefined && { leaseTtlMs: options.leaseTtlMs }),
  });
  await runtime.start();
  await options.before?.(runtime, backend);
  const client = await createWhatsAppClient(runtime);
  return {
    driver,
    backend,
    runtime,
    client,
    async stop() {
      await client.close();
      await runtime.stop().catch(() => {});
    },
  };
}

const chatIds = (chats: readonly ChatRecord[]): string[] => chats.map((chat) => chat.chatId);
const contactIds = (contacts: readonly ContactRecord[]): string[] =>
  contacts.map((contact) => contact.contactId);
const groupIds = (groups: readonly GroupRecord[]): string[] => groups.map((group) => group.groupId);

const imageMessage = (id: string, chatId: string): InboundMessage => ({
  id,
  chatId,
  sender: { id: chatId, mode: "pn" },
  fromMe: false,
  timestamp: AT + 1,
  live: true,
  isGroup: false,
  kind: "image",
  media: {
    mimetype: "image/png",
    fileLength: 3,
    width: 1,
    height: 1,
    caption: "look",
    download: async () => Buffer.from([1, 2, 3]),
  },
});

// ── 1. Awaited creation is already hydrated ───────────────────────────────

test("awaited creation returns account, chat, contact and group state already applied", async () => {
  const worker = await lane({
    identity: { jid: `${SELF.split("@")[0]}:7@s.whatsapp.net`, pushName: "Me" },
  });
  try {
    // Everything below is committed before the factory is awaited, by driving
    // the session on a runtime the client has not been created over yet.
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "Hello", timestamp: AT }),
    });
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON], displayName: "Person" },
    });
    await worker.driver.emit({
      type: "group",
      group: {
        kind: "metadata",
        id: ROOM,
        subject: "Room",
        participants: [{ id: PERSON }],
        at: AT,
      },
    });

    // A second client, created after all of that, must be hydrated on arrival.
    const fresh = await createWhatsAppClient(worker.runtime);
    try {
      expect(fresh.account.get().accountId).toBe("personal");
      expect(typeof fresh.account.get().lastConnectedAt).toBe("number");
      // The group's rename projected its chat summary too, with no activity on
      // it yet, so it sorts below the chat a message reached.
      expect(chatIds(fresh.chats.list())).toEqual([PERSON, ROOM]);
      expect(contactIds(fresh.contacts.list())).toEqual([PERSON]);
      expect(groupIds(fresh.groups.list())).toEqual([ROOM]);
      expect(fresh.contacts.resolve(PERSON)?.displayName).toBe("Person");
    } finally {
      await fresh.close();
    }
  } finally {
    await worker.stop();
  }
});

test("a client is only creatable over a runtime this module produced", async () => {
  // The private source is reachable only through the registration
  // `createWhatsAppRuntime()` makes, so a look-alike is not a runtime. Matched
  // on the message, not merely on `TypeError`: dereferencing a missing source
  // also throws `TypeError`, so the bare type would pass with no guard at all.
  await assert.rejects(
    createWhatsAppClient({ accountId: "personal" } as unknown as WhatsAppRuntime),
    /createWhatsAppRuntime/,
  );
});

// ── 2. One commit, one notification phase, only affected namespaces ────────

test("one patch changes every affected namespace in one commit and one delivery", async () => {
  const worker = await lane();
  try {
    const seen: Record<string, number> = { account: 0, chats: 0, contacts: 0, groups: 0 };
    /** What each listener could read at the instant it ran. */
    const observed: Array<{ chats: string[]; contacts: string[]; groups: string[] }> = [];
    const record = (namespace: string) => (): void => {
      seen[namespace] = (seen[namespace] ?? 0) + 1;
      observed.push({
        chats: chatIds(worker.client.chats.list()),
        contacts: contactIds(worker.client.contacts.list()),
        groups: groupIds(worker.client.groups.list()),
      });
    };
    const off = [
      worker.client.account.subscribe(record("account")),
      worker.client.chats.subscribe(record("chats")),
      worker.client.contacts.subscribe(record("contacts")),
      worker.client.groups.subscribe(record("groups")),
    ];

    // One conversation-sync batch: a group chat, a contact, and a message —
    // three namespaces changed by one accepted event, so one patch.
    await worker.driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
        chats: [{ id: ROOM, isGroup: true, subject: "Room", lastMessageAt: AT }],
        contacts: [{ id: PERSON, nativeIds: [PERSON], displayName: "Person" }],
        messages: [
          {
            ...textMessage({ id: "s1", chatId: ROOM, text: "hi", sender: PERSON, timestamp: AT }),
            live: false,
          },
        ],
      },
    });
    await tick();

    expect(seen.chats).toBe(1);
    expect(seen.contacts).toBe(1);
    expect(seen.groups).toBe(1);
    // An unaffected namespace is not notified: the commit accumulates what it
    // touched rather than waking everything.
    expect(seen.account).toBe(0);

    const final = {
      chats: chatIds(worker.client.chats.list()),
      contacts: contactIds(worker.client.contacts.list()),
      groups: groupIds(worker.client.groups.list()),
    };
    expect(final.chats).toEqual([ROOM]);
    expect(final.contacts).toEqual([PERSON]);
    expect(final.groups).toEqual([ROOM]);
    // Every listener in the delivery saw the finished transition, not a
    // partially applied one.
    expect(observed.length).toBe(3);
    for (const view of observed) expect(view).toEqual(final);

    for (const stop of off) stop();
  } finally {
    await worker.stop();
  }
});

test("every kind of change announces itself to the namespace that holds it", async () => {
  // One assertion per writer. Before these, four of them — the account record,
  // an alias, a live connection, and the wholesale replace — could stop
  // announcing without a single test noticing.
  const backend: WhatsAppBackend = { ...memoryBackend(), leases: movableLeaseStore() };
  const worker = await lane({ backend, freshnessMs: 600_000 });
  try {
    const seen: Record<string, number> = { account: 0, chats: 0, contacts: 0, groups: 0 };
    for (const namespace of ["account", "chats", "contacts", "groups"] as const)
      worker.client[namespace].subscribe(() => void (seen[namespace] += 1));

    // The account record: a connection instant is durable account state.
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await tick();
    expect(seen.account > 0).toBe(true);
    expect(worker.client.account.get().connection?.phase).toBe("online");
    const afterConnection = seen.account;

    // A chat.
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "hi", timestamp: AT }),
    });
    await tick();
    expect(seen.chats).toBe(1);

    // A contact, and the aliases that come with it.
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON, PERSON_LID], displayName: "Person" },
    });
    await tick();
    expect(seen.contacts > 0).toBe(true);
    expect(worker.client.contacts.resolve(PERSON_LID)?.contactId).toBe(PERSON);

    // A group.
    await worker.driver.emit({
      type: "group",
      group: { kind: "metadata", id: ROOM, subject: "Room", participants: [], at: AT },
    });
    await tick();
    expect(seen.groups).toBe(1);

    // Live presence lands on the namespace that answers for addresses — twice,
    // because one observation is both a live fact and a durable last-seen
    // instant, and they are separate transitions (ADR-0020).
    const beforePresence = seen.contacts;
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();
    expect(seen.contacts > beforePresence).toBe(true);
    expect(worker.client.contacts.presence(PERSON)).toBe("typing");
    expect(typeof worker.client.contacts.resolve(PERSON)?.lastSeenAt).toBe("number");
    expect(afterConnection > 0).toBe(true);
  } finally {
    await worker.stop();
  }
});

// ── 3. The five listener rules ────────────────────────────────────────────

test("listener rules hold across subscribe, unsubscribe and throw during fanout", async () => {
  const worker = await lane();
  try {
    const calls: Record<string, number> = {
      first: 0,
      victim: 0,
      selfish: 0,
      late: 0,
      thrower: 0,
      survivor: 0,
    };
    const bump = (name: string) => (): void => {
      calls[name] = (calls[name] ?? 0) + 1;
    };

    let offVictim: (() => void) | undefined;
    let offSelfish: (() => void) | undefined;
    let offLate: (() => void) | undefined;

    // Registered first, so it runs before the listeners it manipulates.
    const offFirst = worker.client.chats.subscribe(() => {
      calls.first = (calls.first ?? 0) + 1;
      // Rule 3, the hard half: removing a *different* listener during fanout
      // takes effect on the delivery already in flight.
      offVictim?.();
      // Rule 2: a registration made during fanout starts on the next delivery.
      offLate = worker.client.chats.subscribe(bump("late"));
    });
    offVictim = worker.client.chats.subscribe(bump("victim"));
    offSelfish = worker.client.chats.subscribe(() => {
      calls.selfish = (calls.selfish ?? 0) + 1;
      // Rule 3, the self half.
      offSelfish?.();
    });
    const offThrower = worker.client.chats.subscribe(() => {
      calls.thrower = (calls.thrower ?? 0) + 1;
      throw new Error("listener exploded");
    });
    const offSurvivor = worker.client.chats.subscribe(bump("survivor"));

    const warnings = await surfaced(async () => {
      await worker.driver.emit({
        type: "message",
        message: textMessage({ id: "m1", chatId: PERSON, text: "one", timestamp: AT }),
      });
      await tick();
    });

    expect(calls.first).toBe(1);
    expect(calls.victim).toBe(0);
    expect(calls.selfish).toBe(1);
    expect(calls.late).toBe(0);
    // Rule 4: a thrower does not stop its siblings…
    expect(calls.thrower).toBe(1);
    expect(calls.survivor).toBe(1);
    // …and it is surfaced asynchronously rather than swallowed.
    expect(
      warnings.some(
        (warning) => warning instanceof Error && warning.message === "listener exploded",
      ),
    ).toBe(true);

    // Second delivery: the late registration is live, the removed ones are not,
    // and the thrower is still subscribed.
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m2", chatId: PERSON, text: "two", timestamp: AT + 1 }),
    });
    await tick();

    expect(calls.late).toBe(1);
    expect(calls.victim).toBe(0);
    expect(calls.selfish).toBe(1);
    // Rule 4: still subscribed after throwing.
    expect(calls.thrower).toBe(2);
    expect(calls.survivor).toBe(2);
    expect(calls.first).toBe(2);

    offFirst();
    offThrower();
    offSurvivor();
    offLate?.();
  } finally {
    await worker.stop();
  }
});

test("the listener rules hold across namespaces, not just within one", async () => {
  const worker = await lane();
  try {
    const calls: Record<string, number> = { chats: 0, lateGroup: 0, doomedGroup: 0, groups: 0 };
    let offLateGroup: (() => void) | undefined;
    let offDoomedGroup: (() => void) | undefined;

    // Membership is snapshotted for the whole delivery, not per namespace: a
    // listener reached early must not be able to add one to a namespace this
    // same transition is about to reach, nor keep a doomed one alive there.
    const offChats = worker.client.chats.subscribe(() => {
      calls.chats = (calls.chats ?? 0) + 1;
      offDoomedGroup?.();
      offLateGroup = worker.client.groups.subscribe(() => {
        calls.lateGroup = (calls.lateGroup ?? 0) + 1;
      });
    });
    offDoomedGroup = worker.client.groups.subscribe(() => {
      calls.doomedGroup = (calls.doomedGroup ?? 0) + 1;
    });
    const offGroups = worker.client.groups.subscribe(() => {
      calls.groups = (calls.groups ?? 0) + 1;
    });

    // One conversation-sync batch touches chats and groups together, so both
    // namespaces are delivered inside one transition.
    await worker.driver.emit({
      type: "conversation_sync",
      batch: {
        context: { source: "initial_bootstrap", projection: { mode: "upsert" } },
        chats: [{ id: ROOM, isGroup: true, subject: "Room", lastMessageAt: AT }],
        contacts: [],
        messages: [],
      },
    });
    await tick();

    expect(calls.chats).toBe(1);
    expect(calls.groups).toBe(1);
    // Subscribed during this delivery, to a namespace it had not reached yet.
    expect(calls.lateGroup).toBe(0);
    // Unsubscribed during this delivery, from a namespace it had not reached.
    expect(calls.doomedGroup).toBe(0);

    await worker.driver.emit({
      type: "group",
      group: { kind: "metadata", id: ROOM, subject: "Renamed", at: AT + 1 },
    });
    await tick();

    expect(calls.lateGroup).toBe(1);
    expect(calls.doomedGroup).toBe(0);
    expect(calls.groups).toBe(2);

    offChats();
    offGroups();
    offLateGroup?.();
  } finally {
    await worker.stop();
  }
});

test("a subscription is released by its abort signal", async () => {
  const worker = await lane();
  try {
    let calls = 0;
    const controller = new AbortController();
    worker.client.chats.subscribe(() => void (calls += 1), { signal: controller.signal });

    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "one", timestamp: AT }),
    });
    await tick();
    expect(calls).toBe(1);

    controller.abort();
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m2", chatId: PERSON, text: "two", timestamp: AT + 1 }),
    });
    await tick();
    expect(calls).toBe(1);

    // A signal that was already aborted subscribes nothing at all. Registering
    // and then listening for an `abort` that has already fired would leave the
    // listener subscribed for the client's whole life.
    let afterAbort = 0;
    const off = worker.client.chats.subscribe(() => void (afterAbort += 1), {
      signal: controller.signal,
    });
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m3", chatId: PERSON, text: "three", timestamp: AT + 2 }),
    });
    await tick();
    expect(afterAbort).toBe(0);
    // …and its unsubscribe is still callable and still a no-op.
    off();
    off();
  } finally {
    await worker.stop();
  }
});

test("closing the client releases its subscriptions and stops following", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    let chatDeliveries = 0;
    let contactDeliveries = 0;
    worker.client.chats.subscribe(() => void (chatDeliveries += 1));
    worker.client.contacts.subscribe(() => void (contactDeliveries += 1));

    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "one", timestamp: AT }),
    });
    await tick();
    expect(chatDeliveries).toBe(1);
    expect(contactDeliveries).toBe(1);
    expect(worker.client.contacts.presence(PERSON)).toBe("typing");
    const chatsAtClose = chatDeliveries;
    const contactsAtClose = contactDeliveries;

    await worker.client.close();
    // Idempotent, and the second call joins rather than starting a second stop.
    await Promise.all([worker.client.close(), worker.client.close()]);

    // Both channels are detached: a durable frame and a live frame after close
    // reach nothing, and no live state is reported as current any more.
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m2", chatId: PERSON, text: "two", timestamp: AT + 1 }),
    });
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "recording" } });
    for (let turn = 0; turn < 5; turn += 1) await tick();

    expect(chatDeliveries).toBe(chatsAtClose);
    expect(contactDeliveries).toBe(contactsAtClose);
    expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
  } finally {
    await worker.runtime.stop().catch(() => {});
  }
});

// ── 4. Every record kind master already supports ──────────────────────────

test("every durable record kind master supports reaches the core state", async () => {
  const worker = await lane();
  try {
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    // A media message, so the fixture is not text-only.
    await worker.driver.emit({ type: "message", message: imageMessage("i1", PERSON) });
    await worker.driver.emit({
      type: "message",
      message: {
        id: "l1",
        chatId: PERSON,
        sender: { id: PERSON, mode: "pn" },
        fromMe: false,
        timestamp: AT + 2,
        live: true,
        isGroup: false,
        kind: "location",
        lat: 51.5,
        lng: -0.1,
        name: "Bridge",
      },
    });
    await worker.driver.emit({
      type: "message",
      message: {
        id: "p1",
        chatId: ROOM,
        sender: { id: PERSON, mode: "pn" },
        fromMe: false,
        timestamp: AT + 3,
        live: true,
        isGroup: true,
        kind: "poll",
        name: "Lunch?",
        options: ["yes", "no"],
        selectableCount: 1,
      },
    });
    await worker.driver.emit({
      type: "update",
      update: { kind: "receipt", ref: { id: "i1", chatId: PERSON, fromMe: false }, status: "read" },
    });
    await worker.driver.emit({
      type: "contact",
      contact: {
        id: PERSON,
        nativeIds: [PERSON],
        displayName: "Person",
        verifiedName: "Person Ltd",
        status: "about me",
      },
    });
    await worker.driver.emit({
      type: "group",
      group: {
        kind: "metadata",
        id: ROOM,
        subject: "Room",
        participants: [{ id: PERSON }],
        at: AT,
      },
    });
    await worker.driver.emit({
      type: "group",
      group: {
        kind: "participants",
        id: ROOM,
        action: "add",
        participants: [{ id: SELF, role: "admin" }],
        at: AT + 1,
      },
    });
    await worker.driver.emit({
      type: "presence",
      presence: { chatId: PERSON, kind: "available", at: AT },
    });
    await tick();

    // Chats: the media/location chat and the poll's group chat.
    expect(chatIds(worker.client.chats.list()).sort()).toEqual([PERSON, ROOM].sort());
    // Each kind is *observed*, not merely emitted: this layer owns no messages,
    // so a chat's newest activity is the one thing every kind moves here — and
    // these instants are reachable only if the image, the location and the poll
    // each projected. Downgrading any of them to a text fixture changes these.
    const personChat = worker.client.chats.list().find((chat) => chat.chatId === PERSON);
    expect(personChat?.lastMessageAt).toBe(AT + 2); // the location, newer than the image
    const room = worker.client.chats.list().find((chat) => chat.chatId === ROOM);
    expect(room?.lastMessageAt).toBe(AT + 3); // the poll
    expect(room?.isGroup).toBe(true);
    expect(room?.subject).toBe("Room");

    const person = worker.client.contacts.resolve(PERSON);
    expect(person?.displayName).toBe("Person");
    expect(person?.verifiedName).toBe("Person Ltd");
    expect(person?.about).toBe("about me");
    // The durable last-seen instant, distinct from live presence.
    expect(person?.lastSeenAt).toBe(AT);

    const group = worker.client.groups.list().find((entry) => entry.groupId === ROOM);
    const roster = (group?.participants ?? []).map((participant) => participant.id).sort();
    expect(roster).toEqual([PERSON, SELF].sort());

    // The account's own durable state moved with the connection instant.
    expect(typeof worker.client.account.get().lastConnectedAt).toBe("number");
  } finally {
    await worker.stop();
  }
});

// ── 5. Aliases, consolidation and deletion from patch deltas alone ────────

test("PN/LID consolidation, alias lookup and contact deletion apply from patch deltas", async () => {
  const worker = await lane();
  try {
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON], displayName: "By phone number" },
    });
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON_LID, nativeIds: [PERSON_LID], displayName: "By LID" },
    });
    await tick();

    expect(contactIds(worker.client.contacts.list()).length).toBe(2);
    expect(worker.client.contacts.resolve(PERSON)?.contactId).toBe(PERSON);
    expect(worker.client.contacts.resolve(PERSON_LID)?.contactId).toBe(PERSON_LID);

    // WhatsApp now delivers both forms as one address: one record survives and
    // both native ids resolve to it — from the patch's deletes and aliases, with
    // no re-read of a snapshot.
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON, PERSON_LID], displayName: "Consolidated" },
    });
    await tick();

    const survivors = worker.client.contacts.list();
    expect(survivors.length).toBe(1);
    const consolidated = survivors[0];
    expect(consolidated?.displayName).toBe("Consolidated");
    expect([...(consolidated?.nativeIds ?? [])].sort()).toEqual([PERSON, PERSON_LID].sort());
    // Both native forms now reach the surviving record…
    expect(worker.client.contacts.resolve(PERSON)?.contactId).toBe(consolidated?.contactId);
    expect(worker.client.contacts.resolve(PERSON_LID)?.contactId).toBe(consolidated?.contactId);
    // …and the deleted record's identity is gone from the list.
    expect(contactIds(survivors)).toEqual([consolidated?.contactId as string]);
    // An address nothing ever delivered resolves to nothing.
    expect(worker.client.contacts.resolve("stranger@s.whatsapp.net")).toBe(undefined);
  } finally {
    await worker.stop();
  }
});

// ── 6. Gap recovery through the reused pull loop ──────────────────────────

test("a dropped revision replaces the core state from a fresh snapshot", async () => {
  // A fixed fencing token, so the direct acceptance below writes under exactly
  // the claim the runtime holds rather than under whichever number a counter
  // happened to reach.
  const backend: WhatsAppBackend = { ...memoryBackend(), leases: movableLeaseStore() };
  const worker = await lane({ backend });
  try {
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON], displayName: "Person" },
    });
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON_LID, nativeIds: [PERSON_LID], displayName: "By LID" },
    });
    await tick();
    expect(contactIds(worker.client.contacts.list()).sort()).toEqual([PERSON, PERSON_LID].sort());

    // Two revisions the client never sees a patch for: accepted straight at the
    // store, so the runtime publishes nothing. One *adds* a record and one
    // *removes* one, because a recovery that merged instead of replacing would
    // be indistinguishable from a correct one if the mirror only ever grew.
    const before = await backend.data.snapshot("personal");
    await backend.data.accept(
      "personal",
      [
        {
          observedAt: AT,
          event: {
            type: "contact",
            contact: { id: ROOM, nativeIds: [ROOM], displayName: "Silent" },
          },
        },
        {
          observedAt: AT,
          event: {
            type: "contact",
            contact: { id: PERSON, nativeIds: [PERSON, PERSON_LID] },
          },
        },
      ],
      1,
    );
    const skipped = await backend.data.snapshot("personal");
    expect(skipped.revision > before.revision).toBe(true);
    expect(contactIds([...skipped.contacts]).includes(PERSON_LID)).toBe(false);
    // The client has seen none of it: nothing published it.
    expect(contactIds(worker.client.contacts.list()).sort()).toEqual([PERSON, PERSON_LID].sort());

    // Now a published patch arrives from a revision the client is not at. The
    // reused pull loop re-snapshots rather than applying over the hole.
    // A recovery replaces everything, so it must announce everything — an
    // application cannot know which namespaces a fresh snapshot changed.
    const woken = new Set<string>();
    for (const namespace of ["account", "chats", "contacts", "groups"] as const)
      worker.client[namespace].subscribe(() => void woken.add(namespace));

    await worker.driver.emit({
      type: "contact",
      contact: { id: SELF, nativeIds: [SELF], displayName: "Me" },
    });
    await until(() => worker.client.contacts.list().length === 3);
    expect([...woken].sort()).toEqual(["account", "chats", "contacts", "groups"]);

    // Replaced, not merged, and the two halves of that are separate claims:
    // the silently accepted record is present because the fresh snapshot
    // carried it, and the silently consolidated one is gone because the fresh
    // snapshot did not — which merging over what the client already held could
    // never have achieved.
    expect(contactIds(worker.client.contacts.list()).sort()).toEqual([PERSON, ROOM, SELF].sort());
    expect(worker.client.contacts.list().length).toBe(3);
    // The alias the recovery brought with it still resolves to the survivor.
    expect(worker.client.contacts.resolve(PERSON_LID)?.contactId).toBe(PERSON);
  } finally {
    await worker.stop();
  }
});

// ── 7. Live state expires on every read, one instant per delivery ─────────

test("live connection and presence expire on every read at the observation deadline", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const start = Date.now();
  try {
    const worker = await lane({ freshnessMs: 5_000, leaseTtlMs: 600_000 });
    try {
      await worker.driver.emit({ type: "connection", status: { phase: "online" } });
      await worker.driver.emit({
        type: "presence",
        presence: { chatId: PERSON, kind: "typing" },
      });
      await tick();

      expect(worker.client.account.get().connection?.phase).toBe("online");
      expect(worker.client.contacts.presence(PERSON)).toBe("typing");

      // One millisecond before the observation deadline: still current.
      mock.timers.setTime(start + 4_999);
      expect(worker.client.account.get().connection?.phase).toBe("online");
      expect(worker.client.contacts.presence(PERSON)).toBe("typing");

      // Past it: unavailable on every read, with no transition and no timer.
      mock.timers.setTime(start + 5_001);
      expect(worker.client.account.get().connection).toBe(undefined);
      expect(worker.client.contacts.presence(PERSON)).toBe(undefined);

      // The durable instant the same observation produced is untouched by
      // expiry — a fact about the past, not a status (ADR-0020).
      expect(typeof worker.client.account.get().lastConnectedAt).toBe("number");
    } finally {
      await worker.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

test("two listeners in one delivery derive live state from one sampled instant", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const start = Date.now();
  try {
    const worker = await lane({ freshnessMs: 5_000, leaseTtlMs: 600_000 });
    try {
      await worker.driver.emit({
        type: "presence",
        presence: { chatId: PERSON, kind: "typing" },
      });
      await tick();
      expect(worker.client.contacts.presence(PERSON)).toBe("typing");

      const seen: Array<string | undefined> = [];
      // The first listener moves the wall clock past the presence deadline. If
      // any read re-read the clock per listener, the second would disagree.
      const offFirst = worker.client.chats.subscribe(() => {
        mock.timers.setTime(start + 60_000);
        seen.push(worker.client.contacts.presence(PERSON));
      });
      const offSecond = worker.client.chats.subscribe(() => {
        seen.push(worker.client.contacts.presence(PERSON));
      });

      await worker.driver.emit({
        type: "message",
        message: textMessage({ id: "m1", chatId: PERSON, text: "hi", timestamp: AT }),
      });
      await tick();

      expect(seen.length).toBe(2);
      expect(seen[0]).toBe("typing");
      expect(seen[1]).toBe("typing");
      // Outside the delivery the clock is read again, and it has moved.
      expect(worker.client.contacts.presence(PERSON)).toBe(undefined);

      offFirst();
      offSecond();
    } finally {
      await worker.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

test("a listener that stops the runtime cannot split its own delivery in two", async () => {
  // The instant is not the only thing a live read derives from. The claim and
  // the attached session are too, and a listener may legitimately stop the
  // Runtime — `release()` clears both synchronously, inside the fanout. Unless
  // all three are sampled together, the listeners after that one observe a
  // different connection, presence and identity from the same transition.
  const worker = await lane({
    freshnessMs: 600_000,
    identity: { jid: "15551230000:7@s.whatsapp.net", pushName: "Me" },
  });
  try {
    const views: string[] = [];
    const read = (): string => {
      const account = worker.client.account.get();
      return [
        account.connection?.phase ?? "none",
        account.identity ? "identity" : "no-identity",
        worker.client.contacts.presence(PERSON) ?? "none",
      ].join("/");
    };

    worker.client.contacts.subscribe(() => views.push(read()));
    worker.client.contacts.subscribe(() => {
      views.push(read());
      // Permitted: listeners may re-enter, and the application owns the Runtime.
      void worker.runtime.stop().catch(() => {});
    });
    worker.client.contacts.subscribe(() => views.push(read()));

    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();

    expect(views.length).toBe(3);
    // One transition, one view — whatever the middle listener did to the account.
    expect(new Set(views).size).toBe(1);
    expect(views[0]).toBe("online/identity/typing");
  } finally {
    await worker.client.close();
    await worker.runtime.stop().catch(() => {});
  }
});

test("two listeners in one delivery read one account state, not two", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const start = Date.now();
  try {
    const worker = await lane({ freshnessMs: 5_000, leaseTtlMs: 600_000 });
    try {
      await worker.driver.emit({ type: "connection", status: { phase: "online" } });
      await tick();
      expect(worker.client.account.get().connection?.phase).toBe("online");

      const seen: Array<string | undefined> = [];
      // The same proof the presence path gets: the first listener moves the
      // clock past the connection deadline, and the second must still agree.
      worker.client.chats.subscribe(() => {
        mock.timers.setTime(start + 60_000);
        seen.push(worker.client.account.get().connection?.phase);
      });
      worker.client.chats.subscribe(() => {
        seen.push(worker.client.account.get().connection?.phase);
      });

      await worker.driver.emit({
        type: "message",
        message: textMessage({ id: "m1", chatId: PERSON, text: "hi", timestamp: AT }),
      });
      await tick();

      expect(seen).toEqual(["online", "online"]);
      expect(worker.client.account.get().connection).toBe(undefined);
    } finally {
      await worker.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

test("the identity copy is reused although the session builds a fresh one per call", async () => {
  // The live session constructs its identity from the socket on every call, so
  // the deterministic one does too. A copy kept against the session's *object*
  // would miss every time — deep-cloning on the read path listeners run on,
  // while passing a test whose double happened to return a stable reference.
  const worker = await lane({ identity: { jid: "15551230000:7@s.whatsapp.net", pushName: "Me" } });
  try {
    const raw = worker.driver.session.identity?.();
    expect(raw).not.toBe(worker.driver.session.identity?.());

    const first = worker.client.account.get().identity;
    expect(first?.jid).toBe("15551230000:7@s.whatsapp.net");
    // One copy, reused: compared by what it says, not by which object said it.
    expect(worker.client.account.get().identity).toBe(first);
    expect(worker.client.account.get().identity).toBe(first);
    // …and still owned, so a reader cannot reach into Client state through it.
    assert.throws(() => {
      (first as { pushName?: string }).pushName = "Renamed by a reader";
    }, TypeError);

    // The account view itself is deliberately fresh per read — it derives from
    // the clock, and caching a snapshot belongs to the binding (ADR-0023).
    expect(worker.client.account.get()).not.toBe(worker.client.account.get());
  } finally {
    await worker.stop();
  }
});

test("presence follows the address WhatsApp used, across a consolidated contact", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    // One contact, reachable by both its PN and LID forms.
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON, PERSON_LID], displayName: "Person" },
    });
    await tick();
    const contact = worker.client.contacts.list()[0];
    assert.ok(contact);
    expect(contact.contactId).toBe(PERSON);

    // WhatsApp addresses the presence by the LID form.
    await worker.driver.emit({
      type: "presence",
      presence: { chatId: PERSON_LID, kind: "typing" },
    });
    await tick();

    // Both forms answer for the same peer — the live half of Address Resolution
    // agreeing with the durable half, which resolves the same way.
    expect(worker.client.contacts.presence(PERSON_LID)).toBe("typing");
    expect(worker.client.contacts.presence(contact.contactId)).toBe("typing");
    expect(typeof worker.client.contacts.resolve(PERSON_LID)?.lastSeenAt).toBe("number");
    // An address belonging to nobody still answers for nobody.
    expect(worker.client.contacts.presence("stranger@s.whatsapp.net")).toBe(undefined);
  } finally {
    await worker.stop();
  }
});

test("a group's presence names the participant, never the group chat", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    await worker.driver.emit({
      type: "presence",
      presence: { chatId: ROOM, participant: PERSON, kind: "recording" },
    });
    await tick();

    // In a group WhatsApp names who is present; the chat is not the peer.
    expect(worker.client.contacts.presence(PERSON)).toBe("recording");
    expect(worker.client.contacts.presence(ROOM)).toBe(undefined);
  } finally {
    await worker.stop();
  }
});

test("a live observation with no claim behind it is never reported", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    let notified = 0;
    worker.client.contacts.subscribe(() => void (notified += 1));

    // The session dispatcher snapshots its subscribers synchronously and runs
    // handler bodies a microtask later, so `off()` cannot retract a presence
    // already in flight — and the runtime publishes presence before its own
    // lease check. Teardown therefore does emit a live frame with no claim held.
    void worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    void Promise.resolve().then(() => void worker.runtime.stop().catch(() => {}));
    for (let turn = 0; turn < 10; turn += 1) await tick();

    // It is dropped before it can become client state: nothing to report, and
    // nothing to notify an application about after the account was given back.
    expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
    expect(notified).toBe(0);
  } finally {
    await worker.client.close();
  }
});

test("a listener that closes the client cannot split its own delivery either", async () => {
  // The sibling of stopping the Runtime mid-fanout: closing the Client also
  // ends its live truth, so whether it is in the delivery's basis decides
  // whether the listeners after it see the same transition or a different one.
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    const views: string[] = [];
    const read = (): string =>
      [
        worker.client.account.get().connection?.phase ?? "none",
        worker.client.contacts.presence(PERSON) ?? "none",
      ].join("/");

    worker.client.contacts.subscribe(() => views.push(read()));
    worker.client.contacts.subscribe(() => {
      views.push(read());
      void worker.client.close();
    });
    worker.client.contacts.subscribe(() => views.push(read()));

    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();

    expect(views.length).toBe(3);
    expect(new Set(views).size).toBe(1);
    expect(views[0]).toBe("online/typing");
    // Afterwards the close has taken effect and live truth is gone.
    expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
  } finally {
    await worker.runtime.stop().catch(() => {});
  }
});

test("an unavailable naming one native form ends the observation made under another", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON, PERSON_LID] },
    });
    // Observed present under the PN form…
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();
    expect(worker.client.contacts.presence(PERSON)).toBe("typing");
    expect(worker.client.contacts.presence(PERSON_LID)).toBe("typing");

    let notified = 0;
    worker.client.contacts.subscribe(() => void (notified += 1));

    // …and gone under the LID form. One peer, so both reads must end, and the
    // application has to be told: a read that spans a contact's forms while a
    // removal keys only the delivered address answers `typing` for a peer
    // WhatsApp has just said is away.
    await worker.driver.emit({
      type: "presence",
      presence: { chatId: PERSON_LID, kind: "unavailable" },
    });
    await tick();

    expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
    expect(worker.client.contacts.presence(PERSON_LID)).toBe(undefined);
    expect(notified).toBe(1);
  } finally {
    await worker.stop();
  }
});

test("a session that throws on identity cannot silence the client", async () => {
  // `RuntimeSession` is implemented by the application, and the Client samples
  // its identity between committing a transition and announcing it. A throw
  // there costs the whole delivery for a change that has already been applied —
  // and the recovery path samples again, so a session that throws consistently
  // gives a Client that mutates for ever and notifies never.
  const driver = createTestWhatsAppSession();
  let throwing = false;
  const session: RuntimeSession = {
    ...driver.session,
    identity: () => {
      if (throwing) throw new Error("the socket is gone");
      return undefined;
    },
  };
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend: memoryBackend(),
    openSession: () => session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    let notified = 0;
    client.chats.subscribe(() => void (notified += 1));

    throwing = true;
    await driver
      .emit({
        type: "message",
        message: textMessage({ id: "m1", chatId: PERSON, text: "hi", timestamp: AT }),
      })
      .catch(() => {});
    await until(() => client.chats.list().length === 1);

    // The state moved, so the announcement has to have happened too.
    expect(chatIds(client.chats.list())).toEqual([PERSON]);
    expect(notified).toBe(1);
    // The identity is simply unknown, which is what a session that cannot
    // answer means — not a reason to stop reporting the account at all.
    expect(client.account.get().identity).toBe(undefined);
    expect(client.account.get().closed).toBe(false);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("an unavailable presence removes its subject immediately", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();
    expect(worker.client.contacts.presence(PERSON)).toBe("typing");

    await worker.driver.emit({
      type: "presence",
      presence: { chatId: PERSON, kind: "unavailable" },
    });
    await tick();
    // Removed rather than retained as a kind that expires later.
    expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
  } finally {
    await worker.stop();
  }
});

// ── 8. A live observation is only as current as its claim ─────────────────

test("a live observation expires with its claim even before its own deadline", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const start = Date.now();
  try {
    // The observation outlives the lease deliberately: the earlier of the two
    // deadlines is what a read must honour.
    const worker = await lane({ freshnessMs: 600_000, leaseTtlMs: 10_000 });
    try {
      await worker.driver.emit({ type: "connection", status: { phase: "online" } });
      await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
      await tick();
      expect(worker.client.account.get().connection?.phase).toBe("online");
      expect(worker.client.contacts.presence(PERSON)).toBe("typing");

      // Past the lease deadline but far inside the observation's own.
      mock.timers.setTime(start + 10_001);
      expect(worker.client.account.get().connection).toBe(undefined);
      expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
    } finally {
      await worker.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

test("a replaced claim makes the observation made under the old one unavailable", async () => {
  const leases = movableLeaseStore();
  // The heartbeat is the only path that replaces a live claim, so its interval
  // is driven deliberately rather than waited on — and `Date` is frozen with it.
  // With a real clock and a one-second TTL, a slow machine would make the read
  // go `undefined` because the lease *expired* rather than because the claim was
  // *replaced*, and the test would pass for the wrong reason without ever
  // failing red.
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    const worker = await lane({
      backend: { ...memoryBackend(), leases },
      freshnessMs: 600_000,
      leaseTtlMs: 1_000,
    });
    try {
      await worker.driver.emit({ type: "connection", status: { phase: "online" } });
      await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
      await tick();
      expect(worker.client.account.get().connection?.phase).toBe("online");
      expect(worker.client.contacts.presence(PERSON)).toBe("typing");

      // The account moves to a new claim. Neither observation expired — the
      // clock has moved 500ms against a 600s freshness and a 1s lease that is
      // renewed, not lapsed — but neither was made under the claim that now
      // holds the account.
      leases.replace();
      mock.timers.tick(500);
      await until(() => worker.client.account.get().connection === undefined);

      expect(worker.client.account.get().connection).toBe(undefined);
      expect(worker.client.contacts.presence(PERSON)).toBe(undefined);

      // And the mechanism is the token, not a client that has simply gone
      // quiet: an observation made under the claim that now holds the account
      // is reported normally.
      await worker.driver.emit({
        type: "presence",
        presence: { chatId: PERSON, kind: "recording" },
      });
      await tick();
      expect(worker.client.contacts.presence(PERSON)).toBe("recording");
    } finally {
      await worker.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

test("an observation holds a claim copy, so renewing in place cannot revive it", async () => {
  // A store that renews by mutating the lease it already handed out. Nothing
  // forbids one, and it is what makes "an immutable copy, never the mutable
  // lease object" an observable property rather than a convention: an
  // observation holding the live object would follow the account onto its next
  // claim and report itself current for ever.
  let live: { accountId: string; holderId: string; fencingToken: number; expiresAt: number };
  const leases: AccountLeaseStore = {
    async acquire(accountId, holderId, ttlMs) {
      live = { accountId, holderId, fencingToken: 1, expiresAt: Date.now() + ttlMs };
      return { acquired: true, lease: live };
    },
    async renew(_lease, ttlMs) {
      live.fencingToken += 1;
      live.expiresAt = Date.now() + ttlMs;
      return { renewed: true, lease: live };
    },
    async release() {
      return true;
    },
  };

  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const worker = await lane({
      backend: { ...memoryBackend(), leases },
      freshnessMs: 600_000,
      leaseTtlMs: 1_000,
    });
    try {
      await worker.driver.emit({ type: "connection", status: { phase: "online" } });
      await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
      await tick();
      expect(worker.client.account.get().connection?.phase).toBe("online");
      expect(worker.client.contacts.presence(PERSON)).toBe("typing");

      mock.timers.tick(500);
      await until(() => worker.client.account.get().connection === undefined);

      // The account is on claim 2. An observation that had kept the lease
      // itself would now read its own fencing token as 2 and match.
      expect(worker.client.account.get().connection).toBe(undefined);
      expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
    } finally {
      await worker.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

// ── 9. Session identity and Runtime closure as account state ──────────────

test("session identity is account state only while a session is attached", async () => {
  const worker = await lane({ identity: { jid: "15551230000:7@s.whatsapp.net", pushName: "Me" } });
  try {
    expect(worker.client.account.get().identity?.jid).toBe("15551230000:7@s.whatsapp.net");
    expect(worker.client.account.get().identity?.pushName).toBe("Me");

    await worker.runtime.stop();
    await tick();
    // The session is detached, so nothing is sampled from it any more.
    expect(worker.client.account.get().identity).toBe(undefined);
  } finally {
    await worker.client.close();
  }
});

test("runtime closure is a transition of its own, observed as it happens", async () => {
  const worker = await lane();
  try {
    // Recorded per delivery rather than counted: stopping produces two
    // transitions — the disconnection instant it stamps, then the closure — and
    // a bare count cannot tell whether the closure notified at all, because the
    // stamp alone would satisfy it.
    const observed: boolean[] = [];
    worker.client.account.subscribe(() => observed.push(worker.client.account.get().closed));
    expect(worker.client.account.get().closed).toBe(false);

    await worker.runtime.stop();
    await tick();

    expect(worker.client.account.get().closed).toBe(true);
    // The closure is one of the deliveries, not merely implied by a later read.
    expect(observed.includes(true)).toBe(true);
    // …and it is the last thing this client says.
    expect(observed[observed.length - 1]).toBe(true);
    // The disconnection instant the same teardown stamped is durable state and
    // survives the closure — the postmortem's one legitimately-failing field.
    expect(typeof worker.client.account.get().lastDisconnectedAt).toBe("number");
  } finally {
    await worker.client.close();
  }
});

test("a failure that ends following is reported as account state, not only a warning", async () => {
  // The gap-recovery re-snapshot fails. Nobody is awaiting the pump, so the
  // account state is the only place this can surface — and it must surface, or
  // the client renders WhatsApp state that can never change again while
  // reporting itself live.
  const base = memoryBackend();
  let failNextSnapshot = false;
  const failure = new Error("the mirror read failed");
  const backend: WhatsAppBackend = {
    ...base,
    leases: movableLeaseStore(),
    data: {
      ...base.data,
      snapshot: async (accountId) => {
        if (!failNextSnapshot) return base.data.snapshot(accountId);
        failNextSnapshot = false;
        throw failure;
      },
    },
  };
  const worker = await lane({ backend, freshnessMs: 600_000 });
  try {
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON], displayName: "Person" },
    });
    // Live observations retained *before* the failure, so the terminal delivery
    // has something it could wrongly still report.
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();
    expect(worker.client.account.get().closed).toBe(false);
    expect(worker.client.account.get().connection?.phase).toBe("online");

    let notified = 0;
    // What the last delivery this client ever makes actually said.
    const terminal: Array<{ closed: boolean; connection?: string; presence?: string }> = [];
    worker.client.account.subscribe(() => {
      notified += 1;
      const account = worker.client.account.get();
      terminal.push({
        closed: account.closed,
        ...(account.connection && { connection: account.connection.phase }),
        ...(worker.client.contacts.presence(PERSON) && {
          presence: worker.client.contacts.presence(PERSON),
        }),
      });
    });

    // Skip a revision so the reused pull loop must re-snapshot, and make that
    // read fail.
    await backend.data.accept(
      "personal",
      [{ observedAt: AT, event: { type: "contact", contact: { id: ROOM, nativeIds: [ROOM] } } }],
      1,
    );
    failNextSnapshot = true;
    await worker.driver.emit({
      type: "contact",
      contact: { id: SELF, nativeIds: [SELF], displayName: "Me" },
    });
    await until(() => worker.client.account.get().closed);

    expect(worker.client.account.get().closed).toBe(true);
    // Handed out by identity, so a caller can compare it with the cause it holds.
    expect(worker.client.account.get().error).toBe(failure);
    expect(notified > 0).toBe(true);

    // The terminal delivery is the last one there will ever be, so it must not
    // be the one that reports a live connection the next read drops — there is
    // nobody left to correct it. Detaching before committing the closure, not
    // after, is what makes that true.
    expect(terminal[terminal.length - 1]).toEqual({ closed: true });

    // The live channel is released with it: a client that cannot follow durable
    // state must not keep answering as though its live state were current.
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "typing" } });
    await tick();
    expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
  } finally {
    await worker.stop();
  }
});

test("a client over an already-stopped runtime is hydrated, not empty", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  await driver.emit({
    type: "contact",
    contact: { id: PERSON, nativeIds: [PERSON], displayName: "Person" },
  });
  await driver.emit({
    type: "message",
    message: textMessage({ id: "m1", chatId: PERSON, text: "hi", timestamp: AT }),
  });
  await tick();
  const stored = await backend.data.snapshot("personal");

  // The runtime stops. Its terminal frame carries no snapshot, so a client
  // created afterwards would see nothing at all unless it reads the mirror.
  await runtime.stop();
  const client = await createWhatsAppClient(runtime);
  try {
    // Resolving the factory means hydration was applied — unconditionally.
    expect(contactIds(client.contacts.list())).toEqual([PERSON]);
    expect(chatIds(client.chats.list())).toEqual([PERSON]);
    expect(client.contacts.list().length).toBe(stored.contacts.length);
    // …and the account is visibly closed, so nothing is mistaken for live.
    expect(client.account.get().closed).toBe(true);
    expect(client.account.get().connection).toBe(undefined);
  } finally {
    await client.close();
  }
});

test("closing the client neither stops the runtime nor closes the backend", async () => {
  const worker = await lane();
  try {
    await worker.client.close();
    // Idempotent, and the runtime is still consuming the account.
    await worker.client.close();

    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "still here", timestamp: AT }),
    });
    await tick();

    const snapshot = await worker.backend.data.snapshot("personal");
    expect(snapshot.chats.some((chat) => chat.chatId === PERSON)).toBe(true);
    // A client created afterwards proves the runtime is still publishing.
    const fresh = await createWhatsAppClient(worker.runtime);
    try {
      expect(chatIds(fresh.chats.list())).toEqual([PERSON]);
    } finally {
      await fresh.close();
    }
  } finally {
    await worker.runtime.stop().catch(() => {});
  }
});

// ── 10. Ownership: inputs, returned reads and listener reads ──────────────

test("committed values are client-owned and unaffected by mutating what a caller holds", async () => {
  const worker = await lane();
  try {
    const contact = {
      id: PERSON,
      nativeIds: [PERSON],
      displayName: "Person",
    };
    await worker.driver.emit({ type: "contact", contact });
    await worker.driver.emit({
      type: "group",
      group: {
        kind: "metadata",
        id: ROOM,
        subject: "Room",
        participants: [{ id: PERSON }],
        at: AT,
      },
    });
    await tick();

    // A chat too, so every namespace's ingest is covered rather than two of
    // three — each writer copies separately, so each has to be shown to.
    const chat = textMessage({ id: "c1", chatId: ROOM, text: "hi", sender: PERSON, timestamp: AT });
    await worker.driver.emit({ type: "message", message: chat });
    await tick();
    const storedChat = worker.client.chats.list().find((entry) => entry.chatId === ROOM);
    assert.ok(storedChat);
    assert.throws(() => {
      (storedChat as { lastMessageAt: number }).lastMessageAt = 0;
    }, TypeError);

    // The input the caller still holds.
    contact.displayName = "Renamed by the caller";
    contact.nativeIds.push("injected@s.whatsapp.net");

    // The values a read returned.
    const returned = worker.client.contacts.resolve(PERSON);
    assert.ok(returned);
    assert.throws(() => {
      (returned as { displayName?: string }).displayName = "Renamed by a reader";
    }, TypeError);
    assert.throws(() => {
      (returned.nativeIds as string[]).push("injected@s.whatsapp.net");
    }, TypeError);

    // Every returned list, not just one — each namespace freezes its own.
    const groups = worker.client.groups.list();
    const room = groups[0];
    assert.ok(room, "the group the fixture created must be listed");
    assert.throws(() => {
      (groups as GroupRecord[]).push({
        accountId: "personal",
        groupId: "forged@g.us",
        participants: [],
      });
    }, TypeError);
    assert.throws(() => {
      (room.participants as { id: string }[]).push({ id: "forged@s.whatsapp.net" });
    }, TypeError);
    assert.throws(() => {
      (worker.client.chats.list() as ChatRecord[]).push({
        accountId: "personal",
        chatId: "forged@s.whatsapp.net",
        isGroup: false,
        lastMessageAt: 0,
      });
    }, TypeError);
    assert.throws(() => {
      (worker.client.contacts.list() as ContactRecord[]).push({
        accountId: "personal",
        contactId: "forged@s.whatsapp.net",
        nativeIds: [],
      });
    }, TypeError);

    // The values a listener was handed, mutated from inside a delivery. Counted
    // and null-checked: an assertion inside a callback nothing proves ran is
    // vacuous, and `assert.throws` is satisfied by dereferencing `undefined`.
    let delivered = 0;
    worker.client.contacts.subscribe(() => {
      delivered += 1;
      const inside = worker.client.contacts.resolve(PERSON);
      assert.ok(inside, "the listener must be able to read the contact it was told about");
      assert.throws(() => {
        (inside as { displayName?: string }).displayName = "Renamed by a listener";
      }, TypeError);
    });
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON], displayName: "Person", username: "person" },
    });
    await tick();
    expect(delivered).toBe(1);

    const after = worker.client.contacts.resolve(PERSON);
    expect(after?.displayName).toBe("Person");
    expect([...(after?.nativeIds ?? [])]).toEqual([PERSON]);
    expect(after?.username).toBe("person");
    expect(groupIds(worker.client.groups.list())).toEqual([ROOM]);
    expect(worker.client.groups.list()[0]?.participants.length).toBe(1);
  } finally {
    await worker.stop();
  }
});

// ── Deterministic ordering ────────────────────────────────────────────────

test("namespace lists use binary identifier ordering, never locale ordering", async () => {
  // The fixture is only a proof if the two orders genuinely disagree.
  assert.ok(UPPER < LOWER, "expected binary order to put the upper-case id first");
  assert.ok(UPPER.localeCompare(LOWER) > 0, "expected locale order to put it last");

  const worker = await lane();
  try {
    const upperChat = `${UPPER}@s.whatsapp.net`;
    const lowerChat = `${LOWER}@s.whatsapp.net`;
    const newerChat = `newer@s.whatsapp.net`;

    // Two chats sharing one `lastMessageAt`, so identifier order decides, and a
    // newer one that must outrank both whatever its identifier is.
    for (const [id, chatId, timestamp] of [
      ["a", lowerChat, AT],
      ["b", upperChat, AT],
      ["c", newerChat, AT + 1_000],
    ] as const)
      await worker.driver.emit({
        type: "message",
        message: textMessage({ id, chatId, text: "x", timestamp }),
      });
    for (const id of [lowerChat, upperChat])
      await worker.driver.emit({ type: "contact", contact: { id, nativeIds: [id] } });
    for (const id of [`${LOWER}@g.us`, `${UPPER}@g.us`])
      await worker.driver.emit({
        type: "group",
        group: { kind: "metadata", id, subject: "g", participants: [], at: AT },
      });
    await tick();

    // Newest activity first; then, among the three chats sharing a timestamp
    // and the two group summaries sharing none at all, by binary identifier.
    expect(chatIds(worker.client.chats.list())).toEqual([
      newerChat,
      upperChat,
      lowerChat,
      `${UPPER}@g.us`,
      `${LOWER}@g.us`,
    ]);
    expect(contactIds(worker.client.contacts.list())).toEqual([upperChat, lowerChat]);
    expect(groupIds(worker.client.groups.list())).toEqual([`${UPPER}@g.us`, `${LOWER}@g.us`]);
  } finally {
    await worker.stop();
  }
});
