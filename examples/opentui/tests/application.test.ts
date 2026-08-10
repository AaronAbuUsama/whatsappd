import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChatRecord,
  ClientAccountState,
  ClientChatMessages,
  MessageRecord,
  WhatsAppClient,
} from "whatsappd";
import {
  accountPhase,
  createTerminalApplication,
} from "../src/components/whatsappd-tui/lib/whatsapp-terminal.ts";

const chat = (chatId: string, subject: string, lastMessageAt: number): ChatRecord => ({
  accountId: "fixture-account",
  chatId,
  isGroup: true,
  subject,
  lastMessageAt,
});

const text = (
  chatId: string,
  messageId: string,
  value: string,
  timestamp: number,
): MessageRecord => ({
  accountId: "fixture-account",
  chatId,
  messageId,
  sender: { id: "fixture-sender", mode: "lid" },
  ref: { chatId, id: messageId, fromMe: false },
  fromMe: false,
  timestamp,
  receipts: [],
  reactions: [],
  kind: "text",
  text: value,
});

void test("projects public Client state, preserves the older anchor, and sends through the guarded seam", async () => {
  let selectedMessages: ClientChatMessages = {
    chatId: "newer",
    messages: [text("newer", "m2", "latest", 2), text("newer", "m1", "first", 1)],
    outgoing: [],
    older: "stored" as const,
  };
  const subscriptions = new Set<() => void>();
  const calls: string[] = [];
  let accountState: ClientAccountState = {
    accountId: "fixture-account",
    closed: false,
    connection: { phase: "online" },
  };
  const namespace = {
    subscribe: (listener: () => void) => (
      subscriptions.add(listener),
      () => subscriptions.delete(listener)
    ),
  };
  const client = {
    account: {
      ...namespace,
      get: () => accountState,
    },
    chats: { ...namespace, list: () => [chat("older", "Older", 1), chat("newer", "Newer", 2)] },
    contacts: { ...namespace, list: () => [], resolve: () => undefined, presence: () => undefined },
    groups: { ...namespace, list: () => [] },
    messages: {
      ...namespace,
      get: (chatId: string) =>
        chatId === "newer"
          ? selectedMessages
          : { chatId, messages: [], outgoing: [], older: "exhausted" as const },
      older: (chatId: string) => calls.push(`older:${chatId}`),
      send: {
        text: async (chatId: string, value: string) => (
          calls.push(`send:${chatId}:${value}`),
          {} as never
        ),
      },
    },
    operations: {},
    close: async () => undefined,
  } as unknown as WhatsAppClient;

  const application = createTerminalApplication(client, {
    canSend: (chatId) => chatId === "newer",
  });
  assert.deepEqual(
    application.getSnapshot().chats.map(({ name }) => name),
    ["Newer", "Older"],
  );
  assert.equal(application.getSnapshot().selectedChatId, "newer");
  assert.deepEqual(
    application.getSnapshot().messages.map(({ body }) => body),
    ["first", "latest"],
  );

  const anchor = application.loadOlder();
  assert.equal(anchor, "m1");
  assert.deepEqual(calls, ["older:newer"]);

  selectedMessages = {
    ...selectedMessages,
    messages: [...selectedMessages.messages, text("newer", "m0", "older page", 0)],
    older: "exhausted",
  };
  subscriptions.forEach((listener) => listener());
  assert.deepEqual(
    application.getSnapshot().messages.map(({ body }) => body),
    ["older page", "first", "latest"],
  );

  await application.sendText("hello");
  assert.deepEqual(calls, ["older:newer", "send:newer:hello"]);
  accountState = {
    accountId: "fixture-account",
    closed: false,
    connection: { phase: "logged_out", reason: "logged_out_remote" },
  };
  subscriptions.forEach((listener) => listener());
  assert.equal(application.getSnapshot().chats[0]?.canSend, false);
  await assert.rejects(application.sendText("terminal"), /Account is logged_out/);
  accountState = {
    accountId: "fixture-account",
    closed: false,
    connection: { phase: "online" },
  };
  subscriptions.forEach((listener) => listener());
  application.selectChat("older");
  await assert.rejects(application.sendText("blocked"), /not allowlisted/);
  application.close();
});

void test("reports pairing progress without exposing the challenge", () => {
  const phase = accountPhase({
    accountId: "fixture-account",
    closed: false,
    connection: {
      phase: "pairing",
      pairing: {
        step: "challenge_live",
        method: "qr",
        qr: "SECRET-QR-PAYLOAD",
        expiresAt: 1,
      },
    },
  });
  assert.equal(phase, "pairing · challenge_live");
  assert.doesNotMatch(JSON.stringify(phase), /SECRET-QR-PAYLOAD/);
});
