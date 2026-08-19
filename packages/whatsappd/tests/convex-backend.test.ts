/**
 * The Convex backend against the same suites libSQL answers, on a real local
 * Convex deployment — SQLite on disk, file storage in a directory.
 *
 * @remarks
 * The last test is the one that decides whether this adapter is finished: the
 * same script of WhatsApp events, driven through a libSQL backend and a Convex
 * backend, has to leave both mirrors holding the same records at the same
 * revisions with the same accepted source log. Conformance says each backend is
 * legal on its own; that one says they are the same backend.
 */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as nodeTest } from "node:test";
import { expect, test } from "./_expect.ts";
import {
  convexBackend,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  memoryMediaStore,
  AccountAlreadyClaimedError,
  StaleAccountClaimError,
  type ConvexBackend,
  type MediaStore,
  type WhatsAppBackend,
  type WhatsAppDataEvent,
  type WhatsAppDurableEvent,
} from "../src/index.ts";
import type { InboundMessage, MediaHandle } from "../src/model/message.ts";
import type { RuntimeMirrorReader, WhatsAppSnapshot } from "../src/runtime/contracts.ts";
import { createRuntimeMirrorReader } from "../src/runtime/runtime.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";
import { dataStoreConformance } from "./data-store-conformance.ts";
import { operationStoreConformance } from "./operation-store-conformance.ts";
import { conformsToStore } from "./store-conformance.ts";
import { startConvexDeployment } from "./convex-deployment.ts";
import { readMedia } from "./media-store-helpers.ts";

const ACCOUNT = "personal";
const CHAT = "person@s.whatsapp.net";
const ROOM = "room@g.us";
const AT = 1_700_000_000_000;

// Booted once for the file and shared: every fixture empties the deployment
// first, and Node runs the tests in one file one after another.
const deployment = await startConvexDeployment();

