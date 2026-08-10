import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const ref = (chatId: string, id: string, fromMe = false) => ({ chatId, id, fromMe });
const record = (kind: MessageRecord["kind"], value: Partial<MessageRecord> = {}): MessageRecord =>
  ({
    accountId: "fixture-account",
    chatId: "allowed",
    messageId: `message-${kind}`,
    sender: { id: "fixture-sender", mode: "lid" },
    ref: ref("allowed", `message-${kind}`),
    fromMe: false,
    timestamp: 1,
    receipts: [],
    reactions: [],
    ...(kind === "text"
      ? { kind, text: "hello" }
      : kind === "location"
        ? { kind, lat: 0, lng: 0, name: "Null Island" }
        : kind === "contacts"
          ? { kind, contacts: [{ name: "Tester", vcard: "BEGIN:VCARD" }] }
          : kind === "poll"
            ? {
                kind,
                name: "Ship?",
                options: ["Yes", "Later"],
                selectableCount: 1,
                votes: [{ option: "Yes", voters: ["fixture"] }],
              }
            : kind === "revoked"
              ? { kind }
              : kind === "unsupported"
                ? { kind, rawType: "futureMessage" }
                : {
                    kind,
                    media: {
                      state: "stored",
                      ref: `fixture-${kind}`,
                      byteLength: 4,
                      ...(kind === "audio" && { ptt: true }),
                    },
                  }),
    ...value,
  }) as MessageRecord;

function fixtureClient() {
  const calls: string[] = [];
  const subscriptions = new Set<() => void>();
  let account: ClientAccountState = {
    accountId: "fixture-account",
    closed: false,
    connection: { phase: "online" },
  };
  let messages: ClientChatMessages = {
    chatId: "allowed",
    messages: [
      record("text", {
        context: { quoted: { id: "quoted", from: "fixture" }, mentions: ["fixture"] },
        flags: { edited: true },
        reactions: [{ emoji: "👍", subject: "fixture", at: 1 }],
        receipts: [{ subject: "fixture", status: "read", at: 1 }],
      }),
      record("image"),
      record("video"),
      record("audio"),
      record("document"),
      record("sticker"),
      record("location"),
      record("contacts"),
      record("poll"),
      record("revoked"),
      record("unsupported"),
    ],
    outgoing: [],
    older: "stored",
  };
  const namespace = {
    subscribe: (listener: () => void) => (
      subscriptions.add(listener),
      () => subscriptions.delete(listener)
    ),
  };
  const operation = async (name: string) => (calls.push(name), {} as never);
  const client = {
    account: { ...namespace, get: () => account },
    chats: {
      ...namespace,
      list: (): ChatRecord[] => [
        {
          accountId: "fixture-account",
          chatId: "blocked",
          isGroup: false,
          subject: "Blocked",
          lastMessageAt: 1,
        },
        {
          accountId: "fixture-account",
          chatId: "allowed",
          isGroup: true,
          subject: "TST",
          lastMessageAt: 2,
        },
      ],
    },
    contacts: {
      ...namespace,
      list: () => [
        {
          accountId: "fixture-account",
          contactId: "person",
          nativeIds: ["person"],
          displayName: "Person",
          imgUrl: "fixture-avatar",
        },
      ],
      resolve: () => undefined,
      presence: () => undefined,
    },
    groups: {
      ...namespace,
      list: () => [
        {
          accountId: "fixture-account",
          groupId: "allowed",
          subject: "TST",
          participants: [{ id: "person" }],
        },
        { accountId: "fixture-account", groupId: "unknown", subject: "Unknown roster" },
      ],
      metadata: async (id: string) => (
        calls.push(`group:metadata:${id}`),
        { id, participants: [] }
      ),
      create: async (subject: string, ids: readonly string[]) => (
        calls.push(`group:create:${subject}:${ids.join(",")}`),
        { id: "new", participants: [] }
      ),
      leave: async (id: string) => void calls.push(`group:leave:${id}`),
      updateSubject: async (id: string, subject: string) =>
        void calls.push(`group:subject:${id}:${subject}`),
      updateDescription: async (id: string, description?: string) =>
        void calls.push(`group:description:${id}:${description ?? ""}`),
      updateParticipants: async (id: string, ids: readonly string[], action: string) => (
        calls.push(`group:participants:${id}:${action}:${ids.join(",")}`),
        []
      ),
      updateSetting: async (id: string, setting: string) =>
        void calls.push(`group:setting:${id}:${setting}`),
      inviteCode: async (id: string) => (calls.push(`group:invite:${id}`), "invite"),
      revokeInvite: async (id: string) => (calls.push(`group:revoke-invite:${id}`), "next"),
      updatePicture: async (id: string, bytes: Uint8Array) =>
        void calls.push(`group:picture:${id}:${bytes.byteLength}`),
      removePicture: async (id: string) => void calls.push(`group:remove-picture:${id}`),
    },
    messages: {
      ...namespace,
      get: (chatId: string) =>
        chatId === "allowed"
          ? messages
          : { chatId, messages: [], outgoing: [], older: "exhausted" },
      older: (chatId: string) => calls.push(`older:${chatId}`),
      send: {
        text: (id: string, text: string) => operation(`send:text:${id}:${text}`),
        image: (id: string) => operation(`send:image:${id}`),
        video: (id: string) => operation(`send:video:${id}`),
        audio: (id: string, _input: unknown, options?: { ptt?: boolean }) =>
          operation(`send:${options?.ptt ? "voice" : "audio"}:${id}`),
        document: (id: string) => operation(`send:document:${id}`),
        sticker: (id: string) => operation(`send:sticker:${id}`),
        location: (id: string) => operation(`send:location:${id}`),
        contacts: (id: string) => operation(`send:contacts:${id}`),
      },
      react: (_ref: unknown, emoji: string) => operation(`react:${emoji}`),
      unreact: () => operation("unreact"),
      edit: (_ref: unknown, text: string) => operation(`edit:${text}`),
      revoke: () => operation("revoke"),
      markRead: () => operation("read"),
      setTyping: async (_id: string, on: boolean) => void calls.push(`typing:${on}`),
      requestPhoneHistory: (_id: string, request: { count?: number }) =>
        operation(`history:${request.count ?? "default"}`),
    },
    operations: {
      get: () => undefined,
      subscribe: () => () => undefined,
      wait: async () => ({}) as never,
      acknowledge: async (id: string) => (calls.push(`ack:${id}`), undefined),
    },
    close: async () => undefined,
  } as unknown as WhatsAppClient;
  return {
    client,
    calls,
    notify: () => subscriptions.forEach((listener) => listener()),
    setAccount: (next: ClientAccountState) => (account = next),
    setMessages: (next: ClientChatMessages) => (messages = next),
  };
}

