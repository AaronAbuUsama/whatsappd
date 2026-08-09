import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { OperationIdempotencyConflictError } from "../src/runtime/operations.ts";
import { memoryBackend, memoryMediaStore, memoryOperationStore } from "../src/runtime/memory.ts";
import { libsqlBackend } from "../src/runtime/libsql.ts";
import { createWhatsAppRuntime } from "../src/runtime/runtime.ts";
import { createWhatsAppClient } from "../src/runtime/client.ts";
import { fileMediaStore } from "../src/runtime/file-media.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";
import { operationStoreConformance } from "./operation-store-conformance.ts";

const CHAT = "operation-test@s.whatsapp.net";

operationStoreConformance("memory operations", async () => ({
  store: memoryOperationStore(),
  close: async () => {},
}));

operationStoreConformance("libSQL operations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-operations-"));
  const backend = libsqlBackend({
    url: pathToFileURL(path.join(directory, "whatsapp.db")).href,
    accountId: "personal",
    media: memoryMediaStore(),
  });
  return {
    store: backend.operations,
    async close() {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(done: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (done()) return;
    await tick();
  }
  assert.fail(`condition did not hold within ${turns} event-loop turns`);
}

void test("same Client input and key has one durable operation and one Session execution", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "operations",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });

  try {
    const first = await client.messages.send.text(CHAT, "hello", {
      idempotencyKey: "composer-1",
    });
    const repeat = await client.messages.send.text(CHAT, "hello", {
      idempotencyKey: "composer-1",
    });

    assert.equal(repeat.id, first.id);
    await until(() => client.operations.get(first.id)?.state.status === "succeeded");
    assert.equal(driver.commands.sent.length, 1);
    assert.deepEqual(driver.commands.sent[0], {
      to: CHAT,
      content: { text: "hello" },
      options: undefined,
      result: { id: "test-1", chatId: CHAT, fromMe: true },
    });
    await assert.rejects(
      client.messages.send.text(CHAT, "different", { idempotencyKey: "composer-1" }),
      OperationIdempotencyConflictError,
    );
  } finally {
    await client.close();
    await runtime.stop();
  }
});

void test("queued work and its optimistic message survive Client and Runtime replacement", async () => {
  const backend = memoryBackend();
  const firstDriver = createTestWhatsAppSession();
  const firstRuntime = createWhatsAppRuntime({
    accountId: "replacement",
    backend,
    openSession: () => firstDriver.session,
  });
  await firstRuntime.start();
  const firstClient = await createWhatsAppClient(firstRuntime);
  const queued = await firstClient.messages.send.text(CHAT, "survives restart");
  assert.equal(queued.state.status, "queued");
  assert.deepEqual(
    firstClient.messages.get(CHAT).outgoing.map((item) => item.operationId),
    [queued.id],
  );
  await firstClient.close();
  await firstRuntime.stop();

  const replacementDriver = createTestWhatsAppSession();
  const replacementRuntime = createWhatsAppRuntime({
    accountId: "replacement",
    backend,
    openSession: () => replacementDriver.session,
  });
  await replacementRuntime.start();
  const replacementClient = await createWhatsAppClient(replacementRuntime);
  try {
    assert.deepEqual(
      replacementClient.messages.get(CHAT).outgoing.map((item) => item.operationId),
      [queued.id],
    );
    await replacementDriver.emit({ type: "connection", status: { phase: "online" } });
    const completed = await replacementClient.operations.wait(queued.id);
    assert.equal(completed.state.status, "succeeded");
    assert.equal(replacementDriver.commands.sent.length, 1);
    assert.equal(replacementClient.messages.get(CHAT).outgoing.length, 1);
    assert.equal(
      typeof (await replacementClient.operations.acknowledge(queued.id))?.acknowledgedAt,
      "number",
    );
    assert.equal(replacementClient.messages.get(CHAT).outgoing.length, 1);

    await replacementDriver.emit({
      type: "message",
      message: textMessage({
        id: "test-1",
        chatId: CHAT,
        text: "survives restart",
        fromMe: true,
        sender: "15551230000@s.whatsapp.net",
        timestamp: 1,
      }),
    });
    assert.equal(replacementClient.messages.get(CHAT).outgoing.length, 0);
  } finally {
    await replacementClient.close();
    await replacementRuntime.stop();
  }
});

