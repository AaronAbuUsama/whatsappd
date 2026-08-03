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

    // A transitional phase deliberately: `connecting` records no durable
    // instant, so the mirror revision does not move and the live announcement
    // is the only one there is. Driving `online` instead would let the durable
    // patch stand in, and this assertion would hold with the live mark deleted.
    await worker.driver.emit({ type: "connection", status: { phase: "connecting" } });
    await tick();
    expect(seen.account).toBe(1);
    expect(worker.client.account.get().connection?.phase).toBe("connecting");

    // …and then the durable half, which does move the account record.
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await tick();
    expect(typeof worker.client.account.get().lastConnectedAt).toBe("number");
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

test("the newest observation wins across a contact's native forms", async () => {
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON, PERSON_LID] },
    });
    // Idle in the 1:1, where WhatsApp names the chat — the PN form.
    await worker.driver.emit({ type: "presence", presence: { chatId: PERSON, kind: "idle" } });
    await tick();
    expect(worker.client.contacts.presence(PERSON)).toBe("idle");

    // What every listener was told during the transition that follows.
    const announced: Array<string | undefined> = [];
    worker.client.contacts.subscribe(() =>
      announced.push(worker.client.contacts.presence(PERSON_LID)),
    );

    // Then typing in a group, where WhatsApp names the participant — the LID
    // form. A sequence, not a contradiction: the later observation is the truth.
    await worker.driver.emit({
      type: "presence",
      presence: { chatId: ROOM, participant: PERSON_LID, kind: "typing" },
    });
    await tick();

    // Answering in `nativeIds` order would report the superseded `idle` here,
    // for both forms and for the whole freshness window.
    expect(worker.client.contacts.presence(PERSON_LID)).toBe("typing");
    expect(worker.client.contacts.presence(PERSON)).toBe("typing");
    // …and the delivery that announced the change must not report the state
    // before it.
    expect(announced.includes("typing")).toBe(true);
    expect(announced.includes("idle")).toBe(false);
  } finally {
    await worker.stop();
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

    // Reported once, not once per read. Every read that derives live state
    // samples the identity, so a persistently failing session would otherwise
    // emit a warning per application read. At most one appears here, and it is
    // the first fault's — `process.emitWarning` delivers asynchronously, so it
    // can land inside this window rather than before it.
    const reads = 50;
    const repeated = await surfaced(async () => {
      for (let read = 0; read < reads; read += 1) client.account.get();
    });
    expect(repeated.length <= 1).toBe(true);
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

test("a function subscribed twice owes two deliveries, and one release owes one", async () => {
  // A registration is a record, not the callback. A set keyed by the callback
  // could express neither of these (ADR-0013), and would pass every other test
  // in this file.
  const worker = await lane();
  try {
    let calls = 0;
    const listener = (): void => void (calls += 1);
    const offFirst = worker.client.chats.subscribe(listener);
    worker.client.chats.subscribe(listener);

    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "one", timestamp: AT }),
    });
    await tick();
    expect(calls).toBe(2);

    // Releasing one registration leaves its twin subscribed.
    offFirst();
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "m2", chatId: PERSON, text: "two", timestamp: AT + 1 }),
    });
    await tick();
    expect(calls).toBe(3);
  } finally {
    await worker.stop();
  }
});

test("a live connection status is owned, and a closure carries an undefined cause", async () => {
  // The connection status is committed state like any record, and the only one
  // whose copy no other test performs.
  const worker = await lane({ freshnessMs: 600_000 });
  try {
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await tick();
    const status = worker.client.account.get().connection;
    assert.ok(status);
    assert.throws(() => {
      (status as { phase: string }).phase = "forged";
    }, TypeError);
    expect(worker.client.account.get().connection?.phase).toBe("online");
  } finally {
    await worker.stop();
  }
});

test("a deliberate stop reports no failure, which is how a failure is told apart", async () => {
  const worker = await lane();
  try {
    expect("error" in worker.client.account.get()).toBe(false);
    await worker.runtime.stop();
    await until(() => worker.client.account.get().closed);
    // Closed, and no `error` key at all — `error` is spread rather than tested,
    // so its *presence* is what says a failure ended this, independently of
    // what the cause turned out to be.
    expect(worker.client.account.get().closed).toBe(true);
    expect("error" in worker.client.account.get()).toBe(false);
  } finally {
    await worker.client.close();
  }
});

