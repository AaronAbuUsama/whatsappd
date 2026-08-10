import { expect, test } from "./_expect.ts";
import { proto } from "baileys";
import { mapMessageUpdate, mapReaction, mapReceiptUpdate } from "../src/baileys/updates.ts";
import { SELF } from "./fixtures.ts";

const KEY = { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: true };

// ── messages.update: receipt / edit / revoke discrimination ──────────────────

test("status update → receipt (delivered)", () => {
  const u = mapMessageUpdate(
    {
      key: KEY,
      update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK },
    },
    SELF,
  );
  expect(u).toMatchObject({ kind: "receipt", status: "delivered", ref: { id: "MSG1" } });
});

test("status update → receipt (read)", () => {
  const u = mapMessageUpdate(
    { key: KEY, update: { status: proto.WebMessageInfo.Status.READ } },
    SELF,
  );
  expect(u!.kind).toBe("receipt");
  expect((u as { status: string }).status).toBe("read");
});

test("status update → receipt (played)", () => {
  const u = mapMessageUpdate(
    { key: KEY, update: { status: proto.WebMessageInfo.Status.PLAYED } },
    SELF,
  );
  expect((u as { status: string }).status).toBe("played");
});

test("revoke stub → revoke update carrying who did it", () => {
  const u = mapMessageUpdate(
    {
      key: KEY,
      update: {
        message: null,
        messageStubType: proto.WebMessageInfo.StubType.REVOKE,
        key: { remoteJid: "111@s.whatsapp.net", id: "REV", participant: "p@s.whatsapp.net" },
      },
    },
    SELF,
  );
  expect(u).toMatchObject({ kind: "revoke", ref: { id: "MSG1" }, by: "p@s.whatsapp.net" });
});

test("edit → edit update with re-mapped inbound content", () => {
  const u = mapMessageUpdate(
    {
      key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: false },
      update: {
        message: { editedMessage: { message: { conversation: "fixed text" } } },
        messageTimestamp: 1700,
      },
    },
    SELF,
  );
  expect(u!.kind).toBe("edit");
  const e = u as { message: { kind: string; text: string }; ref: { id: string } };
  expect(e.ref.id).toBe("MSG1");
  expect(e.message.kind).toBe("text");
  expect(e.message.text).toBe("fixed text");
});

test("unmodeled update (e.g. starred only) → undefined", () => {
  expect(mapMessageUpdate({ key: KEY, update: { starred: true } }, SELF)).toBe(undefined);
});

test("decrypted poll updates target the poll instead of becoming transcript rows", () => {
  const update = mapMessageUpdate(
    {
      key: { remoteJid: "room@g.us", id: "POLL1", fromMe: false },
      update: {
        pollUpdates: [
          {
            pollUpdateMessageKey: {
              remoteJid: "room@g.us",
              participant: "voter@s.whatsapp.net",
              id: "VOTE1",
              fromMe: false,
            },
            vote: {
              selectedOptions: [
                Buffer.from(
                  "d18003aabfd6c7e9c5cba811355a4a6061237d3463652a59cf12af00b656c027",
                  "hex",
                ),
              ],
            },
            senderTimestampMs: 1_700_000_000_000,
          },
        ],
      },
    },
    SELF,
  );

  expect(update).toEqual({
    kind: "poll_votes",
    ref: { chatId: "room@g.us", id: "POLL1", fromMe: false },
    votes: [
      {
        by: "voter@s.whatsapp.net",
        selectedOptionIds: ["d18003aabfd6c7e9c5cba811355a4a6061237d3463652a59cf12af00b656c027"],
        at: 1_700_000_000_000,
      },
    ],
  });
});

// ── message-receipt.update: per-participant (group) receipts ──────────────────

test("receipt update with readTimestamp → read, by participant, at ms", () => {
  const u = mapReceiptUpdate({
    key: KEY,
    receipt: { userJid: "g1@s.whatsapp.net", receiptTimestamp: 100, readTimestamp: 200 },
  });
  expect(u).toMatchObject({
    kind: "receipt",
    status: "read",
    by: "g1@s.whatsapp.net",
    at: 200_000,
  });
});

test("receipt update with only receiptTimestamp → delivered", () => {
  const u = mapReceiptUpdate({
    key: KEY,
    receipt: { userJid: "g2@s.whatsapp.net", receiptTimestamp: 50 },
  });
  expect((u as { status: string; at: number }).status).toBe("delivered");
  expect((u as { at: number }).at).toBe(50_000);
});

// ── messages.reaction: add / clear ────────────────────────────────────────────

test("reaction with emoji → reaction update (not removed)", () => {
  const u = mapReaction({
    key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: true },
    reaction: {
      text: "👍",
      key: { remoteJid: "peer@s.whatsapp.net", id: "MSG1" },
      senderTimestampMs: 1700000,
    },
  });
  expect(u).toMatchObject({
    kind: "reaction",
    emoji: "👍",
    removed: false,
    at: 1700000,
    by: "peer@s.whatsapp.net",
  });
});

test("reaction with empty text → removed", () => {
  const u = mapReaction({
    key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: true },
    reaction: { text: "", key: { remoteJid: "peer@s.whatsapp.net", id: "MSG1" } },
  });
  expect((u as { removed: boolean; emoji?: string }).removed).toBe(true);
  expect((u as { emoji?: string }).emoji).toBe(undefined);
});
