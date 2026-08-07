import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { promisify } from "node:util";
import { expect, test } from "./_expect.ts";
import {
  createWhatsAppClient,
  type DurableOutbound,
  libsqlBackend,
  memoryBackend,
  memoryMediaStore,
  memoryOperationStore,
  OperationIdempotencyConflictError,
  type RuntimeSession,
  type Status,
  type WhatsAppOperationInput,
  type WhatsAppOperationStore,
  type WhatsAppOperation,
} from "../src/index.ts";
import { sanitizeOperationError } from "../src/runtime/operations.ts";
import {
  createTestWhatsAppRuntime as createWhatsAppRuntime,
  createTestWhatsAppSession,
  textMessage,
} from "../src/testing.ts";

const CHAT = "operation-target@example.invalid";
const execFileAsync = promisify(execFile);

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(done: () => boolean | Promise<boolean>, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await done()) return;
    await tick();
  }
  assert.fail(`condition did not hold within ${turns} event-loop turns`);
}

async function withDeadline<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface StoreLane {
  readonly name: string;
  readonly store: WhatsAppOperationStore;
  setNow(value: number): void;
  close(): Promise<void>;
}

async function operationStores(): Promise<readonly StoreLane[]> {
  let memoryNow = 1_000;
  let libsqlNow = 1_000;
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operations-"));
  const backend = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: "personal",
    media: memoryMediaStore(),
    operationClock: { now: () => libsqlNow },
  });
  return [
    {
      name: "memory",
      store: memoryOperationStore({ clock: { now: () => memoryNow } }),
      setNow(value) {
        memoryNow = value;
      },
      async close() {},
    },
    {
      name: "libSQL",
      store: backend.operations,
      setNow(value) {
        libsqlNow = value;
      },
      async close() {
        await backend.close();
        await rm(directory, { recursive: true, force: true });
      },
    },
  ];
}

type SendOperationInput = Extract<WhatsAppOperationInput, { readonly type: "send" }>;

const sendInput = (text: string): SendOperationInput => ({
  type: "send",
  chatId: CHAT,
  content: { text },
});

async function submit(
  store: WhatsAppOperationStore,
  id: string,
  text = id,
): Promise<WhatsAppOperation> {
  return store.submit({
    accountId: "personal",
    id,
    idempotencyKey: `key-${id}`,
    operation: sendInput(text),
  });
}

