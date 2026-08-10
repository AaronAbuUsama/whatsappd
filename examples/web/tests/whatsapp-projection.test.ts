import assert from "node:assert/strict";
import test from "node:test";
import type { MessageRecord, ReceiptStatus } from "whatsappd";
import { receiptOf } from "../src/lib/whatsapp-projection.ts";

const message = (receipts: MessageRecord["receipts"]): MessageRecord => ({
  accountId: "fixture-account",
  chatId: "fixture-chat",
  messageId: "fixture-message",
  sender: { id: "fixture-sender", mode: "pn" },
  ref: { id: "fixture-message", chatId: "fixture-chat", fromMe: true },
  fromMe: true,
  timestamp: 1,
  receipts,
  reactions: [],
  kind: "text",
  text: "Fixture text",
});

void test("aggregate receipts preserve every public delivery state", () => {
  for (const status of [
    "pending",
    "server_ack",
    "delivered",
    "read",
    "played",
    "error",
  ] satisfies ReceiptStatus[]) {
    assert.deepEqual(receiptOf(message([{ subject: "aggregate", status }])), {
      status,
      participants: [],
    });
  }
});

void test("participant receipts stay separate instead of inventing an all-read aggregate", () => {
  assert.deepEqual(
    receiptOf(
      message([
        { subject: "participant:a", by: "a", status: "read" },
        { subject: "participant:b", by: "b", status: "delivered" },
        { subject: "participant:c", by: "c", status: "delivered" },
      ]),
    ),
    {
      participants: [
        { status: "delivered", count: 2 },
        { status: "read", count: 1 },
      ],
    },
  );
});
