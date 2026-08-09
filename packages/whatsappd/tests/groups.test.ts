import { expect, test } from "./_expect.ts";
import { mapGroupMetadataUpdates, mapGroupParticipantsUpdate } from "../src/baileys/groups.ts";

test("maps group metadata updates into pure group updates", () => {
  expect(
    mapGroupMetadataUpdates(
      [
        {
          id: "12345@g.us",
          subject: "Launch Ops",
          participants: [
            { id: "111@s.whatsapp.net", admin: "admin" },
            { id: "222@s.whatsapp.net" },
          ],
        },
      ],
      123,
    ),
  ).toEqual([
    {
      kind: "metadata",
      id: "12345@g.us",
      subject: "Launch Ops",
      participants: [{ id: "111@s.whatsapp.net", role: "admin" }, { id: "222@s.whatsapp.net" }],
      at: 123,
    },
  ]);
});

test("maps participant updates into pure group updates", () => {
  expect(
    mapGroupParticipantsUpdate(
      {
        id: "12345@g.us",
        action: "promote",
        participants: [{ id: "111@s.whatsapp.net", isAdmin: true }],
      },
      456,
    ),
  ).toEqual({
    kind: "participants",
    id: "12345@g.us",
    action: "promote",
    participants: [{ id: "111@s.whatsapp.net", role: "admin" }],
    at: 456,
  });
});

test("ignores participant updates without a modeled action or participant", () => {
  expect(mapGroupParticipantsUpdate({ id: "12345@g.us", action: "invite", participants: [] })).toBe(
    undefined,
  );
  expect(mapGroupParticipantsUpdate({ id: "12345@g.us", action: "add" })).toBe(undefined);
});