test("an identity a session builds from anything is still copied safely", async () => {
  // The one value entering Client state that no `structuredClone` has already
  // vetted, sampled between committing a transition and announcing it. An
  // application session may return an object carrying anything; copying the
  // declared fields cannot fail, where cloning it wholesale would throw and
  // cost the delivery.
  const driver = createTestWhatsAppSession();
  const session: RuntimeSession = {
    ...driver.session,
    identity: () => ({
      jid: "15551230000:7@s.whatsapp.net",
      pushName: "Me",
      // Not part of `WaIdentity`, and not structured-cloneable.
      refresh: () => {},
    }),
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

    await driver.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: PERSON, text: "hi", timestamp: AT }),
    });
    await until(() => client.chats.list().length === 1);

    expect(notified).toBe(1);
    expect(client.account.get().identity?.jid).toBe("15551230000:7@s.whatsapp.net");
    expect(client.account.get().identity?.pushName).toBe("Me");
    // Only the contract's fields are carried across.
    expect("refresh" in (client.account.get().identity ?? {})).toBe(false);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
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

// ── 11. Retained messages: the fifth namespace ────────────────────────────

/** One chat's retained texts, in the order the Client holds them. */
const texts = (client: WhatsAppClientCore, chatId: string): string[] =>
  client.messages
    .get(chatId)
    .messages.map((message) => ("text" in message ? message.text : "") ?? "");

/** One chat's retained message ids, in the order the Client holds them. */
const heldIds = (client: WhatsAppClientCore, chatId: string): string[] =>
  client.messages.get(chatId).messages.map((message) => message.messageId);

/**
 * A backend whose stored-message reads this test resolves by hand.
 *
 * @remarks
 * Deliberately in this file rather than in `src/testing.ts`: a deferrable read
 * is a property of this proof, not a published capability of the
 * `whatsappd/testing` entry (issue #106). It decorates the `MirrorView` inside
 * `data.read`, which is the exact seam `ClientRuntimeSource.read` reaches
 * (`runtime.ts:809`), so nothing about the Client is special-cased for it.
 *
 * `pin` chooses which of the two races is under test. `"start"` reads the rows
 * before waiting, so the page carries the store's state at read *start* and a
 * live upsert that lands mid-read is the fresher copy. `"release"` waits first,
 * so the page carries the state at read *end* — which is how a page fresher
 * than the Client's own revision is constructed.
 */
function heldReads(inner: WhatsAppBackend): WhatsAppBackend & {
  hold(pin?: "start" | "release"): void;
  release(): void;
  reads(): number;
} {
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  let pin: "start" | "release" = "start";
  let reads = 0;
  return {
    ...inner,
    data: {
      ...inner.data,
      read: (accountId, fn) =>
        inner.data.read(accountId, (view) =>
          fn({
            ...view,
            async messages(chatId, options) {
              reads += 1;
              if (pin === "release") {
                await gate;
                return view.messages(chatId, options);
              }
              const page = await view.messages(chatId, options);
              await gate;
              return page;
            },
          }),
        ),
    },
    hold(at = "start") {
      pin = at;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
      gate = undefined;
      open = undefined;
    },
    reads: () => reads,
  };
}

/** Emit `count` text messages into one chat, oldest first. */
async function seed(
  worker: Lane,
  chatId: string,
  count: number,
  options: { readonly from?: number; readonly at?: (index: number) => number } = {},
): Promise<void> {
  const from = options.from ?? 0;
  for (let index = 0; index < count; index += 1)
    await worker.driver.emit({
      type: "message",
      message: textMessage({
        id: `m${from + index}`,
        chatId,
        text: `t${from + index}`,
        timestamp: options.at ? options.at(index) : AT + from + index,
      }),
    });
  await tick();
}

// ── 11.1 A chat never read holds nothing and issues no storage read ───────

test("a chat never paged holds nothing, reads no storage, and returns one stable view", async () => {
  const backend = heldReads(memoryBackend());
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 3);
    const before = backend.reads();

    const view = worker.client.messages.get(PERSON);
    expect(view.chatId).toBe(PERSON);
    expect(view.messages).toEqual([]);
    expect(view.older).toBe("stored");
    expect(view.error).toBe(undefined);
    // `get()` creates the entry, and creating it is not a storage read.
    expect(backend.reads()).toBe(before);
    // The identical object, so a `useSyncExternalStore` binding on a chat that
    // was never paged does not re-render for ever.
    expect(worker.client.messages.get(PERSON)).toBe(view);
  } finally {
    await worker.stop();
  }
});

// ── 11.2 Paging walks backwards and ends exhausted ────────────────────────

