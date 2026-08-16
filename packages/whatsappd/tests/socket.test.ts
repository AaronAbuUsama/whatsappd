import {
  Browsers,
  getCompanionPlatformId,
  proto,
  type BaileysEventMap,
  type WASocket,
} from "baileys";
import assert from "node:assert/strict";
import pino from "pino";
import { expect, test } from "./_expect.ts";
import {
  browserForOpen,
  openSocketWith,
  shouldRequestFullHistoryOnOpen,
  toMessagingHistoryEvents,
  toMessagingHistoryStatusEvents,
  toMessagesUpsertEvents,
} from "../src/baileys/socket.ts";
import { loadAuth } from "../src/baileys/auth-state.ts";
import { memoryStore } from "../src/stores/memory.ts";
import { baseMessage, SELF } from "./fixtures.ts";

type HistoryPayload = BaileysEventMap["messaging-history.set"];
type HistoryStatusPayload = BaileysEventMap["messaging-history.status"];
type MessagesUpsert = BaileysEventMap["messages.upsert"];

test("only unregistered pairing-code sockets use WhatsApp's canonical web companion platform", () => {
  expect(getCompanionPlatformId(browserForOpen("pairing_code", { creds: {} }))).toBe("1");
  expect(browserForOpen("pairing_code", { creds: { registered: true } })).toEqual(
    Browsers.macOS("Desktop"),
  );
  expect(browserForOpen("qr", { creds: {} })).toEqual(Browsers.macOS("Desktop"));
});

const PAIRED_ME = { id: "15551234567:1@s.whatsapp.net", name: "~" };

test("fresh companion registration defers full-history until registration completes", () => {
  // Pairing-code only: `creds.me` is written from the typed phone number before
  // the user enters the code, so it cannot stand for "pairing finished" here.
  // Asking mid-registration is what leaves the phone stuck at "logging in".
  expect(shouldRequestFullHistoryOnOpen("pairing_code", { creds: {} })).toBe(false);
  expect(shouldRequestFullHistoryOnOpen("pairing_code", { creds: { me: PAIRED_ME } })).toBe(false);
  expect(
    shouldRequestFullHistoryOnOpen("pairing_code", { creds: { registered: false, me: PAIRED_ME } }),
  ).toBe(false);
  expect(
    shouldRequestFullHistoryOnOpen("pairing_code", { creds: { registered: true, me: PAIRED_ME } }),
  ).toBe(true);
});

test("a QR-paired credential requests full history even though `registered` stays false", () => {
  // #203: Baileys sets `creds.registered` only in the pairing-code companion
  // finish handler, so a QR credential holds `false` for its whole life. Gating
  // QR on it capped every QR-paired account at the short sync, silently, while
  // Baileys' own default for `syncFullHistory` is `true`. For QR, `creds.me` is
  // written from the server's pair-success stanza and never before it.
  expect(
    shouldRequestFullHistoryOnOpen("qr", { creds: { registered: false, me: PAIRED_ME } }),
  ).toBe(true);
  expect(shouldRequestFullHistoryOnOpen("qr", { creds: { me: PAIRED_ME } })).toBe(true);

  // Not yet paired: no identity, so nothing to sync a history for.
  expect(shouldRequestFullHistoryOnOpen("qr", { creds: {} })).toBe(false);
  expect(shouldRequestFullHistoryOnOpen("qr", { creds: { me: null } })).toBe(false);
  expect(shouldRequestFullHistoryOnOpen("qr", { creds: { me: { id: "" } } })).toBe(false);
});

test("the open socket carries syncFullHistory for a QR-paired credential", async () => {
  // The predicate above is only half the fix; the other half is that the call
  // site passes the auth method at all. This asserts what Baileys is actually
  // constructed with, which is the thing the phone answers to.
  const socket = { ev: { on() {} }, end() {} } as unknown as WASocket;
  const openWith = async (
    authMethod: "qr" | "pairing_code",
    creds: Record<string, unknown>,
  ): Promise<boolean> => {
    const auth = await loadAuth(memoryStore());
    let syncFullHistory: boolean | undefined;
    await openSocketWith(
      {
        auth: { creds: { ...auth.creds, ...creds }, keys: auth.keys },
        authMethod,
        logger: pino({ level: "silent" }),
        saveCreds: async () => {},
      },
      {
        fetchLatestVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
        makeSocket: ((config: { syncFullHistory?: boolean }) => {
          syncFullHistory = config.syncFullHistory;
          return socket;
        }) as never,
      },
    );
    return syncFullHistory === true;
  };

  expect(await openWith("qr", { registered: false, me: PAIRED_ME })).toBe(true);
  expect(await openWith("qr", { me: undefined })).toBe(false);
  expect(await openWith("pairing_code", { registered: false, me: PAIRED_ME })).toBe(false);
  expect(await openWith("pairing_code", { registered: true, me: PAIRED_ME })).toBe(true);
});