void test("projects every public message kind and keeps contacts/groups truthful", () => {
  const fixture = fixtureClient();
  const application = createTerminalApplication(fixture.client, {
    canSend: (id) => id === "allowed" || id === "person",
  });
  const snapshot = application.getSnapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.kind).sort(), [
    "audio",
    "contacts",
    "document",
    "image",
    "location",
    "poll",
    "revoked",
    "sticker",
    "text",
    "unsupported",
    "video",
  ]);
  assert.deepEqual(snapshot.messages.find((message) => message.kind === "text")?.metadata, [
    "reply:quoted",
    "mentions:1",
    "edited",
    "receipt:read",
  ]);
  assert.deepEqual(
    snapshot.contacts.map((contact) => contact.name),
    ["Person"],
  );
  assert.deepEqual(
    snapshot.groups.map((group) => group.detail),
    ["1 participant", "roster unknown"],
  );
  application.close();
});

void test("separates saved paging, phone history, message actions, and the allowlist", async () => {
  const fixture = fixtureClient();
  const application = createTerminalApplication(fixture.client, {
    canSend: (id) => id === "allowed" || id === "person",
  });
  assert.equal(application.loadOlder(), application.getSnapshot().messages[0]?.id);
  application.selectMessageOffset(-10);
  await application.messageAction({ kind: "react", emoji: "🔥" });
  await application.messageAction({ kind: "unreact" });
  await application.messageAction({ kind: "edit", text: "fixed" });
  await application.messageAction({ kind: "revoke" });
  await application.messageAction({ kind: "read" });
  await application.messageAction({ kind: "history", count: 50 });
  await application.messageAction({ kind: "typing", on: true });
  fixture.setMessages({
    ...fixture.client.messages.get("allowed"),
    outgoing: [
      {
        operationId: "fixture-operation",
        idempotencyKey: "fixture-key",
        content: { text: "pending" },
        state: { status: "queued" },
      },
    ],
  });
  fixture.notify();
  for (
    let index = 0;
    index < 20 && application.getSnapshot().selectedMessageId !== "fixture-operation";
    index += 1
  ) {
    application.selectMessageOffset(1);
  }
  await application.messageAction({ kind: "acknowledge" });
  await application.submit("hello");
  assert.deepEqual(fixture.calls, [
    "older:allowed",
    "react:🔥",
    "unreact",
    "edit:fixed",
    "revoke",
    "read",
    "history:50",
    "typing:true",
    "ack:fixture-operation",
    "send:text:allowed:hello",
  ]);
  application.selectChat("blocked");
  await assert.rejects(application.submit("nope"), /not allowlisted/);
  application.close();
});

