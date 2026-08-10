import { expect, test } from "./_expect.ts";
import { mapContactUpdates } from "../src/baileys/contacts.ts";

test("maps Baileys contact upserts into pure contact updates", () => {
  expect(
    mapContactUpdates(
      [
        {
          id: "abc@lid",
          lid: "abc@lid",
          phoneNumber: "1555@s.whatsapp.net",
          name: "Maya Chen",
          notify: "Maya",
          verifiedName: "Maya Ltd",
          username: "maya",
          imgUrl: "changed",
          status: "Available",
        },
      ],
      123,
    ),
  ).toEqual([
    {
      id: "abc@lid",
      nativeIds: ["abc@lid", "1555@s.whatsapp.net"],
      displayName: "Maya Chen",
      profileName: "Maya",
      verifiedName: "Maya Ltd",
      username: "maya",
      imgUrl: "changed",
      status: "Available",
      at: 123,
    },
  ]);
});

test("ignores contact updates without any usable identity", () => {
  expect(mapContactUpdates([{ name: "No id" }], 123)).toEqual([]);
});

test("ignores group, broadcast, and channel addresses in contact updates", () => {
  expect(
    mapContactUpdates(
      [
        { id: "room@g.us", name: "Room" },
        { id: "status@broadcast", name: "Status" },
        { id: "news@newsletter", name: "News" },
        { id: "1555@s.whatsapp.net", name: "Person" },
      ],
      123,
    ),
  ).toEqual([
    {
      id: "1555@s.whatsapp.net",
      nativeIds: ["1555@s.whatsapp.net"],
      displayName: "Person",
      at: 123,
    },
  ]);
});

test("native ids are trimmed and fall back from an empty primary form", () => {
  expect(
    mapContactUpdates(
      [{ id: "   ", phoneNumber: " 1555@s.whatsapp.net ", lid: " 55555@lid " }],
      123,
    )[0],
  ).toMatchObject({
    id: "1555@s.whatsapp.net",
    nativeIds: ["1555@s.whatsapp.net", "55555@lid"],
  });
});

test("falls back to profile names when the saved address-book name is missing", () => {
  expect(
    mapContactUpdates([{ id: "1555@s.whatsapp.net", notify: "Remote Name" }], 123)[0],
  ).toMatchObject({
    id: "1555@s.whatsapp.net",
    nativeIds: ["1555@s.whatsapp.net"],
    profileName: "Remote Name",
  });
});