test("older() lands the newest page, then the page before it, then exhausts", async () => {
  const worker = await lane();
  try {
    // More than one store page (the default is 25, `contracts.ts:321`), so
    // `nextBefore` is a real cursor rather than an immediate end.
    await seed(worker, PERSON, 30);

    expect(worker.client.messages.get(PERSON).messages.length).toBe(0);

    // Nothing but paging happens in this test, so every delivery counted here
    // is one a page read caused — which is what makes the count a proof that
    // landing a page announces itself rather than only mutating the buffer.
    const woken: number[] = [];
    worker.client.messages.subscribe(() =>
      woken.push(worker.client.messages.get(PERSON).messages.length),
    );

    worker.client.messages.older(PERSON);
    expect(worker.client.messages.get(PERSON).older).toBe("loading");
    // The `loading` mark is itself a transition: a binding showing a spinner
    // has to be told the read started, not only that it finished.
    expect(woken).toEqual([0]);
    await until(() => worker.client.messages.get(PERSON).messages.length === 25);
    expect(woken).toEqual([0, 25]);
    // Newest first: t29 down to t5.
    expect(texts(worker.client, PERSON)[0]).toBe("t29");
    expect(texts(worker.client, PERSON).at(-1)).toBe("t5");
    expect(worker.client.messages.get(PERSON).older).toBe("stored");

    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 30);
    expect(texts(worker.client, PERSON).at(-1)).toBe("t0");
    // Nothing older is stored, so the cursor is gone and the state says so.
    expect(worker.client.messages.get(PERSON).older).toBe("exhausted");
    expect(woken).toEqual([0, 25, 25, 30]);

    // An exhausted chat issues no further read and stays exhausted — and says
    // nothing, because a call that fetches nothing is not a transition.
    worker.client.messages.older(PERSON);
    await tick();
    expect(woken).toEqual([0, 25, 25, 30]);
    expect(worker.client.messages.get(PERSON).older).toBe("exhausted");
    expect(worker.client.messages.get(PERSON).messages.length).toBe(30);
  } finally {
    await worker.stop();
  }
});

// ── 11.3 The fill rule, both directions ───────────────────────────────────

test("a patch overwrites a held id; a page never does", async () => {
  const backend = heldReads(memoryBackend());
  const worker = await lane({ backend });
  try {
    // The entry first, so the live traffic below is *retained* rather than
    // dropped — which is what makes the first page overlap ids the buffer
    // already holds. Paging a chat this way round is the real scroll-up: a
    // conversation has been open and receiving, and is then read backwards.
    worker.client.messages.get(PERSON);
    await seed(worker, PERSON, 30);
    expect(worker.client.messages.get(PERSON).messages.length).toBe(30);
    // Never paged, so a held read below is a real one rather than a call that
    // short-circuits on `exhausted` and holds a gate nobody waits on.
    expect(worker.client.messages.get(PERSON).older).toBe("stored");

    // Direction 1 — a patch wins over what the buffer holds.
    await worker.driver.emit({
      type: "update",
      update: {
        kind: "reaction",
        ref: { id: "m29", chatId: PERSON, fromMe: false },
        emoji: "🔥",
        by: PERSON,
        removed: false,
      },
    });
    await until(() => worker.client.messages.get(PERSON).messages[0]?.reactions.length === 1);

    // Direction 2 — a page pinned before an edit lands after it, and must not
    // put the pre-edit copy back over the id the buffer holds.
    const reads = backend.reads();
    const woken: string[] = [];
    worker.client.messages.subscribe(() => void woken.push("messages"));

    backend.hold("start");
    worker.client.messages.older(PERSON);
    await tick();
    // The read is genuinely in flight: without this the gate below holds
    // nothing and every assertion after it passes on unchanged state.
    expect(backend.reads() - reads).toBe(1);
    expect(worker.client.messages.get(PERSON).older).toBe("loading");

    await worker.driver.emit({
      type: "update",
      update: {
        kind: "edit",
        ref: { id: "m29", chatId: PERSON, fromMe: false },
        message: textMessage({ id: "m29", chatId: PERSON, text: "edited", timestamp: AT + 29 }),
      },
    });
    await tick();
    backend.release();
    await until(() => worker.client.messages.get(PERSON).older !== "loading");

    // Both live changes survived the page: the reaction it never saw, and the
    // edit that landed while it was in flight. The page's own copy of `m29`
    // carried neither.
    expect(worker.client.messages.get(PERSON).messages[0]?.reactions.length).toBe(1);
    expect(texts(worker.client, PERSON)[0]).toBe("edited");
    // The page still did its job for the ids the buffer did not hold.
    expect(worker.client.messages.get(PERSON).messages.length).toBe(30);
    // And landing it announced itself: a page that committed without marking
    // the namespace would leave every subscriber holding a stale view.
    expect(woken.length > 0).toBe(true);
  } finally {
    await worker.stop();
  }
});

// ── 11.4 Concurrent older() joins one read ────────────────────────────────

test("concurrent older() calls join one read", async () => {
  const backend = heldReads(memoryBackend());
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 30);
    const before = backend.reads();

    backend.hold("start");
    worker.client.messages.older(PERSON);
    worker.client.messages.older(PERSON);
    worker.client.messages.older(PERSON);
    await tick();
    expect(worker.client.messages.get(PERSON).older).toBe("loading");
    expect(backend.reads() - before).toBe(1);

    backend.release();
    await until(() => worker.client.messages.get(PERSON).messages.length === 25);
    // One page landed, not three: joining is not "three reads whose results
    // happened to be identical".
    expect(backend.reads() - before).toBe(1);
    expect(worker.client.messages.get(PERSON).messages.length).toBe(25);
  } finally {
    await worker.stop();
  }
});