void test("streams every binary command and validates group mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsappd-opentui-"));
  const path = join(directory, "proof.bin");
  await writeFile(path, "proof");
  try {
    const fixture = fixtureClient();
    const application = createTerminalApplication(fixture.client, {
      canSend: (id) => id === "allowed" || id === "person",
    });
    await application.submit(`/image "${path}" caption`);
    await application.submit(`/video "${path}" caption`);
    await application.submit(`/audio "${path}" audio/ogg`);
    await application.submit(`/voice "${path}" 1`);
    await application.submit(`/document "${path}" application/octet-stream proof.bin caption`);
    await application.submit(`/sticker "${path}"`);
    await application.submit("/location 0 0 Null-Island");
    await application.submit("/contact Tester BEGIN:VCARD");
    assert.deepEqual(fixture.calls.slice(0, 8), [
      "send:image:allowed",
      "send:video:allowed",
      "send:audio:allowed",
      "send:voice:allowed",
      "send:document:allowed",
      "send:sticker:allowed",
      "send:location:allowed",
      "send:contacts:allowed",
    ]);
    assert.match(
      (await application.groupAction({ kind: "metadata", groupId: "allowed" })) ?? "",
      /allowed/,
    );
    assert.equal(
      await application.groupAction({ kind: "create", subject: "New", participants: ["person"] }),
      "new",
    );
    await application.groupAction({ kind: "leave", groupId: "allowed" });
    await application.groupAction({ kind: "subject", groupId: "allowed", subject: "Renamed" });
    await application.groupAction({
      kind: "description",
      groupId: "allowed",
      description: "Proof",
    });
    await application.groupAction({
      kind: "participants",
      groupId: "allowed",
      participants: ["person"],
      action: "add",
    });
    await application.groupAction({ kind: "setting", groupId: "allowed", setting: "announcement" });
    assert.equal(await application.groupAction({ kind: "invite", groupId: "allowed" }), "invite");
    assert.equal(
      await application.groupAction({ kind: "revoke-invite", groupId: "allowed" }),
      "next",
    );
    await application.groupAction({ kind: "picture", groupId: "allowed", path });
    await application.groupAction({ kind: "remove-picture", groupId: "allowed" });
    assert.deepEqual(fixture.calls.slice(-11), [
      "group:metadata:allowed",
      "group:create:New:person",
      "group:leave:allowed",
      "group:subject:allowed:Renamed",
      "group:description:allowed:Proof",
      "group:participants:allowed:add:person",
      "group:setting:allowed:announcement",
      "group:invite:allowed",
      "group:revoke-invite:allowed",
      "group:picture:allowed:5",
      "group:remove-picture:allowed",
    ]);
    await assert.rejects(application.submit("/document incomplete"), /requires a MIME type/);
    await assert.rejects(
      application.groupAction({ kind: "leave", groupId: "blocked" }),
      /not allowlisted/,
    );
    await assert.rejects(
      application.groupAction({ kind: "create", subject: "Unsafe", participants: ["stranger"] }),
      /participant must be allowlisted/,
    );
    application.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("projects every account phase, send guard, and protected pairing state", () => {
  const fixture = fixtureClient();
  const application = createTerminalApplication(fixture.client, { canSend: () => true });
  const phases: readonly [ClientAccountState, string, boolean][] = [
    [{ accountId: "fixture-account", closed: false }, "saved mirror", true],
    [
      { accountId: "fixture-account", closed: false, connection: { phase: "disconnected" } },
      "disconnected",
      true,
    ],
    [
      {
        accountId: "fixture-account",
        closed: false,
        connection: { phase: "connecting", retryAttempt: 0 },
      },
      "connecting",
      true,
    ],
    [
      {
        accountId: "fixture-account",
        closed: false,
        connection: { phase: "authenticated", sync: { step: "draining" } },
      },
      "authenticated",
      true,
    ],
    [
      {
        accountId: "fixture-account",
        closed: false,
        connection: {
          phase: "backing_off",
          reason: "connection_lost",
          retryAttempt: 1,
          nextRetryAt: 2,
        },
      },
      "backing_off",
      true,
    ],
    [
      { accountId: "fixture-account", closed: false, connection: { phase: "online" } },
      "online",
      true,
    ],
    [
      {
        accountId: "fixture-account",
        closed: false,
        connection: { phase: "logged_out", reason: "logged_out_remote" },
      },
      "logged_out",
      false,
    ],
    [
      {
        accountId: "fixture-account",
        closed: false,
        connection: { phase: "suspended", reason: "credentials_invalid" },
      },
      "suspended",
      false,
    ],
    [{ accountId: "fixture-account", closed: true }, "closed", false],
  ];
  for (const [account, phase, canSend] of phases) {
    fixture.setAccount(account);
    fixture.notify();
    assert.equal(application.getSnapshot().phase, phase);
    assert.equal(
      application.getSnapshot().chats.find((chat) => chat.id === "allowed")?.canSend,
      canSend,
    );
  }
  const phase = accountPhase({
    accountId: "fixture-account",
    closed: false,
    connection: {
      phase: "pairing",
      pairing: { step: "challenge_live", method: "qr", qr: "SECRET-QR-PAYLOAD", expiresAt: 1 },
    },
  });
  assert.equal(phase, "pairing · challenge_live");
  assert.doesNotMatch(JSON.stringify(phase), /SECRET-QR-PAYLOAD/);
  application.close();
});
