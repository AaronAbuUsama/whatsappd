import { proto, type BaileysEventMap } from "baileys";
import { expect, test } from "./_expect.ts";
import {
  shouldRequestFullHistoryOnOpen,
  toMessagingHistoryEvents,
  toMessagingHistoryStatusEvents,
  toMessagesUpsertEvents,
} from "../src/baileys/socket.ts";
import { baseMessage } from "./fixtures.ts";

type HistoryPayload = BaileysEventMap["messaging-history.set"];
type HistoryStatusPayload = BaileysEventMap["messaging-history.status"];
type MessagesUpsert = BaileysEventMap["messages.upsert"];

test("fresh Desktop registration defers full-history until companion registration completes", () => {
  expect(shouldRequestFullHistoryOnOpen({ creds: {} })).toBe(false);
  expect(
    shouldRequestFullHistoryOnOpen({
      creds: { me: { id: "15551234567:1@s.whatsapp.net", name: "~" } },
    }),
  ).toBe(false);
  expect(
    shouldRequestFullHistoryOnOpen({
      creds: { registered: false, me: { id: "15551234567:1@s.whatsapp.net", name: "~" } },
    }),
  ).toBe(false);
  expect(
    shouldRequestFullHistoryOnOpen({
      creds: { registered: true, me: { id: "15551234567:1@s.whatsapp.net", name: "~" } },
    }),
  ).toBe(true);
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

  const events = toMessagingHistoryEvents(payload);

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
  const events = toMessagingHistoryEvents({
    chats: [],
    contacts: [],
    messages: [],
    isLatest: false,
    progress: 42,
  } as HistoryPayload);

  expect(events).toEqual([{ t: "conversation_sync_progress", progress: 42 }]);
});

test("messaging-history.set completion remains a status signal without a data batch", () => {
  const events = toMessagingHistoryEvents({
    chats: [],
    contacts: [],
    messages: [],
    isLatest: true,
    progress: 100,
  } as HistoryPayload);

  expect(events).toEqual([{ t: "conversation_sync_complete" }]);
});

test("messaging-history.set isLatest alone does not mark sync complete", () => {
  const events = toMessagingHistoryEvents({
    chats: [],
    contacts: [],
    messages: [],
    isLatest: true,
    progress: null,
  } as HistoryPayload);

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
  const events = toMessagesUpsertEvents({
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
  } as MessagesUpsert);

  expect(events.length).toBe(1);
  expect(events[0]?.t).toBe("message");
  if (events[0]?.t !== "message") throw new Error("expected live message");
  expect(events[0].msg).toMatchObject({
    id: "LIVE1",
    chatId: "1555@s.whatsapp.net",
    live: true,
  });
});

test("messages.upsert append emits historical messages through conversation sync only", () => {
  const events = toMessagesUpsertEvents({
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
  } as MessagesUpsert);

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
    from: "1555@s.whatsapp.net",
    fromMe: true,
    live: false,
    isGroup: true,
    kind: "text",
  });
});