// ── 11.5 A page resolving after replace() commits nothing ─────────────────

test("a page that resolves after a revision gap commits nothing", async () => {
  const inner: WhatsAppBackend = { ...memoryBackend(), leases: movableLeaseStore() };
  const backend = heldReads(inner);
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 3);
    worker.client.messages.get(PERSON);

    // A page taken at the pre-gap revision, held open across the gap.
    backend.hold("start");
    worker.client.messages.older(PERSON);
    await tick();

    // Two revisions the client never sees a patch for, then a published patch
    // from a revision it is not at: the pull loop replaces from a snapshot.
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
      ],
      1,
    );
    await worker.driver.emit({
      type: "contact",
      contact: { id: SELF, nativeIds: [SELF], displayName: "Me" },
    });
    // Waiting on the *silently accepted* record, because only a fresh snapshot
    // can carry it: a patch applied over the hole would never produce it, so
    // this is the gap firing rather than an ordinary transition.
    await until(() => contactIds(worker.client.contacts.list()).includes(ROOM));
    // A snapshot carries no messages (ADR-0010), so recovery empties the chat.
    expect(worker.client.messages.get(PERSON).messages).toEqual([]);

    // Subscribed *after* the gap, because the identity guard's whole observable
    // effect is the delivery it suppresses. `retained.clear()` already detached
    // the captured entry, so a stale page cannot be read back through `get()`
    // whether the guard is there or not — but without it the page still marks
    // the namespace and wakes every listener for a transition that changed
    // nothing. Asserting emptiness alone passes with the guard deleted.
    const woken: string[] = [];
    worker.client.messages.subscribe(() => void woken.push("messages"));

    // The pre-gap page now resolves. It was taken against an entry `replace()`
    // discarded, so it commits nothing — object identity, not a revision.
    backend.release();
    await tick();
    await tick();
    expect(woken).toEqual([]);
    expect(worker.client.messages.get(PERSON).messages).toEqual([]);
    // And the entry it could have resurrected is still the fresh one.
    expect(worker.client.messages.get(PERSON).older).toBe("stored");
  } finally {
    await worker.stop();
  }
});

// ── 11.6 No per-entry revision watermark ──────────────────────────────────

test("a page fresher than the buffer is refused, and the next transition converges", async () => {
  const inner: WhatsAppBackend = { ...memoryBackend(), leases: movableLeaseStore() };
  const backend = heldReads(inner);
  const worker = await lane({ backend });
  try {
    // Entry first, so the traffic below is retained and the first page overlaps
    // ids the buffer already holds — and so `older` is still `"stored"` when
    // the gate goes on, which is what makes the held read a real one.
    worker.client.messages.get(PERSON);
    await seed(worker, PERSON, 30);
    expect(texts(worker.client, PERSON)[0]).toBe("t29");
    expect(worker.client.messages.get(PERSON).older).toBe("stored");

    // The store moves ahead of the client with no patch published, so the page
    // this read pins on release is *newer* than anything the client has.
    const reads = backend.reads();
    backend.hold("release");
    worker.client.messages.older(PERSON);
    await tick();
    expect(backend.reads() - reads).toBe(1);
    expect(worker.client.messages.get(PERSON).older).toBe("loading");
    await backend.data.accept(
      "personal",
      [
        {
          observedAt: AT,
          // An edit rather than a re-offer of the same message: offering an id
          // the mirror already holds changes no record and takes no revision
          // (`contracts.ts:444-447`), so it would leave the store exactly where
          // the client already is and no page could be fresher than anything.
          event: {
            type: "update",
            update: {
              kind: "edit",
              ref: { id: "m29", chatId: PERSON, fromMe: false },
              message: textMessage({
                id: "m29",
                chatId: PERSON,
                text: "newer",
                timestamp: AT + 29,
              }),
            },
          },
        },
      ],
      1,
    );
    backend.release();
    await until(() => worker.client.messages.get(PERSON).older !== "loading");

    // The fill rule refused the fresher row, because the id is held. That is
    // the transient the README discloses, not a permanent state. The page
    // genuinely carried "newer" — it was pinned after the store moved — so this
    // is the refusal happening, not a page that never ran.
    expect(texts(worker.client, PERSON)[0]).toBe("t29");
    expect(worker.client.messages.get(PERSON).messages.length).toBe(30);

    // It converges on the next transition rather than stranding: the published
    // patch is from a revision the client is not at, so the pull loop replaces
    // from a fresh snapshot, which clears the buffer and lets a re-page read
    // the truth. No watermark refuses anything on the way.
    await worker.driver.emit({
      type: "contact",
      contact: { id: SELF, nativeIds: [SELF], displayName: "Me" },
    });
    await until(() => worker.client.messages.get(PERSON).messages.length === 0);
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 25);
    expect(texts(worker.client, PERSON)[0]).toBe("newer");
  } finally {
    await worker.stop();
  }
});

