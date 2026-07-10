import type { BaileysEventMap } from "baileys";
import { expect, test } from "./_expect.ts";
import { toConversationSyncBatch } from "../src/baileys/history.ts";
import { baseMessage } from "./fixtures.ts";

type HistoryPayload = BaileysEventMap["messaging-history.set"];

test("conversation sync messages map as non-live batch messages", () => {
  const batch = toConversationSyncBatch({
    chats: [],
    contacts: [],
    messages: [
      baseMessage(
        {
          remoteJid: "123-456@g.us",
          participant: "1555@s.whatsapp.net",
          fromMe: true,
          id: "HIST1",
        },
        { conversation: "older message" },
      ),
    ],
  });

  const message = batch.messages[0];
  expect(message?.id).toBe("HIST1");
  expect(message?.chatId).toBe("123-456@g.us");
  expect(message?.from).toBe("1555@s.whatsapp.net");
  expect(message?.fromMe).toBe(true);
  expect(message?.live).toBe(false);
  expect(message?.isGroup).toBe(true);
  expect(message?.kind).toBe("text");
});

test("conversation sync chats and contacts map without leaking Baileys types", () => {
  const batch = toConversationSyncBatch({
    chats: [
      {
        id: "123-456@g.us",
        name: "Funding Group",
        conversationTimestamp: 1700,
        participants: [
          { id: "1555@s.whatsapp.net", admin: "admin" },
          { id: "1666@s.whatsapp.net" },
        ],
      } as HistoryPayload["chats"][number],
      {
        id: "1555@s.whatsapp.net",
        displayName: "Alice DM",
      } as HistoryPayload["chats"][number],
    ],
    contacts: [
      { id: "1555@s.whatsapp.net", name: "Alice" },
      { id: "1666@s.whatsapp.net", notify: "Bob" },
    ] as HistoryPayload["contacts"],
    messages: [],
  });

  expect(batch.chats[0]).toEqual({
    id: "123-456@g.us",
    subject: "Funding Group",
    isGroup: true,
    lastMessageAt: 1_700_000,
    participants: [{ id: "1555@s.whatsapp.net", role: "admin" }, { id: "1666@s.whatsapp.net" }],
  });
  expect(batch.chats[1]).toMatchObject({ id: "1555@s.whatsapp.net", isGroup: false });
  expect(batch.contacts).toEqual([
    { id: "1555@s.whatsapp.net", displayName: "Alice" },
    { id: "1666@s.whatsapp.net", displayName: "Bob" },
  ]);
  expect(batch.messages).toEqual([]);
});

test("conversation sync batches keep chats, contacts, and non-live messages together", () => {
  const batch = toConversationSyncBatch({
    chats: [
      {
        id: "123-456@g.us",
        name: "Funding Group",
        conversationTimestamp: 1700,
      } as HistoryPayload["chats"][number],
    ],
    contacts: [{ id: "1555@s.whatsapp.net", name: "Alice" }] as HistoryPayload["contacts"],
    messages: [
      baseMessage(
        {
          remoteJid: "123-456@g.us",
          participant: "1555@s.whatsapp.net",
          fromMe: true,
          id: "HIST1",
        },
        { conversation: "older message" },
      ),
    ],
  });

  expect(batch.chats.length).toBe(1);
  expect(batch.contacts.length).toBe(1);
  expect(batch.messages.length).toBe(1);
  expect(batch.messages[0]).toMatchObject({
    id: "HIST1",
    chatId: "123-456@g.us",
    from: "1555@s.whatsapp.net",
    live: false,
  });
});