test("openSocket end drains late credential writes and keeps the first rejection", async () => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let socketEnds = 0;
  const socket = {
    ev: {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    },
    end() {
      socketEnds++;
    },
  } as unknown as WASocket;
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  let firstStarted!: () => void;
  const didStartFirst = new Promise<void>((resolve) => (firstStarted = resolve));
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => (releaseFirst = resolve));
  const firstFailure = new Error("first credential write failed");
  let writes = 0;
  const auth = await loadAuth(memoryStore());
  const conn = await openSocketWith(
    {
      auth: { creds: auth.creds, keys: auth.keys },
      authMethod: "qr",
      logger: pino({ level: "silent" }),
      saveCreds: async () => {
        writes++;
        if (writes === 1) {
          firstStarted();
          await firstBarrier;
          throw firstFailure;
        }
      },
    },
    {
      fetchLatestVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
      makeSocket: (() => socket) as never,
    },
  );

  emit("creds.update", {});
  await didStartFirst;
  const ending = conn.end();
  emit("creds.update", {}); // arrived after end() began draining
  releaseFirst();

  await assert.rejects(Promise.resolve(ending), firstFailure);
  await assert.rejects(Promise.resolve(conn.end()), firstFailure);
  expect(writes).toBe(2);
  expect(socketEnds).toBe(1);
});

test("messaging-history.set emits one conversation sync batch and no inbound message event", () => {
  const payload = {
    chats: [
      {
        id: "123-456@g.us",
        name: "Funding Group",
        conversationTimestamp: 1700,
      },
    ],
    contacts: [{ id: "1555@s.whatsapp.net", name: "Alice" }],
    messages: [
      baseMessage(
        {
          remoteJid: "123-456@g.us",
          participant: "1555@s.whatsapp.net",
          fromMe: true,
          id: "HIST1",
        },
        { conversation: "older message 1" },
      ),
      baseMessage(
        {
          remoteJid: "123-456@g.us",
          participant: "1666@s.whatsapp.net",
          fromMe: false,
          id: "HIST2",
        },
        { conversation: "older message 2" },
      ),
    ],
    isLatest: false,
    progress: 50,
  } as HistoryPayload;

  const events = toMessagingHistoryEvents(payload, SELF);

  expect(events.some((event) => event.t === "message")).toBe(false);
  expect(events.filter((event) => event.t === "conversation_sync").length).toBe(1);
  expect(
    events.some((event) => event.t === "conversation_sync_progress" && event.progress === 50),
  ).toBe(true);
  const syncEvent = events.find((event) => event.t === "conversation_sync");
  if (syncEvent?.t !== "conversation_sync") throw new Error("expected conversation sync");
  expect(syncEvent.sync.chats.length).toBe(1);
  expect(syncEvent.sync.contacts.length).toBe(1);
  expect(syncEvent.sync.messages.map((message) => message.id)).toEqual(["HIST1", "HIST2"]);
  expect(syncEvent.sync.messages.every((message) => message.live === false)).toBe(true);
});

test("messaging-history.set progress without data remains status-only", () => {
  const events = toMessagingHistoryEvents(
    {
      chats: [],
      contacts: [],
      messages: [],
      isLatest: false,
      progress: 42,
    } as HistoryPayload,
    SELF,
  );

  expect(events).toEqual([{ t: "conversation_sync_progress", progress: 42 }]);
});

test("messaging-history.set completion remains a status signal without a data batch", () => {
  const events = toMessagingHistoryEvents(
    {
      chats: [],
      contacts: [],
      messages: [],
      isLatest: true,
      progress: 100,
    } as HistoryPayload,
    SELF,
  );

  expect(events).toEqual([{ t: "conversation_sync_complete" }]);
});

test("messaging-history.set isLatest alone does not mark sync complete", () => {
  const events = toMessagingHistoryEvents(
    {
      chats: [],
      contacts: [],
      messages: [],
      isLatest: true,
      progress: null,
    } as HistoryPayload,
    SELF,
  );

  expect(events).toEqual([]);
});