// ── 11.7 Every message kind on master ─────────────────────────────────────

test("edits, revocations, receipts and reactions all reach retained messages", async () => {
  const worker = await lane();
  try {
    await worker.driver.emit({ type: "message", message: imageMessage("i1", PERSON) });
    await seed(worker, PERSON, 1, { from: 1 });
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 2);

    await worker.driver.emit({
      type: "update",
      update: { kind: "receipt", ref: { id: "i1", chatId: PERSON, fromMe: false }, status: "read" },
    });
    await worker.driver.emit({
      type: "update",
      update: {
        kind: "reaction",
        ref: { id: "i1", chatId: PERSON, fromMe: false },
        emoji: "👍",
        by: PERSON,
        removed: false,
      },
    });
    await worker.driver.emit({
      type: "update",
      update: {
        kind: "edit",
        ref: { id: "m1", chatId: PERSON, fromMe: false },
        message: textMessage({ id: "m1", chatId: PERSON, text: "corrected", timestamp: AT + 1 }),
      },
    });
    await tick();

    const image = worker.client.messages
      .get(PERSON)
      .messages.find((message) => message.messageId === "i1");
    expect(image?.receipts.some((receipt) => receipt.status === "read")).toBe(true);
    expect(image?.reactions.map((reaction) => reaction.emoji)).toEqual(["👍"]);
    expect(texts(worker.client, PERSON).includes("corrected")).toBe(true);

    // A revocation is an upsert carrying a tombstone, not a disappearance
    // (ADR-0019), so it reaches the buffer like every other change.
    await worker.driver.emit({
      type: "update",
      update: { kind: "revoke", ref: { id: "m1", chatId: PERSON, fromMe: false }, by: PERSON },
    });
    await until(
      () =>
        worker.client.messages.get(PERSON).messages.find((m) => m.messageId === "m1")?.kind ===
        "revoked",
    );
    // The tombstone replaced the text in place; the id is still held.
    expect(worker.client.messages.get(PERSON).messages.length).toBe(2);
  } finally {
    await worker.stop();
  }
});

// ── 11.8 reset() clears retained ──────────────────────────────────────────

test("a dropped revision clears retained messages", async () => {
  const backend: WhatsAppBackend = { ...memoryBackend(), leases: movableLeaseStore() };
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 3);
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 3);
    expect(worker.client.messages.get(PERSON).older).toBe("exhausted");

    const woken: string[] = [];
    worker.client.messages.subscribe(() => void woken.push("messages"));

    // A revision the client never sees, then a patch from a revision it is not
    // at: the pull loop replaces state from a fresh snapshot.
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
      ],
      1,
    );
    await worker.driver.emit({
      type: "contact",
      contact: { id: SELF, nativeIds: [SELF], displayName: "Me" },
    });
    await until(() => contactIds(worker.client.contacts.list()).includes(ROOM));

    // A `reset()` that notified without clearing would leave all three here.
    expect(worker.client.messages.get(PERSON).messages).toEqual([]);
    // And the paging state goes with them: a chat whose cursor survived would
    // page from the middle of a mirror it no longer holds the front of.
    expect(worker.client.messages.get(PERSON).older).toBe("stored");
    expect(woken.length > 0).toBe(true);
  } finally {
    await worker.stop();
  }
});

// ── 11.9 Descending id tie-break, matching both stores ────────────────────

test("timestamp collisions break by descending id, and a backdated live message sorts", async () => {
  const worker = await lane();
  try {
    // Three messages on one instant, so the identifier decides — and the two
    // whose binary and locale orders disagree are among them.
    for (const id of [LOWER, UPPER, "m-mid"])
      await worker.driver.emit({
        type: "message",
        message: textMessage({ id, chatId: PERSON, text: id, timestamp: AT }),
      });
    await tick();

    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 3);

    // Descending by identifier, matching `ORDER BY timestamp DESC, message_id
    // DESC` in both stores (`libsql.ts:1308`, `memory.ts:57`). An ascending
    // tie-break — the one `chats.list()` uses in this same file — reverses
    // this, and `"Zed" < "apple"` by code unit while `"apple" < "Zed"` by
    // locale, so this also fails red if the comparison stops being binary.
    expect(heldIds(worker.client, PERSON)).toEqual(["m-mid", LOWER, UPPER]);

    // A live message backdated below everything already held takes its place by
    // the same order rather than by arrival.
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "back", chatId: PERSON, text: "back", timestamp: AT - 1 }),
    });
    await until(() => worker.client.messages.get(PERSON).messages.length === 4);
    expect(heldIds(worker.client, PERSON)).toEqual(["m-mid", LOWER, UPPER, "back"]);
  } finally {
    await worker.stop();
  }
});

