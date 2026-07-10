import { expect, test } from "./_expect.ts";
import { createChannelAdapter } from "../src/channel/adapter.ts";
import type { ChannelEvent } from "../src/channel/types.ts";
import type { WhatsAppSession } from "../src/session.ts";
import type {
  ConnectionEvent,
  ContactUpdate,
  ConversationSyncBatch,
  GroupUpdate,
  InboundMessage,
  PresenceUpdate,
  Update,
} from "../src/model/index.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

class Ctl<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private resolve?: (r: IteratorResult<T>) => void;
  private done = false;
  push(v: T): void {
    if (this.resolve) {
      this.resolve({ value: v, done: false });
      this.resolve = undefined;
    } else this.buf.push(v);
  }
  close(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve({ value: undefined as never, done: true });
      this.resolve = undefined;
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const q = this.buf.shift();
        if (q !== undefined) return Promise.resolve({ value: q, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => (this.resolve = r));
      },
    };
  }
}

interface Fake {
  session: WhatsAppSession;
  conn: Ctl<ConnectionEvent>;
  inb: Ctl<InboundMessage>;
  upd: Ctl<Update>;
  started: number;
  stopped: number;
  sent: { to: string; msg: unknown; opts?: unknown }[];
  markedRead: unknown[];
  typingSet: { chatId: string; on: boolean }[];
}

function makeFake(): Fake {
  const conn = new Ctl<ConnectionEvent>();
  const inb = new Ctl<InboundMessage>();
  const sync = new Ctl<ConversationSyncBatch>();
  const upd = new Ctl<Update>();
  const cnt = new Ctl<ContactUpdate>();
  const grp = new Ctl<GroupUpdate>();
  const pre = new Ctl<PresenceUpdate>();
  const fake: Fake = {
    conn,
    inb,
    upd,
    started: 0,
    stopped: 0,
    sent: [],
    markedRead: [],
    typingSet: [],
    session: undefined as unknown as WhatsAppSession,
  };
  fake.session = {
    get status() {
      return { phase: "disconnected" } as const;
    },
    connection: conn,
    inbound: inb,
    conversationSync: sync,
    updates: upd,
    contacts: cnt,
    groups: grp,
    presence: pre,
    onStatus: () => () => {},
    onMessage: () => () => {},
    onUpdate: () => () => {},
    onConversationSync: () => () => {},
    onContact: () => () => {},
    onGroup: () => () => {},
    onPresence: () => () => {},
    start: async () => {
      fake.started++;
    },
    send: async (to, msg, opts) => {
      fake.sent.push({ to, msg, opts });
      return { id: "MSG1", chatId: to, fromMe: true };
    },
    markRead: async (refs) => {
      fake.markedRead.push(refs);
    },
    setTyping: async (chatId, on) => {
      fake.typingSet.push({ chatId, on });
    },
    groupMetadata: async (chatId) => ({ id: chatId, participants: [] }),
    profilePictureUrl: async () => undefined,
    identity: () => undefined,
    stop: async () => {
      fake.stopped++;
      conn.close();
      inb.close();
      sync.close();
      upd.close();
      cnt.close();
      grp.close();
      pre.close();
    },
  };
  return fake;
}

function fakeInbound(chatId: string, from: string, text: string, isGroup = false): InboundMessage {
  return {
    id: "M1",
    chatId,
    from,
    fromMe: false,
    timestamp: 100,
    live: true,
    isGroup,
    kind: "text",
    text,
  } as InboundMessage;
}

test("start starts the session (once)", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });

  await adapter.start();
  await adapter.start(); // idempotent
  expect(fake.started).toBe(1);
  await adapter.stop();
});

test("send delegates to the session and returns a MessageRef", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  const ref = await adapter.send("chat@s.whatsapp.net", { text: "hello" });
  expect(ref.id).toBe("MSG1");
  expect(ref.chatId).toBe("chat@s.whatsapp.net");
  expect(fake.sent.length).toBe(1);
  expect(fake.sent[0]!.to).toBe("chat@s.whatsapp.net");
  expect((fake.sent[0]!.msg as { text: string }).text).toBe("hello");

  await adapter.stop();
});

test("markRead delegates to the session", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  await adapter.markRead("chat@s.whatsapp.net");
  expect(fake.markedRead.length).toBe(1);

  await adapter.stop();
});