void test("libSQL and file media resume a staged send after backend replacement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-operation-restart-"));
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const media = () => fileMediaStore({ directory: path.join(directory, "media") });
  let operationId = "";
  try {
    const firstBackend = libsqlBackend({ url, accountId: "durable", media: media() });
    const firstDriver = createTestWhatsAppSession();
    const firstRuntime = createWhatsAppRuntime({
      accountId: "durable",
      backend: firstBackend,
      openSession: () => firstDriver.session,
    });
    await firstRuntime.start();
    const firstClient = await createWhatsAppClient(firstRuntime);
    operationId = (
      await firstClient.messages.send.image(CHAT, Buffer.from("durable-image"), {
        idempotencyKey: "durable-image",
      })
    ).id;
    await firstClient.close();
    await firstRuntime.stop();
    await firstBackend.close();

    const replacementBackend = libsqlBackend({ url, accountId: "durable", media: media() });
    const replacementDriver = createTestWhatsAppSession();
    const replacementRuntime = createWhatsAppRuntime({
      accountId: "durable",
      backend: replacementBackend,
      openSession: () => replacementDriver.session,
    });
    await replacementRuntime.start();
    const replacementClient = await createWhatsAppClient(replacementRuntime);
    try {
      await replacementDriver.emit({ type: "connection", status: { phase: "online" } });
      assert.equal(
        (await replacementClient.operations.wait(operationId)).state.status,
        "succeeded",
      );
      assert.deepEqual(replacementDriver.commands.sent[0]?.content, {
        image: Buffer.from("durable-image"),
      });
    } finally {
      await replacementClient.close();
      await replacementRuntime.stop();
      await replacementBackend.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("every Session side effect has an awaited Client command and typing stays live", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "commands",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  const ref = { id: "target", chatId: CHAT, fromMe: true } as const;
  const finish = async (operation: Promise<{ readonly id: string }>): Promise<void> => {
    await client.operations.wait((await operation).id);
  };

  try {
    const generatedA = await client.messages.send.text(CHAT, "one");
    const generatedB = await client.messages.send.text(CHAT, "two");
    assert.notEqual(generatedA.idempotencyKey, generatedB.idempotencyKey);
    await client.operations.wait(generatedA.id);
    await client.operations.wait(generatedB.id);
    await finish(client.messages.send.image(CHAT, Buffer.from("image"), { caption: "image" }));
    await finish(client.messages.send.video(CHAT, Buffer.from("video"), { gifPlayback: true }));
    await finish(client.messages.send.audio(CHAT, Buffer.from("audio"), { ptt: true }));
    await finish(
      client.messages.send.document(CHAT, Buffer.from("document"), {
        fileName: "proof.txt",
        mimetype: "text/plain",
      }),
    );
    await finish(client.messages.send.sticker(CHAT, Buffer.from("sticker")));
    await finish(client.messages.send.location(CHAT, { lat: 5.6, lng: -0.1 }));
    await finish(
      client.messages.send.contacts(CHAT, { displayName: "Ada", vcards: ["BEGIN:VCARD"] }),
    );
    await finish(client.messages.react(ref, "👍"));
    await finish(client.messages.unreact(ref));
    await finish(client.messages.edit(ref, "edited"));
    await finish(client.messages.revoke(ref));
    await finish(client.messages.markRead([ref, ref]));
    await finish(
      client.messages.requestPhoneHistory(CHAT, { before: { ref, timestamp: 1 }, count: 10 }),
    );

    const durableCount = (await backend.operations.list("commands")).length;
    await client.messages.setTyping(CHAT, true);
    assert.deepEqual(driver.commands.typing, [{ chatId: CHAT, on: true }]);
    assert.equal((await backend.operations.list("commands")).length, durableCount);
    assert.equal(driver.commands.sent.length, 13);
    assert.deepEqual(driver.commands.read, [{ refs: [ref] }]);
    assert.equal(driver.commands.historyRequests[0]?.count, 10);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

void test("aborting wait does not cancel work once its durable row exists", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createWhatsAppRuntime({
    accountId: "abort",
    backend,
    openSession: () => ({
      ...driver.session,
      async send(...args) {
        await blocked;
        return driver.session.send(...args);
      },
    }),
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  try {
    const operation = await client.messages.send.text(CHAT, "cannot cancel this");
    await until(() => client.operations.get(operation.id)?.state.status === "executing");
    const controller = new AbortController();
    const waiting = client.operations.wait(operation.id, { signal: controller.signal });
    controller.abort("caller left");
    await assert.rejects(waiting, (error) => error === "caller left");
    assert.equal(client.operations.get(operation.id)?.state.status, "executing");
    release();
    assert.equal((await client.operations.wait(operation.id)).state.status, "succeeded");
  } finally {
    release();
    await client.close();
    await runtime.stop();
  }
});

void test("aborting a stalled media stream closes staging without a durable row", async () => {
  const backend = memoryBackend();
  const runtime = createWhatsAppRuntime({
    accountId: "abort-staging",
    backend,
    openSession: () => createTestWhatsAppSession().session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  let closed = false;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        async return(): Promise<IteratorResult<Uint8Array>> {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const controller = new AbortController();
  try {
    const pending = client.messages.send.image(CHAT, { stream }, { signal: controller.signal });
    await tick();
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
    await until(() => closed);
    assert.equal((await backend.operations.list("abort-staging")).length, 0);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

void test("an abort after media commits still publishes its durable operation", async () => {
  const media = memoryMediaStore();
  let entered!: () => void;
  let release!: () => void;
  const committed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = {
    ...memoryBackend(),
    media: {
      async put(input: Parameters<typeof media.put>[0]) {
        const stored = await media.put(input);
        entered();
        await blocked;
        return stored;
      },
      read: (input: Parameters<typeof media.read>[0]) => media.read(input),
    },
  };
  const runtime = createWhatsAppRuntime({
    accountId: "abort-after-media",
    backend,
    openSession: () => createTestWhatsAppSession().session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const controller = new AbortController();
  try {
    const pending = client.messages.send.image(CHAT, Buffer.from("committed"), {
      signal: controller.signal,
    });
    await committed;
    controller.abort();
    release();
    const operation = await pending;
    assert.equal(operation.state.status, "queued");
    assert.equal((await backend.operations.list("abort-after-media")).length, 1);
  } finally {
    release();
    await client.close();
    await runtime.stop();
  }
});

void test("committed receipts drive Client wait without a second store read", async () => {
  const operations = memoryOperationStore();
  const backend = {
    ...memoryBackend(),
    operations: {
      ...operations,
      get: async () => {
        throw new Error("receipt refresh unavailable");
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "receipt-delivery",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  try {
    const submitted = await client.messages.send.text(CHAT, "one receipt");
    assert.equal(typeof submitted.idempotencyKey, "string");
    assert.equal((await client.operations.wait(submitted.id)).state.status, "succeeded");
    assert.equal(driver.commands.sent.length, 1);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

void test("failures are classified on the correct side of the WhatsApp boundary", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "failure",
    backend,
    openSession: () => ({
      ...driver.session,
      send: async () => {
        throw new Error("socket vanished during send");
      },
    }),
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  try {
    const uncertain = await client.messages.send.text(CHAT, "maybe sent");
    assert.equal((await client.operations.wait(uncertain.id)).state.status, "outcome_unknown");

    const missing = await backend.operations.submit({
      accountId: "failure",
      id: "missing-media",
      idempotencyKey: "missing-media",
      input: {
        version: 1,
        type: "send",
        chatId: CHAT,
        content: { image: { ref: "media:v1:missing" } },
      },
    });
    assert.equal((await client.operations.wait(missing.id)).state.status, "failed");
  } finally {
    await client.close();
    await runtime.stop();
  }
});

void test("a replacement retries a claim left behind by a crashed worker", async () => {
  const backend = memoryBackend();
  const operation = await backend.operations.submit({
    accountId: "crash",
    id: "crash-claim",
    idempotencyKey: "crash-claim",
    input: { version: 1, type: "send", chatId: CHAT, content: { text: "resume me" } },
  });
  await backend.operations.claim("crash", "dead-worker", 20);
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "crash",
    backend,
    operationTtlMs: 20,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  try {
    const completed = await Promise.race([
      client.operations.wait(operation.id),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => reject(new Error("expired claim was not retried")), 2_000);
        timeout.unref();
      }),
    ]);
    assert.equal(completed.state.status, "succeeded");
    assert.equal(driver.commands.sent.length, 1);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

void test("an empty executor does not poll when no recovery deadline exists", async () => {
  const operations = memoryOperationStore();
  let claims = 0;
  const backend = {
    ...memoryBackend(),
    operations: {
      ...operations,
      claim(...input: Parameters<typeof operations.claim>) {
        claims += 1;
        return operations.claim(...input);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "no-operation-polling",
    backend,
    operationTtlMs: 2,
    openSession: () => driver.session,
  });
  await runtime.start();
  await driver.emit({ type: "connection", status: { phase: "online" } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(claims, 1);
  } finally {
    await runtime.stop();
  }
});

void test("stopping after durable start never invokes the stale Session", async () => {
  const operations = memoryOperationStore();
  let entered!: () => void;
  let release!: () => void;
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = {
    ...memoryBackend(),
    operations: {
      ...operations,
      async start(...input: Parameters<typeof operations.start>) {
        const started = await operations.start(...input);
        entered();
        await blocked;
        return started;
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "post-start-stop",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  const operation = await client.messages.send.text(CHAT, "do not send stale");
  await starting;
  const stopping = runtime.stop();
  await tick();
  release();
  try {
    await stopping;
    assert.equal(driver.commands.sent.length, 0);
    assert.equal(
      (await operations.get("post-start-stop", operation.id))?.state.status,
      "outcome_unknown",
    );
  } finally {
    release();
    await client.close();
    await runtime.stop();
  }
});

void test("disconnecting during media preparation requeues before the send boundary", async () => {
  const stored = memoryMediaStore();
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const backend = {
    ...memoryBackend(),
    media: {
      put: (input: Parameters<typeof stored.put>[0]) => stored.put(input),
      async read(input: Parameters<typeof stored.read>[0]) {
        reads += 1;
        if (reads === 1) {
          entered();
          await blocked;
        }
        return stored.read(input);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "disconnect",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  await driver.emit({ type: "connection", status: { phase: "online" } });
  try {
    const operation = await client.messages.send.image(CHAT, Buffer.from("prepared"));
    await reading;
    await driver.emit({ type: "connection", status: { phase: "disconnected" } });
    release();
    await until(() => client.operations.get(operation.id)?.state.status === "queued");
    assert.equal(driver.commands.sent.length, 0);
    await driver.emit({ type: "connection", status: { phase: "online" } });
    assert.equal((await client.operations.wait(operation.id)).state.status, "succeeded");
    assert.equal(driver.commands.sent.length, 1);
  } finally {
    release();
    await client.close();
    await runtime.stop();
  }
});
