import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import {
  StaleAccountClaimError,
  type WhatsAppDataEvent,
  type WhatsAppDataStore,
  type WhatsAppDurableEvent,
} from "../src/runtime/contracts.ts";
import { textMessage } from "../src/testing.ts";

const ACCOUNT = "personal";
const OTHER_ACCOUNT = "work";
const PN = "15551230000@s.whatsapp.net";
const LID = "55555@lid";
const ROOM = "room@g.us";
const AT = 1_700_000_000_000;

interface DataStoreResource {
  readonly data: WhatsAppDataStore;
  close(): Promise<void>;
}

type DataStoreFactory = () => Promise<DataStoreResource>;

const observed = (event: WhatsAppDurableEvent, observedAt = AT): WhatsAppDataEvent => ({
  observedAt,
  event,
});

export function dataStoreConformance(name: string, create: DataStoreFactory): void {
  test(`[${name}] every supported event kind crosses one acceptance boundary`, async () => {
    const resource = await create();
    try {
      const accepted = await resource.data.accept(
        ACCOUNT,
        [
          observed({ type: "contact", contact: { id: PN, nativeIds: [PN], displayName: "Peer" } }),
          observed({ type: "last_seen", contactId: PN, at: AT }),
          observed({
            type: "group",
            group: {
              kind: "metadata",
              id: ROOM,
              subject: "Room",
              participants: [{ id: PN, role: "admin" }],
              at: AT,
            },
          }),
          observed({
            type: "conversation_sync",
            batch: {
              context: { source: "recent", projection: { mode: "upsert" } },
              chats: [{ id: PN, isGroup: false }],
              contacts: [],
              messages: [textMessage({ id: "synced", chatId: PN, text: "Synced", timestamp: AT })],
            },
          }),
          observed({
            type: "message",
            message: textMessage({ id: "live", chatId: PN, text: "Live", timestamp: AT + 1 }),
          }),
          observed({
            type: "update",
            update: {
              kind: "receipt",
              ref: { id: "live", chatId: PN, fromMe: false },
              status: "read",
            },
          }),
          observed({ type: "account_connection", kind: "connected", at: AT }),
        ],
        1,
      );

      expect(accepted.events.map(({ event }) => event.type)).toEqual([
        "contact",
        "last_seen",
        "group",
        "conversation_sync",
        "message",
        "update",
        "account_connection",
      ]);
      const snapshot = await resource.data.snapshot(ACCOUNT);
      expect(snapshot.account.lastConnectedAt).toBe(AT);
      expect(snapshot.contacts).toMatchObject([{ contactId: PN, lastSeenAt: AT }]);
      expect(snapshot.groups).toMatchObject([{ groupId: ROOM, subject: "Room" }]);
      expect(
        (await resource.data.messages(ACCOUNT, PN)).messages.map(({ messageId }) => messageId),
      ).toEqual(["live", "synced"]);
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] source sequence is independent from mirror revision and accounts are isolated`, async () => {
    const resource = await create();
    try {
      const message = (accountId: string, id: string) =>
        resource.data.accept(
          accountId,
          [
            observed({
              type: "message",
              message: textMessage({ id, chatId: PN, text: id, timestamp: AT }),
            }),
          ],
          1,
        );
      const first = await message(ACCOUNT, "personal-message");
      const sourceOnly = await resource.data.accept(
        ACCOUNT,
        [
          observed({
            type: "update",
            update: {
              kind: "receipt",
              ref: { id: "personal-message", chatId: PN, fromMe: false },
              status: "read",
            },
          }),
        ],
        1,
      );
      await message(OTHER_ACCOUNT, "work-message");

      expect([first.seq, first.revision, sourceOnly.seq, sourceOnly.revision]).toEqual([
        1, 1, 2, 1,
      ]);
      expect(
        (await resource.data.messages(ACCOUNT, PN)).messages.map(({ messageId }) => messageId),
      ).toEqual(["personal-message"]);
      expect(
        (await resource.data.messages(OTHER_ACCOUNT, PN)).messages.map(
          ({ messageId }) => messageId,
        ),
      ).toEqual(["work-message"]);
      expect((await resource.data.accepted(ACCOUNT, 0)).map(({ seq }) => seq)).toEqual([1, 2]);
      expect((await resource.data.accepted(OTHER_ACCOUNT, 0)).map(({ seq }) => seq)).toEqual([1]);
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] PN/LID aliases consolidate contacts and retain the source`, async () => {
    const resource = await create();
    try {
      const contact = (id: string, nativeIds: string[], displayName: string) =>
        resource.data.accept(
          ACCOUNT,
          [observed({ type: "contact", contact: { id, nativeIds, displayName } })],
          1,
        );
      await contact(PN, [PN], "Phone");
      await contact(LID, [LID], "LID");
      const linked = await contact(LID, [LID, PN], "Linked");

      const snapshot = await resource.data.snapshot(ACCOUNT);
      expect(snapshot.contacts).toMatchObject([
        { accountId: ACCOUNT, contactId: LID, nativeIds: [LID, PN], displayName: "Linked" },
      ]);
      expect(snapshot.contactAliases).toEqual({ [LID]: LID, [PN]: LID });
      expect(linked.patch.deletes).toEqual([{ type: "contact", contactId: PN }]);
      expect((await resource.data.accepted(ACCOUNT, 0)).length).toBe(3);
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] a replacement claim fences the stale writer before replacement data`, async () => {
    const resource = await create();
    try {
      await resource.data.claim(ACCOUNT, 1);
      await resource.data.claim(ACCOUNT, 2);
      await assert.rejects(
        resource.data.accept(
          ACCOUNT,
          [
            observed({
              type: "message",
              message: textMessage({ id: "stale", chatId: PN, text: "stale" }),
            }),
          ],
          1,
        ),
        StaleAccountClaimError,
      );
      expect((await resource.data.accepted(ACCOUNT, 0)).length).toBe(0);
      expect((await resource.data.messages(ACCOUNT, PN)).messages).toEqual([]);
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] keyset pages survive timestamp collisions and a live insertion`, async () => {
    const resource = await create();
    try {
      await resource.data.accept(
        ACCOUNT,
        ["a", "b", "c", "d", "e"].map((id) =>
          observed({
            type: "message",
            message: textMessage({ id, chatId: PN, text: id, timestamp: AT }),
          }),
        ),
        1,
      );
      const first = await resource.data.messages(ACCOUNT, PN, { limit: 2 });
      expect(first.messages.map(({ messageId }) => messageId)).toEqual(["e", "d"]);
      await resource.data.accept(
        ACCOUNT,
        [
          observed({
            type: "message",
            message: textMessage({ id: "live", chatId: PN, text: "live", timestamp: AT + 1 }),
          }),
        ],
        1,
      );
      const second = await resource.data.messages(ACCOUNT, PN, {
        limit: 2,
        before: first.nextBefore,
      });
      const third = await resource.data.messages(ACCOUNT, PN, {
        limit: 2,
        before: second.nextBefore,
      });
      expect(
        [...first.messages, ...second.messages, ...third.messages].map(
          ({ messageId }) => messageId,
        ),
      ).toEqual(["e", "d", "c", "b", "a"]);
      expect((await resource.data.messages(ACCOUNT, PN, { limit: 2 })).messages[0]?.messageId).toBe(
        "live",
      );
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        await assert.rejects(resource.data.messages(ACCOUNT, PN, { limit }), RangeError);
        await assert.rejects(resource.data.accepted(ACCOUNT, 0, limit), RangeError);
      }
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] caller mutation cannot alter committed source or mirror values`, async () => {
    const resource = await create();
    try {
      const input = observed({
        type: "message",
        message: textMessage({ id: "owned", chatId: PN, text: "original", timestamp: AT }),
      });
      const returned = await resource.data.accept(ACCOUNT, [input], 1);
      assert.equal(input.event.type, "message");
      Object.assign(input.event.message, { text: "mutated input" });
      const delivered = returned.patch.upserts.find((record) => record.type === "message");
      assert.ok(delivered?.type === "message");
      Object.assign(delivered.message, { text: "mutated output" });

      expect((await resource.data.messages(ACCOUNT, PN)).messages[0]?.text).toBe("original");
      const retained = (await resource.data.accepted(ACCOUNT, 0))[0]?.events[0]?.event;
      assert.ok(retained?.type === "message" && retained.message.kind === "text");
      expect(retained.message.text).toBe("original");
    } finally {
      await resource.close();
    }
  });
}