// ── 11.10 A failed read reports, retains, and retries ─────────────────────

test("a failed read sets error, keeps what is held, and a retry succeeds", async () => {
  const inner = memoryBackend();
  let fail: unknown;
  const backend: WhatsAppBackend = {
    ...inner,
    data: {
      ...inner.data,
      read: (accountId, fn) => (fail ? Promise.reject(fail) : inner.data.read(accountId, fn)),
    },
  };
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 30);
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 25);
    const cursorHeld = texts(worker.client, PERSON).at(-1);

    fail = new Error("mirror unavailable");
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).error !== undefined);

    const failed = worker.client.messages.get(PERSON);
    // Reported by identity, so a caller can compare it with the cause it holds.
    expect(failed.error).toBe(fail);
    // Nothing already held was lost, and paging did not silently end.
    expect(failed.messages.length).toBe(25);
    expect(failed.older).toBe("stored");

    // Calling it again *is* the retry, and it resumes from the same cursor
    // rather than re-reading the newest page.
    fail = undefined;
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 30);
    const recovered = worker.client.messages.get(PERSON);
    expect(recovered.error).toBe(undefined);
    expect(recovered.older).toBe("exhausted");
    expect(texts(worker.client, PERSON)[24]).toBe(cursorHeld);
  } finally {
    await worker.stop();
  }
});

// ── 11.11 Referential stability per chat ──────────────────────────────────

test("another chat's traffic leaves this chat's view identical", async () => {
  const worker = await lane();
  try {
    await seed(worker, PERSON, 2);
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 2);

    // The other chat needs an *entry*, or its traffic is dropped by the
    // no-entry rule and never marks the namespace at all — in which case a
    // namespace-wide view cache would pass this test unchanged.
    worker.client.messages.get(PERSON_LID);
    const held = worker.client.messages.get(PERSON);
    const untouched = worker.client.messages.get(ROOM);
    const woken: string[] = [];
    worker.client.messages.subscribe(() => void woken.push("messages"));

    // A namespace-wide subscription wakes for any chat, which is the accepted
    // cost — but an uninterested listener must re-read the *same* object.
    await worker.driver.emit({
      type: "message",
      message: textMessage({
        id: "other",
        chatId: PERSON_LID,
        text: "elsewhere",
        timestamp: AT + 99,
      }),
    });
    await tick();

    // The transition really did reach this namespace and really did change the
    // other chat, so the memo below survives an invalidation that happened.
    expect(woken.length > 0).toBe(true);
    expect(texts(worker.client, PERSON_LID)).toEqual(["elsewhere"]);
    expect(worker.client.messages.get(PERSON)).toBe(held);
    // Including a chat that was never paged at all.
    expect(worker.client.messages.get(ROOM)).toBe(untouched);

    // And this chat's own traffic does replace it.
    await worker.driver.emit({
      type: "message",
      message: textMessage({ id: "mine", chatId: PERSON, text: "mine", timestamp: AT + 100 }),
    });
    await until(() => worker.client.messages.get(PERSON).messages.length === 3);
    expect(worker.client.messages.get(PERSON)).not.toBe(held);
  } finally {
    await worker.stop();
  }
});

// ── 11.12 The listener rules hold, with no second fanout ──────────────────

test("the five listener rules hold for messages exactly as for every namespace", async () => {
  const worker = await lane();
  try {
    worker.client.messages.get(PERSON);
    const order: string[] = [];
    let lateOff: (() => void) | undefined;

    // Rule 4 — a throwing listener stays subscribed and affects no sibling.
    worker.client.messages.subscribe(() => {
      order.push("throws");
      throw new Error("listener failed");
    });
    // Rule 2 — subscribing during a delivery takes effect on the next one.
    worker.client.messages.subscribe(() => {
      order.push("subscriber");
      worker.client.messages.subscribe(() => order.push("added-mid-delivery"));
      // Rule 3 — unsubscribing a listener not yet reached takes effect now.
      lateOff?.();
    });
    lateOff = worker.client.messages.subscribe(() => order.push("removed-mid-delivery"));

    const warnings = await surfaced(async () => {
      await seed(worker, PERSON, 1);
    });

    expect(order).toEqual(["throws", "subscriber"]);
    expect(warnings.length).toBe(1);

    order.length = 0;
    await seed(worker, PERSON, 1, { from: 1 });
    // The listener added mid-delivery now runs; the one removed mid-delivery
    // never does.
    expect(order).toEqual(["throws", "subscriber", "added-mid-delivery"]);
  } finally {
    await worker.stop();
  }
});

