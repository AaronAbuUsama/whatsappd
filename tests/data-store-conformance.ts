import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import {
  StaleAccountClaimError,
  type DurableInboundMessage,
  type DurableMedia,
  type MessageRecord,
  type WhatsAppDataEvent,
  type WhatsAppDataStore,
  type WhatsAppDurableEvent,
} from "../src/runtime/contracts.ts";
import { projectCurrentMirror, type CurrentMirrorRecords } from "../src/runtime/projection.ts";
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

/** Let queued work run — never a timed wait. */
const yielded = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const observed = (event: WhatsAppDurableEvent, observedAt = AT): WhatsAppDataEvent => ({
  observedAt,
  event,
});

const durableMediaMessage = (
  kind: "image" | "video" | "audio" | "document" | "sticker",
  index: number,
): DurableInboundMessage & {
  readonly kind: "image" | "video" | "audio" | "document" | "sticker";
  readonly media: DurableMedia;
} => ({
  id: `${kind}-${index}`,
  chatId: PN,
  sender: { id: PN, mode: "pn" },
  fromMe: false,
  timestamp: AT + index,
  live: true,
  isGroup: false,
  kind,
  media:
    index % 2 === 0
      ? {
          state: "stored",
          ref: `media:v1:${String(index).padStart(64, "0")}`,
          byteLength: index + 10,
          mimetype: `${kind}/test`,
          ...(kind === "audio" && { ptt: true }),
        }
      : {
          state: "failed",
          reason: index === 1 ? "download_failed" : "store_failed",
          mimetype: `${kind}/test`,
        },
});