if (!deployment) {
  void nodeTest("the Convex backend proves nothing without a local backend binary", {
    skip:
      "no convex-local-backend found. Run `npx convex dev --once` in any Convex project to " +
      "download one, or point CONVEX_LOCAL_BACKEND at it.",
  });
} else {
  const url = deployment.url;
  const openBackend = async (media: MediaStore = memoryMediaStore()): Promise<ConvexBackend> => {
    await deployment.reset();
    return convexBackend({ url, accountId: ACCOUNT, media });
  };
  /** A second backend on the same deployment, without emptying it first. */
  const joinBackend = (media: MediaStore = memoryMediaStore()): ConvexBackend =>
    convexBackend({ url, accountId: ACCOUNT, media });

  nodeTest.after(() => deployment.close());

  dataStoreConformance("Convex data", async () => {
    const backend = await openBackend();
    return { data: backend.data, close: () => backend.close() };
  });

  operationStoreConformance("Convex operations", async () => {
    const backend = await openBackend();
    return { store: backend.operations, close: () => backend.close() };
  });

  conformsToStore("Convex credentials", async () => (await openBackend()).credentials);

  const firstSnapshot = async (client: RuntimeMirrorReader): Promise<WhatsAppSnapshot> => {
    const controller = new AbortController();
    const frames = client.watch({ signal: controller.signal })[Symbol.asyncIterator]();
    const first = await frames.next();
    controller.abort();
    await frames.return?.();
    assert.equal(first.done, false);
    assert.equal(first.value.type, "snapshot");
    return first.value.snapshot;
  };

  const mediaMessage = (
    kind: "image" | "audio",
    id: string,
    bytes: Uint8Array,
  ): InboundMessage & { readonly kind: "image" | "audio"; readonly media: MediaHandle } => ({
    id,
    chatId: CHAT,
    sender: { id: CHAT, mode: "pn" },
    fromMe: false,
    timestamp: AT,
    live: true,
    isGroup: false,
    kind,
    media: {
      mimetype: kind === "image" ? "image/png" : "audio/ogg; codecs=opus",
      ...(kind === "audio" && { ptt: true }),
      download: async () => Buffer.from(bytes),
    },
  });

  /**
   * One script of WhatsApp events, replayed against any backend.
   *
   * @remarks
   * Every message kind the projection stores and every update kind it merges,
   * including the two orders that are easy to get wrong: an update that lands
   * before its message, and several messages sharing one timestamp — which is
   * where a page cursor that compared only the timestamp would lose a message.
   */
  const script = async (backend: WhatsAppBackend): Promise<void> => {
    const session = createTestWhatsAppSession();
    const runtime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend,
      openSession: () => session.session,
    });
    await runtime.start();
    await backend.credentials.write({ registration: "durable" });
    await session.emit({
      type: "contact",
      contact: {
        id: CHAT,
        nativeIds: [CHAT, "55555@lid"],
        displayName: "Ada Display",
        profileName: "Ada Profile",
        verifiedName: "Ada Verified",
        username: "ada",
      },
    });
    await session.emit({
      type: "message",
      message: textMessage({ id: "m1", chatId: CHAT, text: "Hello", timestamp: AT }),
    });
    // Three messages on one timestamp: the page cursor has to order them by
    // message id, and a boundary that fell inside the collision would drop or
    // repeat whichever the engine happened to sort second (ADR-0010).
    for (const id of ["same-c", "same-a", "same-b"])
      await session.emit({
        type: "message",
        message: textMessage({ id, chatId: CHAT, text: id, timestamp: AT + 1 }),
      });
    await session.emit({
      type: "message",
      message: {
        id: "location-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 2,
        live: true,
        isGroup: false,
        kind: "location",
        lat: 5.6037,
        lng: -0.187,
        name: "Accra",
        address: "Greater Accra",
      },
    });
    await session.emit({
      type: "message",
      message: {
        id: "poll-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 3,
        live: true,
        isGroup: false,
        kind: "poll",
        name: "Lunch?",
        options: ["Waakye", "Jollof"],
        selectableCount: 1,
      },
    });
    await session.emit({
      type: "update",
      update: {
        kind: "poll_votes",
        ref: { id: "poll-1", chatId: CHAT, fromMe: false },
        votes: [
          {
            by: CHAT,
            selectedOptionIds: ["d18003aabfd6c7e9c5cba811355a4a6061237d3463652a59cf12af00b656c027"],
            at: AT + 4,
          },
        ],
      },
    });
    // The receipt arrives before the message it describes, so it has to be held
    // and merged when the message lands rather than dropped.
    await session.emit({
      type: "update",
      update: {
        kind: "receipt",
        ref: { id: "early", chatId: CHAT, fromMe: false },
        status: "read",
        at: AT + 5,
      },
    });
    await session.emit({
      type: "message",
      message: textMessage({ id: "early", chatId: CHAT, text: "Late", timestamp: AT + 6 }),
    });
    await session.emit({
      type: "message",
      message: {
        id: "group-1",
        chatId: ROOM,
        sender: { id: CHAT, mode: "pn", alt: "55555@lid" },
        keyParticipant: "55555:7@lid",
        pushName: "Ada",
        fromMe: false,
        timestamp: AT + 7,
        live: true,
        isGroup: true,
        context: { mentions: [CHAT] },
        flags: { ephemeral: true },
        kind: "text",
        text: "Group metadata",
      },
    });
    await session.emit({
      type: "message",
      message: textMessage({ id: "updated", chatId: CHAT, text: "Before", timestamp: AT + 8 }),
    });
    await session.emit({
      type: "update",
      update: {
        kind: "reaction",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        emoji: "👍",
        by: "alice@s.whatsapp.net",
        removed: false,
        at: AT + 9,
      },
    });
    await session.emit({
      type: "update",
      update: {
        kind: "edit",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        at: AT + 10,
        message: {
          id: "ignored-edit-id",
          chatId: CHAT,
          sender: { id: CHAT, mode: "pn" },
          fromMe: false,
          timestamp: AT + 99,
          live: true,
          isGroup: false,
          kind: "location",
          lat: 5.56,
          lng: -0.2,
        },
      },
    });
    await session.emit({
      type: "message",
      message: textMessage({ id: "revoked", chatId: CHAT, text: "Delete", timestamp: AT + 11 }),
    });
    await session.emit({
      type: "update",
      update: {
        kind: "revoke",
        ref: { id: "revoked", chatId: CHAT, fromMe: false },
        by: "moderator@s.whatsapp.net",
        at: AT + 12,
      },
    });
    await runtime.stop();
  };

  /** The same coverage as {@link script}, with every instant fixed. */
  const observed = (event: WhatsAppDurableEvent, at = AT): WhatsAppDataEvent => ({
    observedAt: at,
    event,
  });
  const parityEvents: readonly WhatsAppDataEvent[] = [
    observed({
      type: "contact",
      contact: {
        id: CHAT,
        nativeIds: [CHAT, "55555@lid"],
        displayName: "Ada Display",
        profileName: "Ada Profile",
        verifiedName: "Ada Verified",
        username: "ada",
      },
    }),
    observed({
      type: "message",
      message: textMessage({ id: "m1", chatId: CHAT, text: "Hello", timestamp: AT }),
    }),
    ...["same-c", "same-a", "same-b"].map((id) =>
      observed({
        type: "message",
        message: textMessage({ id, chatId: CHAT, text: id, timestamp: AT + 1 }),
      }),
    ),
    observed({
      type: "message",
      message: {
        id: "location-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 2,
        live: true,
        isGroup: false,
        kind: "location",
        lat: 5.6037,
        lng: -0.187,
        name: "Accra",
        address: "Greater Accra",
      },
    }),
    observed({
      type: "message",
      message: {
        id: "poll-1",
        chatId: CHAT,
        sender: { id: CHAT, mode: "pn" },
        fromMe: false,
        timestamp: AT + 3,
        live: true,
        isGroup: false,
        kind: "poll",
        name: "Lunch?",
        options: ["Waakye", "Jollof"],
        selectableCount: 1,
      },
    }),
    observed({
      type: "update",
      update: {
        kind: "poll_votes",
        ref: { id: "poll-1", chatId: CHAT, fromMe: false },
        votes: [
          {
            by: CHAT,
            selectedOptionIds: ["d18003aabfd6c7e9c5cba811355a4a6061237d3463652a59cf12af00b656c027"],
            at: AT + 4,
          },
        ],
      },
    }),
    observed({
      type: "update",
      update: {
        kind: "receipt",
        ref: { id: "early", chatId: CHAT, fromMe: false },
        status: "read",
        at: AT + 5,
      },
    }),
    observed({
      type: "message",
      message: textMessage({ id: "early", chatId: CHAT, text: "Late", timestamp: AT + 6 }),
    }),
    observed({
      type: "message",
      message: {
        id: "group-1",
        chatId: ROOM,
        sender: { id: CHAT, mode: "pn", alt: "55555@lid" },
        keyParticipant: "55555:7@lid",
        pushName: "Ada",
        fromMe: false,
        timestamp: AT + 7,
        live: true,
        isGroup: true,
        context: { mentions: [CHAT] },
        flags: { ephemeral: true },
        kind: "text",
        text: "Group metadata",
      },
    }),
    observed({
      type: "message",
      message: textMessage({ id: "updated", chatId: CHAT, text: "Before", timestamp: AT + 8 }),
    }),
    observed({
      type: "update",
      update: {
        kind: "reaction",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        emoji: "👍",
        by: "alice@s.whatsapp.net",
        removed: false,
        at: AT + 9,
      },
    }),
    observed({
      type: "update",
      update: {
        kind: "edit",
        ref: { id: "updated", chatId: CHAT, fromMe: false },
        at: AT + 10,
        message: {
          id: "ignored-edit-id",
          chatId: CHAT,
          sender: { id: CHAT, mode: "pn" },
          fromMe: false,
          timestamp: AT + 99,
          live: true,
          isGroup: false,
          kind: "location",
          lat: 5.56,
          lng: -0.2,
        },
      },
    }),
    observed({
      type: "message",
      message: textMessage({ id: "revoked", chatId: CHAT, text: "Delete", timestamp: AT + 11 }),
    }),
    observed({
      type: "update",
      update: {
        kind: "revoke",
        ref: { id: "revoked", chatId: CHAT, fromMe: false },
        by: "moderator@s.whatsapp.net",
        at: AT + 12,
      },
    }),
  ];

  test("a new Convex backend reconstructs one account through Runtime, DataStore, and Client", async () => {
    const backend = await openBackend();
    await script(backend);

    const expectedSnapshot = await backend.data.snapshot(ACCOUNT);
    const expectedSource = await backend.data.accepted(ACCOUNT, 0);
    const expectedPage = await backend.data.messages(ACCOUNT, CHAT);
    const expectedGroupPage = await backend.data.messages(ACCOUNT, ROOM);
    await backend.close();

    const replacement = joinBackend();
    const replacementSession = createTestWhatsAppSession();
    const replacementRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend: replacement,
      openSession: () => replacementSession.session,
    });
    const client = createRuntimeMirrorReader(replacementRuntime);
    await replacementRuntime.start();

    const reconstructed = await firstSnapshot(client);
    expect(reconstructed).toEqual(expectedSnapshot);
    expect(reconstructed.contacts.find(({ contactId }) => contactId === CHAT)).toEqual({
      accountId: ACCOUNT,
      contactId: CHAT,
      nativeIds: [CHAT, "55555@lid"],
      displayName: "Ada Display",
      profileName: "Ada Profile",
      verifiedName: "Ada Verified",
      username: "ada",
    });
    expect(await client.messages(CHAT)).toEqual(expectedPage);
    expect(await client.messages(ROOM)).toEqual(expectedGroupPage);
    expect(
      (await client.messages(CHAT)).messages.find(({ messageId }) => messageId === "location-1"),
    ).toEqual({
      accountId: ACCOUNT,
      chatId: CHAT,
      messageId: "location-1",
      sender: { id: CHAT, mode: "pn" },
      ref: { id: "location-1", chatId: CHAT, fromMe: false },
      fromMe: false,
      timestamp: AT + 2,
      receipts: [],
      reactions: [],
      kind: "location",
      lat: 5.6037,
      lng: -0.187,
      name: "Accra",
      address: "Greater Accra",
    });
    expect(
      (await client.messages(CHAT)).messages.find(({ messageId }) => messageId === "poll-1"),
    ).toMatchObject({
      kind: "poll",
      votes: [
        { option: "Waakye", voters: [CHAT] },
        { option: "Jollof", voters: [] },
      ],
    });
    expect(
      (await client.messages(CHAT)).messages.find(({ messageId }) => messageId === "updated"),
    ).toMatchObject({
      messageId: "updated",
      timestamp: AT + 8,
      reactions: [
        { subject: "alice@s.whatsapp.net", emoji: "👍", by: "alice@s.whatsapp.net", at: AT + 9 },
      ],
      editedAt: AT + 10,
      kind: "location",
    });
    expect(
      (await client.messages(CHAT)).messages.find(({ messageId }) => messageId === "early"),
    ).toMatchObject({ receipts: [{ subject: "aggregate", status: "read", at: AT + 5 }] });
    expect((await client.messages(ROOM)).messages[0]).toMatchObject({
      messageId: "group-1",
      pushName: "Ada",
      context: { mentions: [CHAT] },
      flags: { ephemeral: true },
      ref: { id: "group-1", chatId: ROOM, fromMe: false, participant: "55555:7@lid" },
    });
    expect(await replacement.data.accepted(ACCOUNT, 0)).toEqual(expectedSource);
    expect(await replacement.credentials.read("registration")).toBe("durable");

    await replacementRuntime.stop();
    await replacement.close();
  });

  test("a page cursor separates messages that share one timestamp", async () => {
    const backend = await openBackend();
    await script(backend);
    try {
      const whole = await backend.data.messages(ACCOUNT, CHAT, { limit: 100 });
      const walked = [];
      let before = undefined;
      for (let page = 0; page < 20; page += 1) {
        const read = await backend.data.messages(ACCOUNT, CHAT, {
          limit: 2,
          ...(before && { before }),
        });
        walked.push(...read.messages);
        if (!read.nextBefore) break;
        before = read.nextBefore;
      }
      expect(walked).toEqual([...whole.messages]);
      // All three survive the walk, in message-id order within their second.
      expect(
        walked.map(({ messageId }) => messageId).filter((id) => id.startsWith("same-")),
      ).toEqual(["same-c", "same-b", "same-a"]);
    } finally {
      await backend.close();
    }
  });

  test("new Convex, file media, Runtime, and Client instances reconstruct image and voice bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-convex-media-"));
    const imageBytes = Uint8Array.from([1, 3, 5, 7]);
    const voiceBytes = Uint8Array.from([2, 4, 6, 8]);
    try {
      const media = fileMediaStore({ directory });
      const backend = await openBackend(media);
      const session = createTestWhatsAppSession();
      const runtime = createWhatsAppRuntime({
        accountId: ACCOUNT,
        backend,
        openSession: () => session.session,
      });
      await runtime.start();
      await session.emit({
        type: "message",
        message: mediaMessage("image", "image-1", imageBytes),
      });
      await session.emit({
        type: "message",
        message: mediaMessage("audio", "voice-1", voiceBytes),
      });
      await session.emit({
        type: "message",
        message: {
          ...mediaMessage("image", "failed-1", Uint8Array.from([])),
          media: {
            mimetype: "image/png",
            download: async () => {
              throw new Error("expired media handle");
            },
          },
        },
      });
      await runtime.stop();

      const expectedSnapshot = await backend.data.snapshot(ACCOUNT);
      const expectedPage = await backend.data.messages(ACCOUNT, CHAT);
      const expectedSource = await backend.data.accepted(ACCOUNT, 0);
      await backend.close();

      const replacementMedia = fileMediaStore({ directory });
      const replacement = joinBackend(replacementMedia);
      const replacementSession = createTestWhatsAppSession();
      const replacementRuntime = createWhatsAppRuntime({
        accountId: ACCOUNT,
        backend: replacement,
        openSession: () => replacementSession.session,
      });
      const client = createRuntimeMirrorReader(replacementRuntime);
      await replacementRuntime.start();

      expect(await firstSnapshot(client)).toEqual(expectedSnapshot);
      expect(await client.messages(CHAT)).toEqual(expectedPage);
      expect(await replacement.data.accepted(ACCOUNT, 0)).toEqual(expectedSource);
      for (const message of expectedPage.messages) {
        assert.ok(message.kind === "image" || message.kind === "audio");
        if (message.messageId === "failed-1") {
          assert.deepEqual(message.media, {
            state: "failed",
            reason: "download_failed",
            mimetype: "image/png",
          });
          continue;
        }
        assert.equal(message.media.state, "stored");
        assert.deepEqual(
          await readMedia(replacementMedia, { accountId: ACCOUNT, ref: message.media.ref }),
          message.kind === "image" ? imageBytes : voiceBytes,
        );
      }

      await replacementRuntime.stop();
      await replacement.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a replacement claim fences an independent stale Convex backend before its first write", async () => {
    const backend = await openBackend();
    const replacement = joinBackend();
    try {
      const held = await backend.leases.acquire(ACCOUNT, "first", 60_000);
      assert.ok(held.acquired);
      await backend.data.claim(ACCOUNT, held.lease.fencingToken);

      const contended = await replacement.leases.acquire(ACCOUNT, "second", 60_000);
      assert.equal(contended.acquired, false);
      assert.ok(await backend.leases.release(held.lease));

      const taken = await replacement.leases.acquire(ACCOUNT, "second", 60_000);
      assert.ok(taken.acquired);
      assert.ok(taken.lease.fencingToken > held.lease.fencingToken);
      await replacement.data.claim(ACCOUNT, taken.lease.fencingToken);

      // The superseded holder still has its buffered event. The lease alone
      // cannot stop that write -- only the acceptance boundary can (ADR-0009).
      await assert.rejects(
        backend.data.accept(
          ACCOUNT,
          [
            {
              observedAt: AT,
              event: {
                type: "message",
                message: textMessage({ id: "stale", chatId: CHAT, text: "late", timestamp: AT }),
              },
            },
          ],
          held.lease.fencingToken,
        ),
        StaleAccountClaimError,
      );
      await assert.rejects(
        backend.data.claim(ACCOUNT, held.lease.fencingToken),
        StaleAccountClaimError,
      );
      expect((await backend.data.snapshot(ACCOUNT)).revision).toBe(0);
    } finally {
      await backend.close();
      await replacement.close();
    }
  });

  test("a second Runtime on an independent Convex backend fails before opening WhatsApp", async () => {
    const backend = await openBackend();
    const second = joinBackend();
    const held = createTestWhatsAppSession();
    let secondOpened = false;
    const heldRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend,
      openSession: () => held.session,
    });
    const secondRuntime = createWhatsAppRuntime({
      accountId: ACCOUNT,
      backend: second,
      openSession: () => {
        secondOpened = true;
        return createTestWhatsAppSession().session;
      },
    });
    try {
      await heldRuntime.start();
      await assert.rejects(secondRuntime.start(), AccountAlreadyClaimedError);
      assert.equal(secondOpened, false);
    } finally {
      await heldRuntime.stop();
      await backend.close();
      await second.close();
    }
  });

  test("libSQL and Convex answer the same script with the same mirror and source log", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-convex-parity-"));
    try {
      const sqlUrl = pathToFileURL(path.join(directory, "whatsapp.db")).href;
      const sql = libsqlBackend({ url: sqlUrl, accountId: ACCOUNT, media: memoryMediaStore() });
      const convex = await openBackend();
      try {
        // Offered straight to the acceptance boundary rather than through a
        // Runtime: a Runtime stamps connection observations from the wall
        // clock, and two runs of it differ by the milliseconds between them,
        // which would make this compare clocks instead of backends.
        for (const event of parityEvents) {
          expect(await convex.data.accept(ACCOUNT, [event], 1)).toEqual(
            await sql.data.accept(ACCOUNT, [event], 1),
          );
        }
        await convex.credentials.write({ registration: "durable" });
        await sql.credentials.write({ registration: "durable" });

        expect(await convex.data.snapshot(ACCOUNT)).toEqual(await sql.data.snapshot(ACCOUNT));
        expect(await convex.data.messages(ACCOUNT, CHAT, { limit: 100 })).toEqual(
          await sql.data.messages(ACCOUNT, CHAT, { limit: 100 }),
        );
        expect(await convex.data.messages(ACCOUNT, ROOM, { limit: 100 })).toEqual(
          await sql.data.messages(ACCOUNT, ROOM, { limit: 100 }),
        );
        expect(await convex.data.accepted(ACCOUNT, 0)).toEqual(await sql.data.accepted(ACCOUNT, 0));
        expect(await convex.credentials.read("registration")).toBe(
          await sql.credentials.read("registration"),
        );

        // Paging is compared page by page rather than whole: a cursor that
        // disagreed only at a boundary would still produce the same full read.
        let convexBefore = undefined;
        let sqlBefore = undefined;
        for (let page = 0; page < 20; page += 1) {
          const fromConvex = await convex.data.messages(ACCOUNT, CHAT, {
            limit: 2,
            ...(convexBefore && { before: convexBefore }),
          });
          const fromSql = await sql.data.messages(ACCOUNT, CHAT, {
            limit: 2,
            ...(sqlBefore && { before: sqlBefore }),
          });
          expect(fromConvex).toEqual(fromSql);
          if (!fromConvex.nextBefore) break;
          convexBefore = fromConvex.nextBefore;
          sqlBefore = fromSql.nextBefore;
        }
      } finally {
        await sql.close();
        await convex.close();
      }
      // The libSQL database really did receive all of it, read outside both
      // adapters -- so the agreement above is two stores holding the same
      // records, not two stores that were equally empty.
      const raw = createClient({ url: sqlUrl });
      const counted = await raw.execute("SELECT COUNT(*) AS saved FROM wa_messages");
      assert.equal(counted.rows[0]?.saved, 10);
      raw.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
