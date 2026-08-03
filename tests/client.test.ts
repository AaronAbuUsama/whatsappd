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
import { createWhatsAppRuntime, type WhatsAppRuntime } from "../src/runtime/runtime.ts";
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
  // `createWhatsAppRuntime()` makes, so a look-alike is not a runtime.
  await assert.rejects(
    createWhatsAppClient({ accountId: "personal" } as unknown as WhatsAppRuntime),
    TypeError,
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
  } finally {
    await worker.stop();
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
    const room = worker.client.chats.list().find((chat) => chat.chatId === ROOM);
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
    await worker.driver.emit({
      type: "contact",
      contact: { id: SELF, nativeIds: [SELF], displayName: "Me" },
    });
    await until(() => worker.client.contacts.list().length === 3);

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
  // The lease heartbeat is the only path that replaces a live claim, so its
  // interval is driven deliberately rather than waited on.
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

      // The account moves to a new claim. Neither observation expired, but
      // neither was made under the claim that now holds the account.
      leases.replace();
      mock.timers.tick(500);
      await until(() => worker.client.account.get().connection === undefined);

      expect(worker.client.account.get().connection).toBe(undefined);
      expect(worker.client.contacts.presence(PERSON)).toBe(undefined);
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

test("runtime closure is observable as account state and notifies once", async () => {
  const worker = await lane();
  try {
    let notified = 0;
    worker.client.account.subscribe(() => void (notified += 1));
    expect(worker.client.account.get().closed).toBe(false);

    await worker.runtime.stop();
    await tick();

    expect(worker.client.account.get().closed).toBe(true);
    expect(notified > 0).toBe(true);
  } finally {
    await worker.client.close();
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

    // The values a listener was handed, mutated from inside a delivery.
    worker.client.contacts.subscribe(() => {
      const inside = worker.client.contacts.resolve(PERSON);
      assert.throws(() => {
        (inside as { displayName?: string }).displayName = "Renamed by a listener";
      }, TypeError);
    });
    await worker.driver.emit({
      type: "contact",
      contact: { id: PERSON, nativeIds: [PERSON], displayName: "Person", username: "person" },
    });
    await tick();

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