test("the Current Mirror projection reads only the message key touched by an update", async () => {
  const current: MessageRecord = {
    accountId: ACCOUNT,
    chatId: PN,
    messageId: "current",
    sender: { id: PN, mode: "pn" },
    ref: { id: "current", chatId: PN, fromMe: false },
    fromMe: false,
    timestamp: AT,
    receipts: [],
    reactions: [],
    kind: "text",
    text: "Current",
  };
  const reads: Array<readonly [string, string]> = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("projection read an unrelated record family");
  };
  const records: CurrentMirrorRecords = {
    account: unexpected,
    chat: unexpected,
    contact: unexpected,
    contactId: unexpected,
    group: unexpected,
    async message(chatId, messageId) {
      reads.push([chatId, messageId]);
      return chatId === PN && messageId === "current" ? current : undefined;
    },
  };

  const projection = await projectCurrentMirror(records, ACCOUNT, [
    observed({
      type: "update",
      update: {
        kind: "receipt",
        ref: { id: "current", chatId: PN, fromMe: false },
        status: "read",
      },
    }),
  ]);

  expect(reads).toEqual([[PN, "current"]]);
  expect(projection.upserts).toMatchObject([
    { type: "message", message: { messageId: "current", receipts: [{ status: "read" }] } },
  ]);
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

  test(`[${name}] every durable media kind and outcome crosses source and current codecs`, async () => {
    const resource = await create();
    try {
      const messages = (["image", "video", "audio", "document", "sticker"] as const).map(
        durableMediaMessage,
      );
      const accepted = await resource.data.accept(
        ACCOUNT,
        messages.map((message) => observed({ type: "message", message })),
        1,
      );
      assert.equal(accepted.events.length, messages.length);

      const page = await resource.data.messages(ACCOUNT, PN);
      assert.equal(page.messages.length, messages.length);
      for (const source of messages) {
        const current = page.messages.find(({ messageId }) => messageId === source.id);
        assert.equal(current?.kind, source.kind);
        assert.ok(current);
        assert.deepEqual(current.media, source.media);
      }
      const source = (await resource.data.accepted(ACCOUNT, 0))[0]?.events;
      assert.deepEqual(
        source?.map(({ event }) => event.type === "message" && event.message),
        messages,
      );
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] a location is readable from the current mirror`, async () => {
    const resource = await create();
    try {
      await resource.data.accept(
        ACCOUNT,
        [
          observed({
            type: "message",
            message: {
              id: "location-1",
              chatId: PN,
              sender: { id: PN, mode: "pn" },
              fromMe: false,
              timestamp: AT,
              live: true,
              isGroup: false,
              kind: "location",
              lat: 5.6037,
              lng: -0.187,
              name: "Accra",
              address: "Greater Accra",
            },
          }),
        ],
        1,
      );

      expect((await resource.data.messages(ACCOUNT, PN)).messages).toEqual([
        {
          accountId: ACCOUNT,
          chatId: PN,
          messageId: "location-1",
          sender: { id: PN, mode: "pn" },
          ref: { id: "location-1", chatId: PN, fromMe: false },
          fromMe: false,
          timestamp: AT,
          receipts: [],
          reactions: [],
          kind: "location",
          lat: 5.6037,
          lng: -0.187,
          name: "Accra",
          address: "Greater Accra",
        },
      ]);
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] a sparse group message keeps an actionable participant fallback`, async () => {
    const resource = await create();
    try {
      await resource.data.accept(
        ACCOUNT,
        [
          observed({
            type: "message",
            message: textMessage({
              id: "group-without-key-participant",
              chatId: ROOM,
              sender: PN,
              text: "Fallback action target",
              timestamp: AT,
            }),
          }),
        ],
        1,
      );

      expect((await resource.data.messages(ACCOUNT, ROOM)).messages[0]?.ref).toEqual({
        id: "group-without-key-participant",
        chatId: ROOM,
        fromMe: false,
        participant: PN,
      });
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] contacts, polls, and unsupported content are readable`, async () => {
    const resource = await create();
    try {
      const messages: DurableInboundMessage[] = [
        {
          id: "contacts-1",
          chatId: PN,
          sender: { id: PN, mode: "pn" },
          fromMe: false,
          timestamp: AT,
          live: true,
          isGroup: false,
          kind: "contacts",
          contacts: [{ name: "Ada", vcard: "BEGIN:VCARD\nFN:Ada\nEND:VCARD" }],
        },
        {
          id: "poll-1",
          chatId: PN,
          sender: { id: PN, mode: "pn" },
          fromMe: false,
          timestamp: AT + 1,
          live: true,
          isGroup: false,
          kind: "poll",
          name: "Lunch?",
          options: ["Waakye", "Jollof"],
          selectableCount: 1,
        },
        {
          id: "future-1",
          chatId: PN,
          sender: { id: PN, mode: "pn" },
          fromMe: false,
          timestamp: AT + 2,
          live: true,
          isGroup: false,
          kind: "unsupported",
          rawType: "futureMessage",
        },
      ];
      await resource.data.accept(
        ACCOUNT,
        messages.map((message) => observed({ type: "message", message })),
        1,
      );

      expect(
        (await resource.data.messages(ACCOUNT, PN)).messages.map((message) => ({
          messageId: message.messageId,
          kind: message.kind,
        })),
      ).toEqual([
        { messageId: "future-1", kind: "unsupported" },
        { messageId: "poll-1", kind: "poll" },
        { messageId: "contacts-1", kind: "contacts" },
      ]);
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
              ref: { id: "missing-message", chatId: PN, fromMe: false },
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

  test(`[${name}] message updates keep one current record and independent source sequence`, async () => {
    const resource = await create();
    try {
      const accept = (event: WhatsAppDurableEvent) =>
        resource.data.accept(ACCOUNT, [observed(event)], 1);
      const versions: Array<readonly [number, number]> = [];
      const record = async (event: WhatsAppDurableEvent) => {
        const batch = await accept(event);
        versions.push([batch.seq, batch.revision]);
      };

      const original = {
        ...textMessage({ id: "current", chatId: PN, text: "Before", timestamp: AT }),
        pushName: "Ada",
      };
      await record({ type: "message", message: original });
      const receipt = {
        type: "update" as const,
        update: {
          kind: "receipt" as const,
          ref: { id: "current", chatId: PN, fromMe: false },
          status: "read" as const,
          at: AT + 1,
        },
      };
      await record(receipt);
      await record(receipt);
      await record({
        type: "update",
        update: {
          kind: "reaction",
          ref: { id: "current", chatId: PN, fromMe: false },
          emoji: "👍",
          by: "alice@s.whatsapp.net",
          removed: false,
          at: AT + 2,
        },
      });
      await record({
        type: "update",
        update: {
          kind: "reaction",
          ref: { id: "current", chatId: PN, fromMe: false },
          emoji: "🔥",
          by: "alice@s.whatsapp.net",
          removed: false,
          at: AT + 3,
        },
      });
      await record({
        type: "update",
        update: {
          kind: "reaction",
          ref: { id: "current", chatId: PN, fromMe: false },
          by: "missing@s.whatsapp.net",
          removed: true,
        },
      });
      const edit = {
        type: "update",
        update: {
          kind: "edit",
          ref: { id: "current", chatId: PN, fromMe: false },
          at: AT + 4,
          message: {
            id: "ignored-edit-id",
            chatId: PN,
            sender: { id: "ignored@s.whatsapp.net", mode: "pn" },
            fromMe: true,
            timestamp: AT + 99,
            live: true,
            isGroup: false,
            kind: "location",
            lat: 5.6037,
            lng: -0.187,
          },
        },
      } satisfies WhatsAppDurableEvent;
      await record(edit);
      await record({
        type: "update",
        update: {
          kind: "revoke",
          ref: { id: "current", chatId: PN, fromMe: false },
          by: "moderator@s.whatsapp.net",
          at: AT + 5,
        },
      });
      await record(edit);
      await record({
        type: "conversation_sync",
        batch: {
          context: { source: "recent", projection: { mode: "upsert" } },
          chats: [],
          contacts: [],
          messages: [original],
        },
      });
      await record({
        type: "update",
        update: {
          kind: "receipt",
          ref: { id: "missing", chatId: PN, fromMe: false },
          status: "delivered",
        },
      });

      expect(versions).toEqual([
        [1, 1],
        [2, 2],
        [3, 2],
        [4, 3],
        [5, 4],
        [6, 4],
        [7, 5],
        [8, 6],
        [9, 6],
        [10, 6],
        [11, 6],
      ]);
      expect((await resource.data.messages(ACCOUNT, PN)).messages).toEqual([
        {
          accountId: ACCOUNT,
          chatId: PN,
          messageId: "current",
          sender: { id: PN, mode: "pn" },
          ref: { id: "current", chatId: PN, fromMe: false },
          fromMe: false,
          timestamp: AT,
          pushName: "Ada",
          receipts: [{ subject: "aggregate", status: "read", at: AT + 1 }],
          reactions: [
            {
              subject: "alice@s.whatsapp.net",
              emoji: "🔥",
              by: "alice@s.whatsapp.net",
              at: AT + 3,
            },
          ],
          editedAt: AT + 4,
          kind: "revoked",
          revokedAt: AT + 5,
          revokedBy: "moderator@s.whatsapp.net",
        },
      ]);
      expect((await resource.data.snapshot(ACCOUNT)).chats[0]?.lastMessageAt).toBe(AT);
      expect((await resource.data.accepted(ACCOUNT, 0)).map(({ seq }) => seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
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

  test(`[${name}] an in-flight acceptance cannot restore a superseded claim`, async () => {
    const resource = await create();
    try {
      await resource.data.claim(ACCOUNT, 1);
      const accepted = resource.data.accept(
        ACCOUNT,
        [
          observed({
            type: "message",
            message: textMessage({ id: "ordered", chatId: PN, text: "ordered" }),
          }),
        ],
        1,
      );
      await resource.data.claim(ACCOUNT, 2);
      await accepted;

      await assert.rejects(
        resource.data.accept(
          ACCOUNT,
          [
            observed({
              type: "message",
              message: textMessage({ id: "stale-after", chatId: PN, text: "stale" }),
            }),
          ],
          1,
        ),
        StaleAccountClaimError,
      );
      expect(
        (await resource.data.messages(ACCOUNT, PN)).messages.map(({ messageId }) => messageId),
      ).toEqual(["ordered"]);
    } finally {
      await resource.close();
    }
  });

  test(`[${name}] concurrent acceptances keep distinct source and revision steps`, async () => {
    const resource = await create();
    try {
      const batches = await Promise.all(
        ["first", "second"].map((id) =>
          resource.data.accept(
            ACCOUNT,
            [
              observed({
                type: "message",
                message: textMessage({ id, chatId: PN, text: id, timestamp: AT }),
              }),
            ],
            1,
          ),
        ),
      );
      expect(
        batches.map(({ seq, fromRevision, revision }) => [seq, fromRevision, revision]),
      ).toEqual([
        [1, 0, 1],
        [2, 1, 2],
      ]);
      expect(
        (await resource.data.messages(ACCOUNT, PN)).messages.map(({ messageId }) => messageId),
      ).toEqual(["second", "first"]);
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

  test(`[${name}] a joint read answers every question at one revision`, async () => {
    const resource = await create();
    try {
      const write = (id: string, chatId: string, timestamp: number): Promise<unknown> =>
        resource.data.accept(
          ACCOUNT,
          [
            observed({
              type: "message",
              // A group message names its author; a 1:1's author is the chat.
              message: textMessage({
                id,
                chatId,
                text: id,
                timestamp,
                ...(chatId === ROOM && { sender: PN }),
              }),
            }),
          ],
          1,
        );
      await write("seed-pn", PN, AT);
      await write("seed-room", ROOM, AT);
      // Every message this test commits to PN, in commit order, so the record
      // a read returns can be checked against the revision it claims.
      const pnWrites = [
        { id: "seed-pn", at: AT },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `r${Math.floor(index / 5)}-${index % 5}`,
          at: AT + 1 + Math.floor(index / 5) * 10 + (index % 5),
        })),
      ];

      const pinned: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        // A writer advancing the mirror for as long as the read is open. The
        // read must not be able to see part of what it commits.
        // The in-memory store is the leg that observes this: local libSQL
        // clients in one process share `LazyLibsqlClient.run`'s queue, so an
        // open read holds it and no write commits inside one. libSQL's
        // transaction is what makes a remote or multi-process deployment
        // correct, and no in-process test can distinguish it from that queue.
        const writing = (async () => {
          for (let step = 0; step < 5; step += 1)
            await write(`r${round}-${step}`, PN, AT + 1 + round * 10 + step);
        })();
        const seen = await resource.data.read(ACCOUNT, async (view) => {
          const snapshot = await view.snapshot();
          // Opening a conversation does other work between its reads, and the
          // writer above gets to commit while it does. Yielding here is what
          // makes the read observe that rather than finishing inside one turn.
          await yielded();
          const first = await view.messages(PN, { limit: 2 });
          await yielded();
          const second = await view.messages(ROOM, { limit: 2 });
          return {
            revisions: [snapshot.revision, first.revision, second.revision],
            // Records, not labels. An implementation that read the live maps
            // and stamped them with the revision it captured at `read()` agrees
            // on the numbers above and disagrees here.
            chatAt: snapshot.chats.find((chat) => chat.chatId === PN)?.lastMessageAt,
            newest: first.messages[0]?.messageId,
          };
        });
        await writing;
        expect(new Set(seen.revisions).size).toBe(1);
        const revision = seen.revisions[0];
        assert.ok(revision !== undefined);
        // Every acceptance moves the revision by one, so the revision names
        // exactly how much of the writer this read was allowed to see — and
        // the records it returned have to be that much and no more.
        const reflected = pnWrites[revision - 2];
        assert.ok(reflected !== undefined);
        expect(seen.newest).toBe(reflected.id);
        expect(seen.chatAt).toBe(reflected.at);
        pinned.push(revision);
      }

      // …and the writer really was advancing: every pinned revision is below
      // the revision the mirror finished at, so none of the reads above was
      // taken against a mirror nothing was writing to.
      const final = (await resource.data.snapshot(ACCOUNT)).revision;
      expect(final).toBe(27);
      expect(pinned.every((revision) => revision < final)).toBe(true);
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

      const current = (await resource.data.messages(ACCOUNT, PN)).messages[0];
      assert.equal(current?.kind, "text");
      expect(current.text).toBe("original");
      const retained = (await resource.data.accepted(ACCOUNT, 0))[0]?.events[0]?.event;
      assert.ok(retained?.type === "message" && retained.message.kind === "text");
      expect(retained.message.text).toBe("original");
    } finally {
      await resource.close();
    }
  });
}