test("a text send exposes every durable operation state in order", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "hello");
    const observed: WhatsAppOperation[] = [];
    const off = client.operations.subscribe(submitted.id, (operation) => {
      observed.push(operation);
    });

    await until(() => observed.at(-1)?.state.status === "succeeded");
    off();

    expect(observed.map((operation) => operation.state.status)).toEqual([
      "queued",
      "claimed",
      "executing",
      "succeeded",
    ]);
    const attempts = observed.flatMap((operation) =>
      operation.state.status === "claimed" || operation.state.status === "executing"
        ? [operation.state.attemptId]
        : [],
    );
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    expect(driver.commands.sent.length).toBe(1);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("operation accessors preserve send options and release abortable subscriptions", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    expect(await client.operations.get("missing")).toBe(undefined);
    const aborted = new AbortController();
    aborted.abort();
    const never = client.operations.subscribe("missing", () => assert.fail(), {
      signal: aborted.signal,
    });
    never();

    const quote = { id: "quoted", chatId: CHAT, fromMe: false };
    const submitted = await client.messages.send.text(CHAT, "hello", {
      idempotencyKey: "send-with-options",
      quote,
      mentions: ["mention@example.invalid"],
    });
    const observed: string[] = [];
    const watching = new AbortController();
    const stopWatching = client.operations.subscribe(
      submitted.id,
      (operation) => {
        observed.push(operation.state.status);
        if (operation.state.status === "queued") watching.abort();
      },
      { signal: watching.signal },
    );
    stopWatching();
    stopWatching();

    await until(async () => {
      const current = await client.operations.get(submitted.id);
      return current?.state.status === "succeeded";
    });
    expect(observed).toEqual(["queued"]);
    expect(driver.commands.sent[0]?.options).toEqual({
      quote,
      mentions: ["mention@example.invalid"],
    });
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("everyday actions each write one operation and make one exact Session call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-actions-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const backend = libsqlBackend({
    url,
    accountId: "personal",
    media: memoryMediaStore(),
  });
  const oracle = createClient({ url });
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const first = { id: "first", chatId: CHAT, fromMe: false } as const;
  const second = {
    id: "second",
    chatId: CHAT,
    fromMe: false,
    participant: "participant@example.invalid",
  } as const;
  const before = { ref: first, timestamp: 1_700_000_000_000 } as const;

  try {
    const operations = await Promise.all([
      client.messages.markRead([first, second], { idempotencyKey: "mark-many-read" }),
      client.messages.setTyping(CHAT, true, { idempotencyKey: "typing-on" }),
      client.messages.setTyping(CHAT, false, { idempotencyKey: "typing-off" }),
      client.messages.requestPhoneHistory(CHAT, { before }, { idempotencyKey: "history-default" }),
      client.messages.requestPhoneHistory(
        CHAT,
        { before, count: 1 },
        { idempotencyKey: "history-one" },
      ),
    ]);

    await until(async () => {
      const current = await client.operations.get(operations.map((operation) => operation.id));
      return current.every((operation) => operation?.state.status === "succeeded");
    });

    const typeCounts = operations.reduce<Record<string, number>>((counts, operation) => {
      counts[operation.input.type] = (counts[operation.input.type] ?? 0) + 1;
      return counts;
    }, {});
    expect(typeCounts).toEqual({ mark_read: 1, typing: 2, phone_history: 2 });
    expect(operations.map((operation) => operation.input)).toEqual([
      { type: "mark_read", refs: [first, second] },
      { type: "typing", chatId: CHAT, on: true },
      { type: "typing", chatId: CHAT, on: false },
      { type: "phone_history", anchor: before, count: 50 },
      { type: "phone_history", anchor: before, count: 1 },
    ]);
    expect(driver.commands.read).toEqual([{ refs: [first, second] }]);
    expect(
      [...driver.commands.typing].sort((left, right) => Number(left.on) - Number(right.on)),
    ).toEqual([
      { chatId: CHAT, on: false },
      { chatId: CHAT, on: true },
    ]);
    expect(
      driver.commands.historyRequests
        .map(({ anchor, count }) => ({ anchor, count }))
        .sort((left, right) => left.count - right.count),
    ).toEqual([
      { anchor: before, count: 1 },
      { anchor: before, count: 50 },
    ]);
    expect(driver.commands.historyRequests.map(({ result }) => result.requestId).sort()).toEqual([
      "test-history-1",
      "test-history-2",
    ]);
    const rowsBeforeRejections = await oracle.execute({
      sql: "SELECT input_json FROM wa_operations WHERE account_id = ?",
      args: ["personal"],
    });
    const persistedTypeCounts = rowsBeforeRejections.rows.reduce<Record<string, number>>(
      (counts, row) => {
        if (typeof row.input_json !== "string") assert.fail("operation input_json was not text");
        const input = JSON.parse(row.input_json) as { readonly type: string };
        counts[input.type] = (counts[input.type] ?? 0) + 1;
        return counts;
      },
      {},
    );
    expect(persistedTypeCounts).toEqual({ mark_read: 1, typing: 2, phone_history: 2 });

    for (const count of [0, 51, 1.5]) {
      await assert.rejects(
        client.messages.requestPhoneHistory(CHAT, { before, count }),
        /count must be an integer in 1\.\.50/,
      );
    }
    const rowsAfterRejections = await oracle.execute({
      sql: "SELECT COUNT(*) AS count FROM wa_operations WHERE account_id = ?",
      args: ["personal"],
    });
    expect(rowsAfterRejections.rows[0]?.count).toBe(5);
    expect(driver.commands.historyRequests.length).toBe(2);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an already-aborted submission writes no operation", async () => {
  const backend = memoryBackend();
  const submit = backend.operations.submit.bind(backend.operations);
  let submissions = 0;
  backend.operations.submit = async (input) => {
    submissions += 1;
    return submit(input);
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));

  try {
    await assert.rejects(
      client.messages.send.text(CHAT, "hello", { signal: controller.signal }),
      /cancelled/,
    );
    expect(submissions).toBe(0);
    expect(await backend.operations.list("personal")).toEqual([]);
    expect(driver.commands.sent.length).toBe(0);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("a pending submission aborts the caller wait but still executes durably", async () => {
  const backend = memoryBackend();
  const submit = backend.operations.submit.bind(backend.operations);
  let release!: () => void;
  const maySubmit = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.operations.submit = async (input) => {
    await maySubmit;
    return submit(input);
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const controller = new AbortController();

  try {
    const submission = client.messages.send.text(CHAT, "durable", {
      idempotencyKey: "abort-wait",
      signal: controller.signal,
    });
    controller.abort(new Error("caller stopped waiting"));
    await assert.rejects(withDeadline(submission), /caller stopped waiting/);
    release();
    await until(() => driver.commands.sent.length === 1);
    expect(driver.commands.sent[0]?.content).toEqual({ text: "durable" });
  } finally {
    release();
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("queued work waits until a reconnect reaches online", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let status: Status = { phase: "connecting" };
  const session: RuntimeSession = {
    ...driver.session,
    get status() {
      return status;
    },
  };
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "after-online");
    await tick();
    expect(driver.commands.sent.length).toBe(0);
    expect((await client.operations.get(submitted.id))?.state.status).toBe("queued");

    status = { phase: "online" };
    await driver.emit({ type: "connection", status });
    await until(() => driver.commands.sent.length === 1);
    expect((await client.operations.get(submitted.id))?.state.status).toBe("succeeded");
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("a connection pause after claim requeues the exact attempt before reconnect", async () => {
  const backend = memoryBackend();
  const claimNext = backend.operations.claimNext.bind(backend.operations);
  let releaseClaimResult!: () => void;
  const mayReturnClaim = new Promise<void>((resolve) => {
    releaseClaimResult = resolve;
  });
  let observeClaim!: () => void;
  const claimed = new Promise<void>((resolve) => {
    observeClaim = resolve;
  });
  backend.operations.claimNext = async (accountId, ttlMs) => {
    const operation = await claimNext(accountId, ttlMs);
    if (operation) {
      observeClaim();
      await mayReturnClaim;
    }
    return operation;
  };
  const driver = createTestWhatsAppSession();
  let status: Status = { phase: "online" };
  const session: RuntimeSession = {
    ...driver.session,
    get status() {
      return status;
    },
  };
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "pause-after-claim");
    await withDeadline(claimed);
    status = { phase: "connecting" };
    await driver.emit({ type: "connection", status });
    releaseClaimResult();
    await until(async () => {
      const current = await client.operations.get(submitted.id);
      return current?.state.status === "queued";
    });
    expect(driver.commands.sent.length).toBe(0);

    status = { phase: "online" };
    await driver.emit({ type: "connection", status });
    await until(() => driver.commands.sent.length === 1);
    expect((await client.operations.get(submitted.id))?.state.status).toBe("succeeded");
  } finally {
    releaseClaimResult();
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("the memory Adapter replays equal input and rejects divergent input", async () => {
  const store = memoryOperationStore({ clock: { now: () => 1_000 } });
  const firstInput: WhatsAppOperationInput = {
    type: "send",
    chatId: CHAT,
    content: { text: "same" },
    options: {
      quote: { id: "quote", chatId: CHAT, fromMe: false },
    },
  };
  const first = await store.submit({
    accountId: "personal",
    id: "first",
    idempotencyKey: "same-key",
    operation: firstInput,
  });
  const replay = await store.submit({
    accountId: "personal",
    id: "ignored",
    idempotencyKey: "same-key",
    operation: {
      content: { text: "same" },
      chatId: CHAT,
      type: "send",
      options: {
        quote: { fromMe: false, chatId: CHAT, id: "quote" },
      },
    },
  });
  expect(replay.id).toBe(first.id);
  await assert.rejects(
    store.submit({
      accountId: "personal",
      id: "conflict",
      idempotencyKey: "same-key",
      operation: sendInput("different"),
    }),
    OperationIdempotencyConflictError,
  );

  await submit(store, "later");
  await submit(store, "earlier");
  expect((await store.list("personal")).map((operation) => operation.id)).toEqual([
    "earlier",
    "first",
    "later",
  ]);
  expect(await store.list("other")).toEqual([]);
  const claimed = await store.claimNext("personal", 100);
  expect(claimed?.id).toBe("earlier");
  expect(await store.get("other", "first")).toBe(undefined);
  const offMissing = store.subscribe("personal", "missing", () => assert.fail());
  offMissing();
  expect(await store.recoverExpired("other")).toBe(0);
  expect(await store.start("personal", "missing", "missing-attempt", 100)).toBe(false);

  const invalidClock = memoryOperationStore({ clock: { now: () => 1.5 } });
  await assert.rejects(
    invalidClock.submit({
      accountId: "personal",
      id: "invalid-clock",
      idempotencyKey: "invalid-clock",
      operation: sendInput("clock"),
    }),
    /operation clock returned 1.5/,
  );
});

test("both operation stores reject numbers JSON cannot preserve without mutation", async () => {
  const lanes = await operationStores();

  try {
    for (const lane of lanes) {
      const id = `${lane.name}-non-finite`;
      await assert.rejects(
        async () =>
          lane.store.submit({
            accountId: "personal",
            id,
            idempotencyKey: id,
            operation: {
              type: "send",
              chatId: CHAT,
              content: {
                media: { kind: "sticker", ref: "media-ref", byteLength: Number.NaN },
              },
            },
          }),
        /must be finite/,
      );
      expect(await lane.store.get("personal", id)).toBe(undefined);
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("both operation stores reject sparse arrays before persistence", async () => {
  const lanes = await operationStores();
  const sparseMentions: string[] = [];
  sparseMentions.length = 1;

  try {
    for (const lane of lanes) {
      const id = `${lane.name}-sparse`;
      await assert.rejects(
        lane.store.submit({
          accountId: "personal",
          id,
          idempotencyKey: id,
          operation: {
            type: "send",
            chatId: CHAT,
            content: { text: "sparse" },
            options: { mentions: sparseMentions },
          },
        }),
        /sparse arrays/,
      );
      expect(await lane.store.get("personal", id)).toBe(undefined);
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("both operation stores preserve finite fractional phone-history timestamps", async () => {
  const lanes = await operationStores();
  const timestamp = 1_700_000_000_000.5;
  const anchor = {
    ref: { id: "fractional", chatId: CHAT, fromMe: false },
    timestamp,
  } as const;

  try {
    for (const lane of lanes) {
      const id = `${lane.name}-fractional-history`;
      const operation = await lane.store.submit({
        accountId: "personal",
        id,
        idempotencyKey: id,
        operation: { type: "phone_history", anchor, count: 50 },
      });
      assert.equal(operation.input.type, "phone_history");
      if (operation.input.type !== "phone_history")
        assert.fail("expected a phone-history operation");
      expect(operation.input.anchor.timestamp).toBe(timestamp);
      expect((await lane.store.get("personal", id))?.input).toEqual(operation.input);
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("phone-history rejects non-finite timestamps before either Adapter writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-history-validation-"));
  const lanes = [
    {
      name: "memory",
      backend: memoryBackend(),
      async close() {},
    },
    {
      name: "libSQL",
      backend: libsqlBackend({
        url: `file:${path.join(directory, "whatsapp.db")}`,
        accountId: "personal",
        media: memoryMediaStore(),
      }),
      async close() {
        await this.backend.close();
      },
    },
  ] as const;

  try {
    for (const lane of lanes) {
      const driver = createTestWhatsAppSession();
      const runtime = createWhatsAppRuntime({
        accountId: "personal",
        backend: lane.backend,
        openSession: () => driver.session,
      });
      await runtime.start();
      const client = await createWhatsAppClient(runtime);
      try {
        for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          await assert.rejects(
            client.messages.requestPhoneHistory(CHAT, {
              before: {
                ref: { id: "invalid-timestamp", chatId: CHAT, fromMe: false },
                timestamp,
              },
            }),
            /timestamp must be finite/,
          );
        }
        expect(await lane.backend.operations.list("personal")).toEqual([]);
        expect(driver.commands.historyRequests.length).toBe(0);
      } finally {
        await client.close();
        await runtime.stop().catch(() => {});
      }
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Client idempotency replays normalized input once through libSQL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-replay-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const backend = libsqlBackend({
    url,
    accountId: "personal",
    media: memoryMediaStore(),
  });
  const oracle = createClient({ url });
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const quote = { id: "quoted", chatId: CHAT, fromMe: false };
    const first = await client.messages.send.text(CHAT, "same", {
      idempotencyKey: "normalized-replay",
      quote,
    });
    await until(async () => {
      const current = await client.operations.get(first.id);
      return current?.state.status === "succeeded";
    });
    const replay = await client.messages.send.text(CHAT, "same", {
      mentions: [],
      idempotencyKey: "normalized-replay",
      quote: { fromMe: false, chatId: CHAT, id: "quoted" },
    });

    expect(replay.id).toBe(first.id);
    expect(driver.commands.sent.length).toBe(1);
    const rows = await oracle.execute({
      sql: "SELECT operation_id FROM wa_operations WHERE account_id = ? AND idempotency_key = ?",
      args: ["personal", "normalized-replay"],
    });
    expect(rows.rows.map((row) => row.operation_id)).toEqual([first.id]);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replay makes no second Session call and only an authoritative echo creates a message", async () => {
  const backend = memoryBackend();
  const self = "operation-subject@example.invalid";
  const driver = createTestWhatsAppSession({ identity: { jid: self } });
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const text = "authoritative-only";
  client.messages.get(CHAT);

  try {
    const first = await client.messages.send.text(CHAT, text, {
      idempotencyKey: "recorded-session-replay",
    });
    await until(async () => {
      const operation = await client.operations.get(first.id);
      return operation?.state.status === "succeeded";
    });
    const sendsBeforeReplay = driver.commands.sent.length;
    expect(sendsBeforeReplay).toBe(1);
    expect(client.messages.get(CHAT).messages).toEqual([]);

    const replay = await client.messages.send.text(CHAT, text, {
      idempotencyKey: "recorded-session-replay",
    });
    expect(replay.id).toBe(first.id);
    expect(driver.commands.sent.length).toBe(sendsBeforeReplay);
    expect(client.messages.get(CHAT).messages).toEqual([]);

    const sent = driver.commands.sent[0];
    assert.ok(sent);
    await driver.emit({
      type: "message",
      message: textMessage({
        id: sent.result.id,
        chatId: CHAT,
        text,
        fromMe: true,
        sender: self,
      }),
    });
    const retained = client.messages.get(CHAT).messages;
    expect(retained.map((message) => message.messageId)).toEqual([sent.result.id]);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("six typed divergent inputs throw the exported conflict without mutation", async () => {
  const media = (ref: string): DurableOutbound => ({
    media: { kind: "sticker", ref, byteLength: 4 },
  });
  const quote = { id: "quote", chatId: CHAT, fromMe: false };
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly original: WhatsAppOperationInput;
    readonly conflict: WhatsAppOperationInput;
  }> = [
    {
      name: "text",
      original: sendInput("first"),
      conflict: sendInput("different"),
    },
    {
      name: "chatId",
      original: sendInput("same"),
      conflict: { ...sendInput("same"), chatId: "different@example.invalid" },
    },
    {
      name: "quote",
      original: { ...sendInput("same"), options: { quote } },
      conflict: {
        ...sendInput("same"),
        options: { quote: { ...quote, id: "different-quote" } },
      },
    },
    {
      name: "mentions",
      original: { ...sendInput("same"), options: { mentions: ["first@example.invalid"] } },
      conflict: { ...sendInput("same"), options: { mentions: ["other@example.invalid"] } },
    },
    {
      name: "type",
      original: sendInput("same"),
      conflict: { type: "typing", chatId: CHAT, on: true },
    },
    {
      name: "media ref",
      original: { type: "send", chatId: CHAT, content: media("media-a") },
      conflict: { type: "send", chatId: CHAT, content: media("media-b") },
    },
  ];
  const lanes = await operationStores();

  try {
    for (const lane of lanes) {
      for (const example of cases) {
        const key = `${lane.name}-${example.name}`;
        const originalId = `${key}-original`;
        const conflictId = `${key}-conflict`;
        const original = await lane.store.submit({
          accountId: "personal",
          id: originalId,
          idempotencyKey: key,
          operation: example.original,
        });
        await assert.rejects(
          lane.store.submit({
            accountId: "personal",
            id: conflictId,
            idempotencyKey: key,
            operation: example.conflict,
          }),
          (error) => {
            expect(error instanceof OperationIdempotencyConflictError).toBe(true);
            return true;
          },
        );
        expect(await lane.store.get("personal", originalId)).toEqual(original);
        expect(await lane.store.get("personal", conflictId)).toBe(undefined);
      }
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("idempotency keys are account-scoped through the public store", async () => {
  const lanes = await operationStores();

  try {
    for (const lane of lanes) {
      const first = await lane.store.submit({
        accountId: "first-account",
        id: `${lane.name}-first`,
        idempotencyKey: "shared-key",
        operation: sendInput("first"),
      });
      const second = await lane.store.submit({
        accountId: "second-account",
        id: `${lane.name}-second`,
        idempotencyKey: "shared-key",
        operation: sendInput("second"),
      });

      expect(first.id === second.id).toBe(false);
      expect(await lane.store.get("first-account", first.id)).toEqual(first);
      expect(await lane.store.get("second-account", second.id)).toEqual(second);
      expect(await lane.store.get("second-account", first.id)).toBe(undefined);
      expect(await lane.store.get("first-account", second.id)).toBe(undefined);
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("libSQL schema enforces account-scoped idempotency uniqueness", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-unique-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const backend = libsqlBackend({
    url,
    accountId: "personal",
    media: memoryMediaStore(),
  });
  const oracle = createClient({ url });

  try {
    const original = await backend.operations.submit({
      accountId: "personal",
      id: "schema-original",
      idempotencyKey: "schema-key",
      operation: sendInput("same"),
    });
    const rawInsert = (accountId: string, operationIdValue: string) =>
      oracle.execute({
        sql: `INSERT INTO wa_operations
          (operation_id, account_id, idempotency_key, input_json, status, submitted_at, updated_at)
          VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        args: [
          operationIdValue,
          accountId,
          original.idempotencyKey,
          JSON.stringify(sendInput("same")),
          1_000,
          1_000,
        ],
      });

    await assert.rejects(rawInsert("personal", "schema-duplicate"), (error) => {
      if (typeof error !== "object" || error === null) assert.fail("expected a constraint error");
      expect(String(Reflect.get(error, "code")).startsWith("SQLITE_CONSTRAINT")).toBe(true);
      return true;
    });
    await rawInsert("other-account", "schema-other-account");
    const rows = await oracle.execute({
      sql: "SELECT account_id FROM wa_operations WHERE idempotency_key = ? ORDER BY account_id",
      args: [original.idempotencyKey],
    });
    expect(rows.rows.map((row) => row.account_id)).toEqual(["other-account", "personal"]);
  } finally {
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("identical Client sends without a key mint distinct UUID operations", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const first = await client.messages.send.text(CHAT, "repeat");
    const second = await client.messages.send.text(CHAT, "repeat");
    await until(async () => {
      const operations = await Promise.all([
        client.operations.get(first.id),
        client.operations.get(second.id),
      ]);
      return operations.every((operation) => operation?.state.status === "succeeded");
    });

    expect(first.id === second.id).toBe(false);
    expect(first.idempotencyKey === second.idempotencyKey).toBe(false);
    expect(
      [first.idempotencyKey, second.idempotencyKey].every((key) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key),
      ),
    ).toBe(true);
    expect(driver.commands.sent.length).toBe(2);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("error sanitization tolerates hostile Error property accessors", () => {
  const error = new Error("safe");
  Object.defineProperties(error, {
    name: {
      get() {
        throw new Error("name getter failed");
      },
    },
    message: {
      get() {
        throw new Error("message getter failed");
      },
    },
    code: {
      get() {
        throw new Error("code getter failed");
      },
    },
  });
  expect(sanitizeOperationError(error)).toEqual({
    name: "Error",
    message: "operation failed before Session call",
  });
});

test("error sanitization drops non-finite numeric codes", () => {
  expect(sanitizeOperationError({ name: "Error", message: "safe", code: Number.NaN })).toEqual({
    name: "Error",
    message: "operation failed before Session call",
  });
});

test("a validation fault before the Session call is failed and sanitized", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "");
    const observed: WhatsAppOperation[] = [];
    const off = client.operations.subscribe(submitted.id, (operation) => {
      observed.push(operation);
    });
    await until(() => observed.at(-1)?.state.status === "failed");
    off();

    expect(observed.map((operation) => operation.state.status)).toEqual([
      "queued",
      "claimed",
      "failed",
    ]);
    expect(driver.commands.sent.length).toBe(0);
    const terminal = observed.at(-1);
    assert.equal(terminal?.state.status, "failed");
    expect(terminal.state.error).toEqual({
      name: "TypeError",
      message: "operation failed before Session call",
    });
    expect(terminal.state.error instanceof Error).toBe(false);
    expect("stack" in terminal.state.error).toBe(false);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("libSQL persists only sanitized pre-execution error fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-error-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const backend = libsqlBackend({
    url,
    accountId: "personal",
    media: memoryMediaStore(),
  });
  const oracle = createClient({ url });
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "");
    await until(async () => {
      const current = await client.operations.get(submitted.id);
      return current?.state.status === "failed";
    });
    const row = await oracle.execute({
      sql: "SELECT error_json FROM wa_operations WHERE account_id = ? AND operation_id = ?",
      args: ["personal", submitted.id],
    });
    const rawError = row.rows[0]?.error_json;
    if (typeof rawError !== "string") assert.fail("operation error_json was not text");
    const error = JSON.parse(rawError) as Record<string, unknown>;
    expect(error).toEqual({
      name: "TypeError",
      message: "operation failed before Session call",
    });
    expect(Object.keys(error).sort()).toEqual(["message", "name"]);
    expect(driver.commands.sent.length).toBe(0);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an incompatible operations table makes the libSQL migration fail atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-migration-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const oracle = createClient({ url });
  await oracle.execute("CREATE TABLE wa_operations (broken TEXT)");
  oracle.close();
  const backend = libsqlBackend({
    url,
    accountId: "personal",
    media: memoryMediaStore(),
  });

  try {
    await assert.rejects(backend.operations.get("personal", "missing"), /account_id/);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Session fault after one send becomes outcome_unknown", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const session: RuntimeSession = {
    ...driver.session,
    async send(to, content, options) {
      await driver.session.send(to, content, options);
      throw new Error("transport result was lost");
    },
  };
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "hello");
    const observed: WhatsAppOperation[] = [];
    const off = client.operations.subscribe(submitted.id, (operation) => {
      observed.push(operation);
    });
    await until(() => observed.at(-1)?.state.status === "outcome_unknown");
    off();

    expect(observed.map((operation) => operation.state.status)).toEqual([
      "queued",
      "claimed",
      "executing",
      "outcome_unknown",
    ]);
    expect(driver.commands.sent.length).toBe(1);
    const terminal = observed.at(-1);
    assert.equal(terminal?.state.status, "outcome_unknown");
    expect(terminal.state.reason).toBe("session_call_failed");
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("runtime stop closes a Session whose in-flight send is still pending", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let settleSend!: (value: { id: string; chatId: string; fromMe: true }) => void;
  const pendingSend = new Promise<{ id: string; chatId: string; fromMe: true }>((resolve) => {
    settleSend = resolve;
  });
  const session: RuntimeSession = {
    ...driver.session,
    send: () => pendingSend,
    async stop() {
      settleSend({ id: "stopped-send", chatId: CHAT, fromMe: true });
      await driver.session.stop?.();
    },
  };
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const submitted = await client.messages.send.text(CHAT, "pending");
    await until(async () => {
      const current = await client.operations.get(submitted.id);
      return current?.state.status === "executing";
    });
    await withDeadline(runtime.stop());
    expect((await backend.operations.get("personal", submitted.id))?.state.status).toBe(
      "succeeded",
    );
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("an operation-store failure stops the Runtime instead of stranding queued work", async () => {
  const base = memoryBackend();
  const failure = new Error("operation store unavailable");
  const backend = {
    ...base,
    operations: {
      ...base.operations,
      async claimNext(): Promise<WhatsAppOperation | undefined> {
        throw failure;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });

  await runtime.start();
  await tick();
  await assert.rejects(runtime.stop(), failure);
});

test("claimed and executing leases expire asymmetrically in both Adapters", async () => {
  const lanes = await operationStores();
  try {
    for (const lane of lanes) {
      await submit(lane.store, "reclaimable");
      const reclaimableStates: string[] = [];
      const offReclaimable = lane.store.subscribe("personal", "reclaimable", (operation) => {
        reclaimableStates.push(operation.state.status);
      });
      const first = await lane.store.claimNext("personal", 100);
      assert.equal(first?.state.status, "claimed");
      lane.setNow(1_100);
      expect(await lane.store.start("personal", "reclaimable", first.state.attemptId, 100)).toBe(
        false,
      );
      expect(await lane.store.recoverExpired("personal")).toBe(1);
      expect((await lane.store.get("personal", "reclaimable"))?.state.status).toBe("queued");

      const replacement = await lane.store.claimNext("personal", 100);
      assert.equal(replacement?.state.status, "claimed");
      expect(replacement.state.attemptId === first.state.attemptId).toBe(false);
      expect(
        await lane.store.start("personal", "reclaimable", replacement.state.attemptId, 100),
      ).toBe(true);
      expect(
        await lane.store.succeed("personal", "reclaimable", replacement.state.attemptId, {
          id: "sent",
          chatId: CHAT,
          fromMe: true,
        }),
      ).toBe(true);
      offReclaimable();
      expect(reclaimableStates).toEqual([
        "queued",
        "claimed",
        "queued",
        "claimed",
        "executing",
        "succeeded",
      ]);

      await submit(lane.store, "uncertain");
      const uncertainStates: string[] = [];
      const offUncertain = lane.store.subscribe("personal", "uncertain", (operation) => {
        uncertainStates.push(operation.state.status);
      });
      const executing = await lane.store.claimNext("personal", 100);
      assert.equal(executing?.state.status, "claimed");
      expect(await lane.store.start("personal", "uncertain", executing.state.attemptId, 100)).toBe(
        true,
      );
      lane.setNow(1_200);
      expect(await lane.store.recoverExpired("personal")).toBe(1);
      const unknown = await lane.store.get("personal", "uncertain");
      assert.equal(unknown?.state.status, "outcome_unknown");
      expect(unknown.state.reason).toBe("execution_lease_expired");
      expect(await lane.store.claimNext("personal", 100)).toBe(undefined);
      offUncertain();
      expect(uncertainStates).toEqual(["queued", "claimed", "executing", "outcome_unknown"]);
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("both operation stores release only the exact claimed attempt", async () => {
  const lanes = await operationStores();
  try {
    for (const lane of lanes) {
      await submit(lane.store, "release-claim");
      const claimed = await lane.store.claimNext("personal", 100);
      assert.equal(claimed?.state.status, "claimed");
      expect(await lane.store.releaseClaim("personal", "release-claim", "different-attempt")).toBe(
        false,
      );
      expect((await lane.store.get("personal", "release-claim"))?.state.status).toBe("claimed");
      expect(
        await lane.store.releaseClaim("personal", "release-claim", claimed.state.attemptId),
      ).toBe(true);
      expect((await lane.store.get("personal", "release-claim"))?.state.status).toBe("queued");
      const replacement = await lane.store.claimNext("personal", 100);
      assert.equal(replacement?.state.status, "claimed");
      expect(replacement.state.attemptId === claimed.state.attemptId).toBe(false);
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("a superseded attempt cannot write in either Adapter", async () => {
  const lanes = await operationStores();
  try {
    for (const lane of lanes) {
      await submit(lane.store, "fenced");
      const stale = await lane.store.claimNext("personal", 100);
      assert.equal(stale?.state.status, "claimed");
      lane.setNow(1_100);
      await lane.store.recoverExpired("personal");
      const replacement = await lane.store.claimNext("personal", 100);
      assert.equal(replacement?.state.status, "claimed");

      expect(await lane.store.start("personal", "fenced", stale.state.attemptId, 100)).toBe(false);
      expect(
        await lane.store.fail("personal", "fenced", stale.state.attemptId, {
          name: "Error",
          message: "stale",
        }),
      ).toBe(false);
      expect(await lane.store.start("personal", "fenced", replacement.state.attemptId, 100)).toBe(
        true,
      );
      expect(await lane.store.succeed("personal", "fenced", stale.state.attemptId, {})).toBe(false);
      expect(
        await lane.store.markUnknown("personal", "fenced", stale.state.attemptId, "stale"),
      ).toBe(false);
      expect((await lane.store.get("personal", "fenced"))?.state.status).toBe("executing");
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("operation subscribers receive one ordered delivery in both Adapters", async () => {
  const lanes = await operationStores();
  try {
    for (const lane of lanes) {
      await submit(lane.store, "subscriptions");
      await tick();
      const first: string[] = [];
      const second: string[] = [];
      let offSecond: (() => void) | undefined;
      const offFirst = lane.store.subscribe("personal", "subscriptions", (operation) => {
        first.push(operation.state.status);
        if (operation.state.status === "claimed" && !offSecond)
          offSecond = lane.store.subscribe("personal", "subscriptions", (nested) => {
            second.push(nested.state.status);
          });
      });
      const independent: string[] = [];
      const offIndependent = lane.store.subscribe("personal", "subscriptions", (operation) => {
        independent.push(operation.state.status);
      });
      await until(() => first.length > 0 && independent.length > 0);
      await lane.store.claimNext("personal", 100);
      await until(() => second.length > 0);

      expect(first).toEqual(["queued", "claimed"]);
      expect(independent).toEqual(["queued", "claimed"]);
      expect(second).toEqual(["claimed"]);
      offFirst();
      offSecond?.();
      offIndependent();
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("outcome_unknown is not retried on restart, reconnect, or wake", async () => {
  const backend = memoryBackend();
  const firstDriver = createTestWhatsAppSession();
  const uncertainSession: RuntimeSession = {
    ...firstDriver.session,
    async send(to, content, options) {
      await firstDriver.session.send(to, content, options);
      throw new Error("transport result was lost");
    },
  };
  const firstRuntime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => uncertainSession,
  });
  await firstRuntime.start();
  const firstClient = await createWhatsAppClient(firstRuntime);
  const uncertain = await firstClient.messages.send.text(CHAT, "uncertain");
  await until(async () => {
    const current = await firstClient.operations.get(uncertain.id);
    return current?.state.status === "outcome_unknown";
  });
  expect(firstDriver.commands.sent.length).toBe(1);
  await firstClient.close();
  await firstRuntime.stop();

  for (let restart = 0; restart < 3; restart += 1) {
    const driver = createTestWhatsAppSession();
    const runtime = createWhatsAppRuntime({
      accountId: "personal",
      backend,
      openSession: () => driver.session,
    });
    await runtime.start();
    const client = await createWhatsAppClient(runtime);
    try {
      await tick();
      await driver.emit({ type: "connection", status: { phase: "connecting" } });
      await tick();
      expect(driver.commands.sent.length).toBe(0);
      await driver.emit({ type: "connection", status: { phase: "online" } });
      await tick();
      expect(driver.commands.sent.length).toBe(0);

      if (restart === 0) {
        const fresh = await client.messages.send.text(CHAT, "fresh");
        await until(async () => {
          const current = await client.operations.get(fresh.id);
          return current?.state.status === "succeeded";
        });
        expect(driver.commands.sent.map((command) => command.content)).toEqual([{ text: "fresh" }]);
      }
    } finally {
      await client.close();
      await runtime.stop().catch(() => {});
    }
  }
});

test("a separate process reads all six states and executes only queued work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-states-"));
  const databasePath = path.join(directory, "whatsapp.db");
  const backend = libsqlBackend({
    url: `file:${databasePath}`,
    accountId: "personal",
    media: memoryMediaStore(),
  });
  const stateIds = {
    queued: "state-queued",
    claimed: "state-claimed",
    executing: "state-executing",
    succeeded: "state-succeeded",
    failed: "state-failed",
    outcome_unknown: "state-outcome-unknown",
  } as const;
  let closed = false;

  const add = (id: string, operation: WhatsAppOperationInput = sendInput(id)) =>
    backend.operations.submit({
      accountId: "personal",
      id,
      idempotencyKey: id,
      operation,
    });
  const claim = async (id: string) => {
    const claimed = await backend.operations.claimNext("personal", 86_400_000);
    assert.equal(claimed?.id, id);
    assert.equal(claimed.state.status, "claimed");
    return claimed.state.attemptId;
  };

  try {
    await add(stateIds.succeeded);
    const succeededAttempt = await claim(stateIds.succeeded);
    assert.equal(
      await backend.operations.start("personal", stateIds.succeeded, succeededAttempt, 86_400_000),
      true,
    );
    assert.equal(
      await backend.operations.succeed("personal", stateIds.succeeded, succeededAttempt, {
        receipt: "recorded",
      }),
      true,
    );

    await add(stateIds.failed);
    const failedAttempt = await claim(stateIds.failed);
    assert.equal(
      await backend.operations.fail("personal", stateIds.failed, failedAttempt, {
        name: "Error",
        message: "known before execution",
      }),
      true,
    );

    await add(stateIds.outcome_unknown);
    const unknownAttempt = await claim(stateIds.outcome_unknown);
    assert.equal(
      await backend.operations.start(
        "personal",
        stateIds.outcome_unknown,
        unknownAttempt,
        86_400_000,
      ),
      true,
    );
    assert.equal(
      await backend.operations.markUnknown(
        "personal",
        stateIds.outcome_unknown,
        unknownAttempt,
        "result_lost",
      ),
      true,
    );

    await add(stateIds.executing);
    const executingAttempt = await claim(stateIds.executing);
    assert.equal(
      await backend.operations.start("personal", stateIds.executing, executingAttempt, 86_400_000),
      true,
    );

    await add(stateIds.claimed);
    await claim(stateIds.claimed);

    await add(stateIds.queued, { type: "typing", chatId: CHAT, on: true });
    await backend.close();
    closed = true;

    const child = await execFileAsync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-test-module-mocks",
        path.join(import.meta.dirname, "operation-states-child.ts"),
        databasePath,
        JSON.stringify(stateIds),
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
        },
      },
    );
    const replacement = JSON.parse(child.stdout) as {
      readonly pid: number;
      readonly before: Record<keyof typeof stateIds, WhatsAppOperation["state"]>;
      readonly after: Record<keyof typeof stateIds, WhatsAppOperation["state"]>;
      readonly commands: {
        readonly sent: number;
        readonly read: number;
        readonly typing: readonly { readonly chatId: string; readonly on: boolean }[];
        readonly history: number;
      };
    };

    assert.notEqual(replacement.pid, process.pid);
    expect(
      Object.fromEntries(
        Object.entries(replacement.before).map(([name, state]) => [name, state.status]),
      ),
    ).toEqual({
      queued: "queued",
      claimed: "claimed",
      executing: "executing",
      succeeded: "succeeded",
      failed: "failed",
      outcome_unknown: "outcome_unknown",
    });
    expect(replacement.after.queued.status).toBe("succeeded");
    for (const name of ["claimed", "executing", "succeeded", "failed", "outcome_unknown"] as const)
      expect(replacement.after[name]).toEqual(replacement.before[name]);
    expect(replacement.commands).toEqual({
      sent: 0,
      read: 0,
      typing: [{ chatId: CHAT, on: true }],
      history: 0,
    });
  } finally {
    if (!closed) await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