test("setTyping maps typing/recording to on=true, others to on=false", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  await adapter.setTyping("chat@s.whatsapp.net", "typing");
  await adapter.setTyping("chat@s.whatsapp.net", "recording");
  await adapter.setTyping("chat@s.whatsapp.net", "idle");

  expect(fake.typingSet.length).toBe(3);
  expect(fake.typingSet[0]!.on).toBe(true);
  expect(fake.typingSet[1]!.on).toBe(true);
  expect(fake.typingSet[2]!.on).toBe(false);

  await adapter.stop();
});

test("subscribe receives message events from the inbound stream", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  const events: ChannelEvent[] = [];
  const unsub = adapter.subscribe({
    onEvent(e) {
      events.push(e);
    },
  });

  fake.inb.push(fakeInbound("chat@s.whatsapp.net", "sender@s.whatsapp.net", "hello"));
  await tick();

  const msgEvent = events.find((e) => e.type === "message");
  expect(msgEvent === undefined).toBe(false);
  expect(msgEvent!.type).toBe("message");
  if (msgEvent!.type === "message") {
    expect(msgEvent!.ref.chatId).toBe("chat@s.whatsapp.net");
    expect(msgEvent!.ref.isGroup).toBe(false);
    expect(msgEvent!.ref.from).toBe("sender@s.whatsapp.net");
    expect((msgEvent!.message as { text: string }).text).toBe("hello");
  }

  unsub();
  await adapter.stop();
});

test("subscribe receives status events tagged with the accountId", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  const events: ChannelEvent[] = [];
  adapter.subscribe({ onEvent: (e) => void events.push(e) });

  fake.conn.push({ phase: "online" });
  await tick();

  const statusEvent = events.find((e) => e.type === "status");
  expect(statusEvent === undefined).toBe(false);
  if (statusEvent!.type === "status") {
    expect(statusEvent!.status.phase).toBe("online");
    expect(statusEvent!.accountId).toBe("acc1");
  }

  await adapter.stop();
});

test("subscribe receives update events with refs", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  const events: ChannelEvent[] = [];
  adapter.subscribe({ onEvent: (e) => void events.push(e) });

  fake.upd.push({
    kind: "receipt",
    ref: { id: "M1", chatId: "chat@s.whatsapp.net", fromMe: true },
    status: "read",
  });
  await tick();

  const updateEvent = events.find((e) => e.type === "update");
  expect(updateEvent === undefined).toBe(false);
  if (updateEvent!.type === "update") {
    expect(updateEvent!.ref.chatId).toBe("chat@s.whatsapp.net");
    expect(updateEvent!.update.kind).toBe("receipt");
  }

  await adapter.stop();
});

test("multiple subscribers each receive events", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  const events1: ChannelEvent[] = [];
  const events2: ChannelEvent[] = [];
  const unsub1 = adapter.subscribe({ onEvent: (e) => void events1.push(e) });
  const unsub2 = adapter.subscribe({ onEvent: (e) => void events2.push(e) });

  fake.inb.push(fakeInbound("c@s.whatsapp.net", "s@s.whatsapp.net", "hi"));
  await tick();

  expect(events1.length).toBe(1);
  expect(events2.length).toBe(1);

  unsub1();
  fake.inb.push(fakeInbound("c@s.whatsapp.net", "s@s.whatsapp.net", "second"));
  await tick();

  expect(events1.length).toBe(1); // unsubscribed
  expect(events2.length).toBe(2); // still subscribed

  unsub2();
  await adapter.stop();
});

test("send before start throws", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });

  let threw = false;
  try {
    await adapter.send("c@s.whatsapp.net", { text: "x" });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(fake.sent.length).toBe(0);
});

test("stop tears down the session", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  await adapter.stop();
  expect(fake.stopped).toBe(1);
});

test("group messages carry isGroup=true and from=participant", async () => {
  const fake = makeFake();
  const adapter = createChannelAdapter({ session: fake.session, accountId: "acc1" });
  await adapter.start();

  const events: ChannelEvent[] = [];
  adapter.subscribe({ onEvent: (e) => void events.push(e) });

  fake.inb.push(fakeInbound("group@g.us", "person@s.whatsapp.net", "group msg", true));
  await tick();

  const msgEvent = events.find((e) => e.type === "message");
  expect(msgEvent === undefined).toBe(false);
  if (msgEvent!.type === "message") {
    expect(msgEvent!.ref.isGroup).toBe(true);
    expect(msgEvent!.ref.chatId).toBe("group@g.us");
    expect(msgEvent!.ref.from).toBe("person@s.whatsapp.net");
  }

  await adapter.stop();
});
