import { expect, test } from "./_expect.ts";
import { mapPresenceUpdate } from "../src/baileys/presence.ts";

test("maps Baileys presence updates into pure presence signals", () => {
  expect(
    mapPresenceUpdate(
      {
        id: "chat-1@g.us",
        presences: {
          "1555@s.whatsapp.net": { lastKnownPresence: "composing" },
          "1666@s.whatsapp.net": { lastKnownPresence: "recording" },
          "1777@s.whatsapp.net": { lastKnownPresence: "paused" },
        },
      },
      123,
    ),
  ).toEqual([
    {
      chatId: "chat-1@g.us",
      participant: "1555@s.whatsapp.net",
      kind: "typing",
      at: 123,
    },
    {
      chatId: "chat-1@g.us",
      participant: "1666@s.whatsapp.net",
      kind: "recording",
      at: 123,
    },
    {
      chatId: "chat-1@g.us",
      participant: "1777@s.whatsapp.net",
      kind: "idle",
      at: 123,
    },
  ]);
});

test("ignores malformed or unknown presence updates", () => {
  expect(mapPresenceUpdate({ presences: {} }, 123)).toEqual([]);
  expect(
    mapPresenceUpdate(
      { id: "chat-1", presences: { "1555@s.whatsapp.net": { lastKnownPresence: "mystery" } } },
      123,
    ),
  ).toEqual([]);
});