test("one transition affecting messages and chats delivers once to a listener of each", async () => {
  const worker = await lane();
  try {
    worker.client.messages.get(PERSON);
    const seen: string[] = [];
    worker.client.messages.subscribe(() => void seen.push("messages"));
    worker.client.chats.subscribe(() => void seen.push("chats"));
    worker.client.groups.subscribe(() => void seen.push("groups"));

    await seed(worker, PERSON, 1);

    // A message moves the chat summary too, so both wake — once each, from one
    // fanout. Groups are untouched and stay silent.
    expect(seen.filter((namespace) => namespace === "messages").length).toBe(1);
    expect(seen.filter((namespace) => namespace === "chats").length).toBe(1);
    expect(seen.includes("groups")).toBe(false);
  } finally {
    await worker.stop();
  }
});

// ── 11.13 Close mid-read, and a dropped message for an unread chat ────────

test("closing mid-read commits nothing, and afterwards nothing throws or reads", async () => {
  const backend = heldReads(memoryBackend());
  const worker = await lane({ backend });
  try {
    // More than one page, so the entry is still `"stored"` after the first
    // read and the gated one below is a read genuinely in flight. With a
    // one-page fixture it short-circuits on `exhausted` and every assertion
    // here passes without a single read being issued.
    await seed(worker, PERSON, 30);
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 25);
    expect(worker.client.messages.get(PERSON).older).toBe("stored");

    const woken: string[] = [];
    worker.client.messages.subscribe(() => void woken.push("messages"));

    const reads = backend.reads();
    backend.hold("start");
    worker.client.messages.older(PERSON);
    await tick();
    expect(backend.reads() - reads).toBe(1);
    expect(worker.client.messages.get(PERSON).older).toBe("loading");
    // One delivery so far, and it is the `loading` mark — anything after this
    // point is the late result speaking when it should not.
    expect(woken).toEqual(["messages"]);

    await worker.client.close();
    backend.release();
    await tick();
    await tick();

    // The late result commits nothing and notifies nobody.
    expect(woken).toEqual(["messages"]);
    expect(worker.client.messages.get(PERSON).messages.length).toBe(25);

    // And the read it can no longer finish is not left claiming to be running.
    // `"loading"` here would be permanent: no result can land, `older()` is a
    // no-op, and a binding rendering a spinner on it would spin for ever.
    expect(worker.client.messages.get(PERSON).older).toBe("stored");

    // Afterwards `get()` still answers from what is held and `older()` is a
    // no-op that neither throws nor reaches storage.
    const after = backend.reads();
    worker.client.messages.older(PERSON);
    await tick();
    expect(backend.reads()).toBe(after);
    expect(worker.client.messages.get(PERSON).older).toBe("stored");
  } finally {
    await worker.runtime.stop().catch(() => {});
  }
});

test("a live message for a chat with no entry is dropped", async () => {
  const worker = await lane();
  try {
    // No `get()`, so no entry: the upsert has nowhere to go and memory grows
    // with what the application read rather than with account traffic.
    await seed(worker, PERSON, 2);
    // Reading now creates the entry, and it is empty — the two live messages
    // were dropped rather than retained behind the application's back.
    expect(worker.client.messages.get(PERSON).messages).toEqual([]);

    // From here the chat has an entry, so live traffic is retained.
    await seed(worker, PERSON, 1, { from: 2 });
    expect(texts(worker.client, PERSON)).toEqual(["t2"]);

    // And the two that were dropped are still in storage, so paging finds them.
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 3);
    expect(texts(worker.client, PERSON)).toEqual(["t2", "t1", "t0"]);
  } finally {
    await worker.stop();
  }
});

test("older() creates the entry before it reads, so no repair is dropped mid-read", async () => {
  const backend = heldReads(memoryBackend());
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 1);

    // `older()` on a chat with no entry at all. If the entry were created when
    // the page *commits* rather than when the read is *issued*, every patch
    // arriving during the read would hit the drop rule — and a page pinned
    // before them would then be permanently stale with nothing left to repair
    // it. This is the one window where mechanisms 1 and 2 strand.
    backend.hold("start");
    worker.client.messages.older(PERSON);
    await tick();

    await worker.driver.emit({
      type: "update",
      update: {
        kind: "edit",
        ref: { id: "m0", chatId: PERSON, fromMe: false },
        message: textMessage({ id: "m0", chatId: PERSON, text: "repaired", timestamp: AT }),
      },
    });
    await tick();

    backend.release();
    await until(() => worker.client.messages.get(PERSON).older !== "loading");

    // The edit that landed mid-read is held, and the page's older copy of the
    // same id did not put it back.
    expect(texts(worker.client, PERSON)).toEqual(["repaired"]);
  } finally {
    await worker.stop();
  }
});