test("RECENT messaging-history.status completes the sync gate", () => {
  const events = toMessagingHistoryStatusEvents({
    syncType: proto.HistorySync.HistorySyncType.RECENT,
    status: "complete",
    explicit: true,
  } as HistoryStatusPayload);

  expect(events).toEqual([{ t: "conversation_sync_complete" }]);
});

test("INITIAL_BOOTSTRAP messaging-history.status does not complete the recent sync gate", () => {
  const events = toMessagingHistoryStatusEvents({
    syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    status: "complete",
    explicit: true,
  } as HistoryStatusPayload);

  expect(events).toEqual([]);
});

test("messages.upsert notify still emits live inbound messages", () => {
  const events = toMessagesUpsertEvents(
    {
      type: "notify",
      messages: [
        baseMessage(
          {
            remoteJid: "1555@s.whatsapp.net",
            fromMe: false,
            id: "LIVE1",
          },
          { conversation: "live message" },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events.length).toBe(1);
  expect(events[0]?.t).toBe("message");
  if (events[0]?.t !== "message") throw new Error("expected live message");
  expect(events[0].msg).toMatchObject({
    id: "LIVE1",
    chatId: "1555@s.whatsapp.net",
    live: true,
  });
});

test("messages.upsert notify does not duplicate reaction controls as transcript rows", () => {
  const events = toMessagesUpsertEvents(
    {
      type: "notify",
      messages: [
        baseMessage(
          {
            remoteJid: "1555@s.whatsapp.net",
            fromMe: false,
            id: "REACTION1",
          },
          {
            reactionMessage: {
              key: {
                remoteJid: "1555@s.whatsapp.net",
                fromMe: true,
                id: "TARGET1",
              },
              text: "👍",
              senderTimestampMs: 1_700_000,
            },
          },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events).toEqual([]);
});

test("messages.upsert notify does not duplicate edit and revoke protocols as transcript rows", () => {
  const target = { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "TARGET1" };
  const events = toMessagesUpsertEvents(
    {
      type: "notify",
      messages: [
        baseMessage(
          { ...target, id: "EDIT1" },
          {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
              key: target,
              editedMessage: { conversation: "fixed text" },
              timestampMs: 1_700_000,
            },
          },
        ),
        baseMessage(
          { ...target, id: "REVOKE1" },
          {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.REVOKE,
              key: target,
            },
          },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events).toEqual([]);
});

test("messages.upsert notify hides known protocol and poll controls", () => {
  const events = toMessagesUpsertEvents(
    {
      type: "notify",
      messages: [
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "EPHEMERAL1" },
          {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
              ephemeralExpiration: 86_400,
            },
          },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "POLL-VOTE1" },
          {
            pollUpdateMessage: {
              pollCreationMessageKey: {
                remoteJid: "1555@s.whatsapp.net",
                fromMe: false,
                id: "POLL1",
              },
            },
          },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events).toEqual([]);
});

test("messages.upsert notify emits a decryptable poll vote as a target update", () => {
  const poll = baseMessage(
    {
      remoteJid: "room@g.us",
      participant: "creator@s.whatsapp.net",
      fromMe: false,
      id: "POLL1",
    },
    {
      messageContextInfo: {
        messageSecret: Buffer.from(
          "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          "hex",
        ),
      },
      pollCreationMessage: {
        name: "Lunch?",
        options: [{ optionName: "Waakye" }, { optionName: "Jollof" }],
        selectableOptionsCount: 1,
      },
    },
  );
  const vote = baseMessage(
    {
      remoteJid: "room@g.us",
      participant: "voter@s.whatsapp.net",
      fromMe: false,
      id: "VOTE1",
    },
    {
      pollUpdateMessage: {
        pollCreationMessageKey: poll.key,
        vote: {
          encIv: Buffer.from("000102030405060708090a0b", "hex"),
          encPayload: Buffer.from(
            "c35ede711e4cbcb6184519d5af449b8f97d33bd3c07ce66c078b7efc69172b73cc411bd2f7a099058af081ddbbfd9f9c2ca5",
            "hex",
          ),
        },
        senderTimestampMs: 1_700_000_001_000,
      },
    },
  );

  const events = toMessagesUpsertEvents(
    { type: "notify", messages: [vote] } as MessagesUpsert,
    SELF,
    undefined,
    (ref) => (ref.id === "POLL1" ? poll : undefined),
  );

  expect(events).toEqual([
    {
      t: "update",
      update: {
        kind: "poll_votes",
        ref: {
          chatId: "room@g.us",
          id: "POLL1",
          fromMe: false,
          participant: "creator@s.whatsapp.net",
        },
        votes: [
          {
            by: "voter@s.whatsapp.net",
            selectedOptionIds: ["d18003aabfd6c7e9c5cba811355a4a6061237d3463652a59cf12af00b656c027"],
            at: 1_700_000_001_000,
          },
        ],
      },
    },
  ]);
});

test("messages.upsert notify preserves live fromMe messages", () => {
  const events = toMessagesUpsertEvents(
    {
      type: "notify",
      messages: [
        baseMessage(
          {
            remoteJid: "1555@s.whatsapp.net",
            fromMe: true,
            id: "SELF1",
          },
          { conversation: "ping" },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events.length).toBe(1);
  expect(events[0]).toMatchObject({
    t: "message",
    msg: {
      id: "SELF1",
      chatId: "1555@s.whatsapp.net",
      fromMe: true,
      live: true,
      kind: "text",
      text: "ping",
    },
  });
});

test("messages.upsert append emits historical messages through conversation sync only", () => {
  const events = toMessagesUpsertEvents(
    {
      type: "append",
      messages: [
        baseMessage(
          {
            remoteJid: "123-456@g.us",
            participant: "1555@s.whatsapp.net",
            fromMe: true,
            id: "APPEND1",
          },
          { conversation: "older append message" },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events.some((event) => event.t === "message")).toBe(false);
  expect(events.length).toBe(1);
  expect(events[0]?.t).toBe("conversation_sync");
  if (events[0]?.t !== "conversation_sync") throw new Error("expected conversation sync");
  expect(events[0].sync.chats).toEqual([]);
  expect(events[0].sync.contacts).toEqual([]);
  expect(events[0].sync.messages.length).toBe(1);
  expect(events[0].sync.messages[0]).toMatchObject({
    id: "APPEND1",
    chatId: "123-456@g.us",
    sender: { id: SELF.id }, // fromMe: the appended history names the linked account
    fromMe: true,
    live: false,
    isGroup: true,
    kind: "text",
  });
});

test("messages.upsert append keeps target updates inside the historical batch", () => {
  const events = toMessagesUpsertEvents(
    {
      type: "append",
      messages: [
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: true, id: "TARGET1" },
          { conversation: "saved message" },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "REACTION1" },
          {
            reactionMessage: {
              key: { remoteJid: "1555@s.whatsapp.net", fromMe: true, id: "TARGET1" },
              text: "👍",
            },
          },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "EDIT-TARGET" },
          { conversation: "before" },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "EDIT1" },
          {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
              key: { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "EDIT-TARGET" },
              editedMessage: { conversation: "after" },
            },
          },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "REVOKE-TARGET" },
          { conversation: "remove me" },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "REVOKE1" },
          {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.REVOKE,
              key: { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "REVOKE-TARGET" },
            },
          },
        ),
        baseMessage(
          { remoteJid: "1555@s.whatsapp.net", fromMe: false, id: "EPHEMERAL1" },
          {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
              ephemeralExpiration: 86_400,
            },
          },
        ),
      ],
    } as MessagesUpsert,
    SELF,
  );

  expect(events.length).toBe(1);
  if (events[0]?.t !== "conversation_sync") throw new Error("expected conversation sync");
  expect(events[0].sync.messages.map((message) => message.id)).toEqual([
    "TARGET1",
    "EDIT-TARGET",
    "REVOKE-TARGET",
  ]);
  expect(events[0].sync.updates).toMatchObject([
    {
      kind: "reaction",
      ref: { id: "TARGET1", chatId: "1555@s.whatsapp.net", fromMe: true },
      emoji: "👍",
      removed: false,
    },
    {
      kind: "edit",
      ref: { id: "EDIT-TARGET", chatId: "1555@s.whatsapp.net", fromMe: false },
      message: { kind: "text", text: "after", live: false },
    },
    {
      kind: "revoke",
      ref: { id: "REVOKE-TARGET", chatId: "1555@s.whatsapp.net", fromMe: false },
      by: "1555@s.whatsapp.net",
    },
  ]);
});