test("retained messages are client-owned and frozen, from both writers", async () => {
  const worker = await lane();
  try {
    // Writer 1 — the live patch path. The entry exists, so it is retained.
    worker.client.messages.get(PERSON);
    await seed(worker, PERSON, 1);
    const live = worker.client.messages.get(PERSON).messages[0];
    // Asserted present before it is mutated below: with optional chaining, a
    // missing record would make the mutation throw `TypeError` and satisfy the
    // very assertion that is supposed to prove the freeze.
    assert.ok(live);
    expect(Object.isFrozen(live)).toBe(true);
    // Frozen all the way down, not just at the top: `receipts` and `reactions`
    // are the arrays a caller would reach for.
    expect(Object.isFrozen(live.reactions)).toBe(true);
    expect(Object.isFrozen(live.receipts)).toBe(true);
    // Reads hand back the stored value directly, so a caller reaching into it
    // would be reaching into committed Client state.
    expect(() => {
      (live.reactions as unknown as unknown[]).push({ subject: "x", emoji: "💥" });
    }).toThrow();
    expect(worker.client.messages.get(PERSON).messages[0]?.reactions.length).toBe(0);

    // Writer 2 — the page path, on a chat whose rows were dropped before it had
    // an entry and are therefore only reachable through a stored page.
    await seed(worker, PERSON_LID, 1, { from: 50, at: () => AT + 50 });
    worker.client.messages.older(PERSON_LID);
    await until(() => worker.client.messages.get(PERSON_LID).messages.length === 1);
    const paged = worker.client.messages.get(PERSON_LID).messages[0];
    assert.ok(paged);
    expect(Object.isFrozen(paged)).toBe(true);
    expect(Object.isFrozen(paged.reactions)).toBe(true);
    expect(() => {
      (paged.reactions as unknown as unknown[]).push({ subject: "x", emoji: "💥" });
    }).toThrow();
    expect(worker.client.messages.get(PERSON_LID).messages[0]?.reactions.length).toBe(0);
  } finally {
    await worker.stop();
  }
});

test("older() from inside a listener cannot split the delivery basis", async () => {
  // `older()` is the first public path that commits synchronously, so a
  // listener calling it — the infinite-scroll shape the issue documents — runs
  // a whole nested transition inside the outer fanout. Every listener in that
  // burst must still derive live state from one instant: re-sampling for the
  // nested delivery and then restoring the outer basis let a sibling watch a
  // presence expire, come back, and expire again with no live frame between.
  const worker = await lane({ freshnessMs: 5_000 });
  try {
    await worker.driver.emit({ type: "connection", status: { phase: "online" } });
    await worker.driver.emit({
      type: "presence",
      presence: { chatId: PERSON, kind: "typing", at: AT },
    });
    await tick();
    expect(worker.client.contacts.presence(PERSON)).toBe("typing");

    const seen: (string | undefined)[] = [];
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      worker.client.messages.get(ROOM);
      // Crosses the freshness deadline from inside the fanout, then commits a
      // nested transition — the exact pair the basis has to survive.
      worker.client.messages.subscribe(() => {
        skew += 10_000;
        worker.client.messages.older(ROOM);
      });
      worker.client.messages.subscribe(() => seen.push(worker.client.contacts.presence(PERSON)));

      worker.client.messages.get(PERSON);
      await seed(worker, PERSON, 1);
      await tick();
    } finally {
      Date.now = realNow;
    }

    // Never present after absent. The value may expire, but it may not come
    // back inside one synchronous burst with nothing having observed it again.
    const firstGone = seen.indexOf(undefined);
    expect(firstGone === -1 || seen.slice(firstGone).every((value) => value === undefined)).toBe(
      true,
    );
  } finally {
    await worker.stop();
  }
});

test("a listener that closes the client mid-mark stops the read being issued", async () => {
  // `older()` commits the `loading` mark before it reads, and that commit
  // fanouts synchronously — so a listener may close the Client (ADR-0029 rule
  // 1) in the window between the mark and the read. Without a second check the
  // read is then issued against a Backend whose lifetime the application owns
  // and may already have ended (ADR-0023).
  const backend = heldReads(memoryBackend());
  const worker = await lane({ backend });
  try {
    await seed(worker, PERSON, 30);
    worker.client.messages.older(PERSON);
    await until(() => worker.client.messages.get(PERSON).messages.length === 25);
    expect(worker.client.messages.get(PERSON).older).toBe("stored");

    worker.client.messages.subscribe(() => {
      if (worker.client.messages.get(PERSON).older === "loading") void worker.client.close();
    });

    const reads = backend.reads();
    worker.client.messages.older(PERSON);
    await tick();
    await tick();

    // No read reached storage, and the mark the listener interrupted was rolled
    // back rather than left claiming a load that can never finish.
    expect(backend.reads()).toBe(reads);
    expect(worker.client.messages.get(PERSON).older).toBe("stored");
    expect(worker.client.messages.get(PERSON).messages.length).toBe(25);
  } finally {
    await worker.runtime.stop().catch(() => {});
  }
});
