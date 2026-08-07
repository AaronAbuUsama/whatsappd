import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createClient } from "@libsql/client";
import { test } from "./_expect.ts";
import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  memoryBackend,
  memoryMediaStore,
  memoryOperationStore,
  type WhatsAppOperationInput,
  type WhatsAppOperationStore,
} from "../src/index.ts";
import { createTestWhatsAppSession } from "../src/testing.ts";

const CHAT = "operation-media-target@example.invalid";
const execFileAsync = promisify(execFile);

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(done: () => boolean | Promise<boolean>, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await done()) return;
    await tick();
  }
  assert.fail(`condition did not hold within ${turns} event-loop turns`);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const forbiddenKeys = new Set([
  "stack",
  "creds",
  "noisekey",
  "signedidentitykey",
  "signedprekey",
  "pairingcode",
  "bytes",
  "stream",
  "buffer",
]);

function jsonViolations(value: unknown, path = "$"): string[] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => jsonViolations(entry, `${path}[${index}]`));
  if (typeof value !== "object") return [`${path}: ${typeof value}`];
  const violations: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) violations.push(`${path}.${key}: forbidden key`);
    violations.push(...jsonViolations(nested, `${path}.${key}`));
  }
  return violations;
}

function markerOccurrences(haystack: Uint8Array, marker: Uint8Array): number {
  const encodings = [
    Buffer.from(marker),
    Buffer.from(Buffer.from(marker).toString("base64")),
    Buffer.from(Buffer.from(marker).toString("hex")),
  ];
  let occurrences = 0;
  for (const needle of encodings) {
    for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1)
      if (
        Buffer.from(haystack)
          .subarray(offset, offset + needle.byteLength)
          .equals(needle)
      )
        occurrences += 1;
  }
  return occurrences;
}

async function serializationStores(): Promise<
  readonly {
    readonly name: string;
    readonly store: WhatsAppOperationStore;
    close(): Promise<void>;
  }[]
> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-json-"));
  const backend = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: "personal",
    media: memoryMediaStore(),
    operationClock: { now: () => 1_000 },
  });
  return [
    { name: "memory", store: memoryOperationStore(), async close() {} },
    {
      name: "libSQL",
      store: backend.operations,
      async close() {
        await backend.close();
        await rm(directory, { recursive: true, force: true });
      },
    },
  ];
}

test("a streamed document is staged once and executed from its opaque media ref", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const original = Buffer.from("durable streamed document");
  let iterations = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      iterations += 1;
      yield original.subarray(0, 9);
      yield original.subarray(9);
    },
  };

  try {
    const submitted = await client.messages.send.media(
      CHAT,
      {
        document: { stream },
        fileName: "proof.bin",
        mimetype: "application/octet-stream",
        caption: "caption",
      },
      { idempotencyKey: "streamed-document" },
    );
    await until(async () => {
      const current = await client.operations.get(submitted.id);
      return current?.state.status === "succeeded";
    });

    assert.equal(iterations, 1);
    const persisted = await client.operations.get(submitted.id);
    assert.equal(persisted?.input.type, "send");
    if (persisted?.input.type !== "send" || !("media" in persisted.input.content))
      assert.fail("expected a durable media operation");
    assert.equal(typeof persisted.input.content.media.ref, "string");
    assert.equal(persisted.input.content.media.byteLength, original.byteLength);
    assert.equal(persisted.input.content.media.kind, "document");
    assert.equal("bytes" in persisted.input.content.media, false);
    assert.equal("stream" in persisted.input.content.media, false);

    const sent = driver.commands.sent[0]?.content;
    if (!sent || !("document" in sent)) assert.fail("expected one document send");
    assert.equal(sha256(sent.document as Buffer), sha256(original));
    assert.deepEqual(
      {
        fileName: sent.fileName,
        mimetype: sent.mimetype,
        caption: sent.caption,
      },
      {
        fileName: "proof.bin",
        mimetype: "application/octet-stream",
        caption: "caption",
      },
    );
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("an already-aborted media send neither drains nor submits", async () => {
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
  controller.abort(new Error("cancelled before staging"));
  let iterations = 0;

  try {
    await assert.rejects(
      client.messages.send.media(
        CHAT,
        {
          document: {
            stream: {
              async *[Symbol.asyncIterator]() {
                iterations += 1;
                yield Uint8Array.from([1]);
              },
            },
          },
          fileName: "aborted.bin",
          mimetype: "application/octet-stream",
        },
        { signal: controller.signal },
      ),
      /cancelled before staging/,
    );
    assert.equal(iterations, 0);
    assert.equal(submissions, 0);
    assert.equal(driver.commands.sent.length, 0);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("both operation Adapters refuse secret keys and byte-valued results", async () => {
  const lanes = await serializationStores();

  try {
    for (const lane of lanes) {
      const secretInput = {
        type: "typing",
        chatId: CHAT,
        on: true,
        creds: "must not persist",
      } as WhatsAppOperationInput;
      await assert.rejects(
        lane.store.submit({
          accountId: "personal",
          id: `${lane.name}-secret`,
          idempotencyKey: `${lane.name}-secret`,
          operation: secretInput,
        }),
        /forbidden key creds/,
      );
      assert.equal(await lane.store.get("personal", `${lane.name}-secret`), undefined);

      const operationId = `${lane.name}-bytes`;
      await lane.store.submit({
        accountId: "personal",
        id: operationId,
        idempotencyKey: operationId,
        operation: {
          type: "typing",
          chatId: CHAT,
          on: true,
        },
      });
      const claimed = await lane.store.claimNext("personal", 100);
      assert.equal(claimed?.state.status, "claimed");
      await lane.store.start("personal", operationId, claimed.state.attemptId, 100);
      await assert.rejects(
        lane.store.succeed(
          "personal",
          operationId,
          claimed.state.attemptId,
          Buffer.from("must not persist"),
        ),
        /plain JSON|unsupported/,
      );
      assert.equal((await lane.store.get("personal", operationId))?.state.status, "executing");

      const errorId = `${lane.name}-stack`;
      await lane.store.submit({
        accountId: "personal",
        id: errorId,
        idempotencyKey: errorId,
        operation: { type: "typing", chatId: CHAT, on: true },
      });
      const errorClaim = await lane.store.claimNext("personal", 100);
      assert.equal(errorClaim?.state.status, "claimed");
      await assert.rejects(
        lane.store.fail("personal", errorId, errorClaim.state.attemptId, {
          name: "Error",
          message: "safe",
          stack: "must not persist",
        } as never),
        /forbidden key stack/,
      );
      assert.equal((await lane.store.get("personal", errorId))?.state.status, "claimed");
    }
  } finally {
    await Promise.all(lanes.map((lane) => lane.close()));
  }
});

test("operation JSON stays structural and excludes media and credential canaries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-canary-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const mediaDirectory = path.join(directory, "media");
  const media = fileMediaStore({ directory: mediaDirectory });
  const backend = libsqlBackend({
    url,
    accountId: "personal",
    media,
    operationClock: { now: () => 1_000 },
  });
  const oracle = createClient({ url });
  const mediaMarker = randomBytes(32);
  const credentialMarker = randomBytes(32);
  const stored = await media.put({
    accountId: "personal",
    message: { id: "canary-media", chatId: CHAT, fromMe: true },
    kind: "document",
    bytes: mediaMarker,
    mimetype: "application/octet-stream",
  });
  await backend.credentials.write({
    creds: JSON.stringify({ canary: credentialMarker.toString("base64") }),
  });
  const ref = { id: "message", chatId: CHAT, fromMe: false } as const;
  const inputs: readonly WhatsAppOperationInput[] = [
    { type: "send", chatId: CHAT, content: { text: "text" } },
    {
      type: "send",
      chatId: CHAT,
      content: { media: { kind: "image", ...stored, caption: "image" } },
    },
    {
      type: "send",
      chatId: CHAT,
      content: {
        media: { kind: "video", ...stored, caption: "video", gifPlayback: true },
      },
    },
    {
      type: "send",
      chatId: CHAT,
      content: {
        media: {
          kind: "audio",
          ...stored,
          ptt: true,
          seconds: 1.5,
          mimetype: "audio/ogg",
        },
      },
    },
    {
      type: "send",
      chatId: CHAT,
      content: {
        media: {
          kind: "document",
          ...stored,
          fileName: "proof.bin",
          mimetype: "application/octet-stream",
          caption: "document",
        },
      },
    },
    {
      type: "send",
      chatId: CHAT,
      content: { media: { kind: "sticker", ...stored } },
    },
    { type: "mark_read", refs: [ref] },
    { type: "typing", chatId: CHAT, on: true },
    { type: "phone_history", anchor: { ref, timestamp: 123 }, count: 50 },
  ];
  const memory = memoryOperationStore({ clock: { now: () => 1_000 } });

  try {
    for (const [index, input] of inputs.entries()) {
      const id = `structural-${index}`;
      const submitted = await backend.operations.submit({
        accountId: "personal",
        id,
        idempotencyKey: id,
        operation: input,
      });
      assert.deepEqual(JSON.parse(JSON.stringify(submitted.input)), submitted.input);
      assert.deepEqual(jsonViolations(JSON.parse(JSON.stringify(submitted.input))), []);

      const memorySubmitted = await memory.submit({
        accountId: "personal",
        id: `memory-structural-${index}`,
        idempotencyKey: `memory-structural-${index}`,
        operation: input,
      });
      assert.deepEqual(JSON.parse(JSON.stringify(memorySubmitted.input)), memorySubmitted.input);
      assert.deepEqual(jsonViolations(JSON.parse(JSON.stringify(memorySubmitted.input))), []);
    }

    const succeeded = await backend.operations.claimNext("personal", 100);
    assert.equal(succeeded?.state.status, "claimed");
    await backend.operations.start("personal", succeeded.id, succeeded.state.attemptId, 100);
    await backend.operations.succeed("personal", succeeded.id, succeeded.state.attemptId, {
      id: "sent",
      chatId: CHAT,
      fromMe: true,
    });
    const failed = await backend.operations.claimNext("personal", 100);
    assert.equal(failed?.state.status, "claimed");
    await backend.operations.fail("personal", failed.id, failed.state.attemptId, {
      name: "TypeError",
      message: "safe",
      code: "SAFE",
    });

    const memorySucceeded = await memory.claimNext("personal", 100);
    assert.equal(memorySucceeded?.state.status, "claimed");
    await memory.start("personal", memorySucceeded.id, memorySucceeded.state.attemptId, 100);
    await memory.succeed("personal", memorySucceeded.id, memorySucceeded.state.attemptId, {
      id: "sent",
      chatId: CHAT,
      fromMe: true,
    });
    const memoryFailed = await memory.claimNext("personal", 100);
    assert.equal(memoryFailed?.state.status, "claimed");
    await memory.fail("personal", memoryFailed.id, memoryFailed.state.attemptId, {
      name: "TypeError",
      message: "safe",
      code: "SAFE",
    });
    for (const operationId of [memorySucceeded.id, memoryFailed.id]) {
      const operation = await memory.get("personal", operationId);
      assert.ok(operation);
      assert.deepEqual(JSON.parse(JSON.stringify(operation.input)), operation.input);
      if (operation.state.status === "succeeded")
        assert.deepEqual(
          JSON.parse(JSON.stringify(operation.state.result)),
          operation.state.result,
        );
      if (operation.state.status === "failed")
        assert.deepEqual(JSON.parse(JSON.stringify(operation.state.error)), operation.state.error);
      assert.deepEqual(jsonViolations(JSON.parse(JSON.stringify(operation))), []);
    }

    const rows = await oracle.execute(
      "SELECT input_json, result_json, error_json FROM wa_operations ORDER BY operation_id",
    );
    const rawOperationJson = Buffer.from(
      rows.rows
        .flatMap((row) => [row.input_json, row.result_json, row.error_json])
        .filter((value): value is string => typeof value === "string")
        .join("\n"),
    );
    for (const row of rows.rows)
      for (const column of [row.input_json, row.result_json, row.error_json])
        if (typeof column === "string") assert.deepEqual(jsonViolations(JSON.parse(column)), []);

    assert.equal(markerOccurrences(rawOperationJson, mediaMarker), 0);
    assert.equal(markerOccurrences(rawOperationJson, credentialMarker), 0);

    const mediaFiles = await readdir(path.join(mediaDirectory, ".whatsappd-media"), {
      recursive: true,
    });
    const mediaBytes = Buffer.concat(
      await Promise.all(
        mediaFiles
          .filter((entry) => entry.endsWith(".bin"))
          .map((entry) => readFile(path.join(mediaDirectory, ".whatsappd-media", entry))),
      ),
    );
    assert.ok(markerOccurrences(mediaBytes, mediaMarker) > 0);

    const auth = await oracle.execute({
      sql: "SELECT value FROM wa_auth WHERE account = ? AND key = ?",
      args: ["personal", "creds"],
    });
    const authValue = auth.rows[0]?.value;
    if (typeof authValue !== "string") assert.fail("credential positive control was not text");
    const authBytes = Buffer.from(authValue);
    assert.ok(markerOccurrences(authBytes, credentialMarker) > 0);

    assert.equal(
      jsonViolations({
        stack: true,
        creds: true,
        noiseKey: true,
        signedIdentityKey: true,
        signedPreKey: true,
        pairingCode: true,
        bytes: true,
        stream: true,
        buffer: true,
      }).length,
      9,
    );
    assert.ok(markerOccurrences(Buffer.from(mediaMarker), mediaMarker) > 0);
    assert.ok(
      markerOccurrences(Buffer.from(credentialMarker.toString("base64")), credentialMarker) > 0,
    );
  } finally {
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("every media outbound variant reaches the Session with exact staged bytes", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const cases = [
    {
      name: "image",
      content: { image: Buffer.from("image"), caption: "image caption" },
    },
    {
      name: "video",
      content: { video: Buffer.from("video"), caption: "video caption", gifPlayback: true },
    },
    {
      name: "audio",
      content: {
        audio: Buffer.from("audio"),
        ptt: true,
        seconds: 4,
        mimetype: "audio/ogg",
      },
    },
    {
      name: "document",
      content: {
        document: Buffer.from("document"),
        fileName: "proof.bin",
        mimetype: "application/octet-stream",
        caption: "document caption",
      },
    },
    {
      name: "sticker",
      content: { sticker: Buffer.from("sticker") },
    },
  ] as const;

  try {
    for (const example of cases) {
      const operation = await client.messages.send.media(CHAT, example.content, {
        idempotencyKey: `variant-${example.name}`,
      });
      await until(async () => {
        const current = await client.operations.get(operation.id);
        return current?.state.status === "succeeded";
      });
    }

    assert.equal(driver.commands.sent.length, cases.length);
    for (const [index, example] of cases.entries()) {
      const sent = driver.commands.sent[index]?.content;
      assert.ok(sent);
      const binary = Reflect.get(sent, example.name);
      assert.ok(Buffer.isBuffer(binary));
      assert.equal(sha256(binary), sha256(Reflect.get(example.content, example.name)));
      const operation = await client.operations.get(
        (
          await client.messages.send.media(CHAT, example.content, {
            idempotencyKey: `variant-${example.name}`,
          })
        ).id,
      );
      assert.equal(operation?.state.status, "succeeded");
      assert.equal(driver.commands.sent.length, cases.length);
    }
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
  }
});

test("staged media survives replacement and a missing ref fails before the Session call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-operation-replacement-"));
  const databasePath = path.join(directory, "whatsapp.db");
  const mediaDirectory = path.join(directory, "media");
  const backend = libsqlBackend({
    url: `file:${databasePath}`,
    accountId: "personal",
    media: fileMediaStore({ directory: mediaDirectory }),
  });
  const coldRuntime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => createTestWhatsAppSession().session,
  });
  const coldClient = await createWhatsAppClient(coldRuntime);
  const original = randomBytes(128);

  try {
    const queued = await coldClient.messages.send.media(
      CHAT,
      {
        document: original,
        fileName: "replacement.bin",
        mimetype: "application/octet-stream",
      },
      { idempotencyKey: "replacement-media" },
    );
    assert.equal(queued.state.status, "queued");
    await coldClient.close();
    await backend.close();

    const child = await execFileAsync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-test-module-mocks",
        path.join(import.meta.dirname, "operation-replacement-child.ts"),
        databasePath,
        mediaDirectory,
        queued.id,
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
      status: string;
      sends: number;
      sha256: string;
    };
    assert.deepEqual(replacement, {
      status: "succeeded",
      sends: 1,
      sha256: sha256(original),
    });

    const missingBackend = libsqlBackend({
      url: `file:${path.join(directory, "missing.db")}`,
      accountId: "personal",
      media: fileMediaStore({ directory: path.join(directory, "missing-media") }),
    });
    await missingBackend.operations.submit({
      accountId: "personal",
      id: "missing-ref",
      idempotencyKey: "missing-ref",
      operation: {
        type: "send",
        chatId: CHAT,
        content: {
          media: {
            kind: "document",
            ref: "media:v1:missing",
            byteLength: 128,
            fileName: "missing.bin",
            mimetype: "application/octet-stream",
          },
        },
      },
    });
    const missingDriver = createTestWhatsAppSession();
    const missingRuntime = createWhatsAppRuntime({
      accountId: "personal",
      backend: missingBackend,
      openSession: () => missingDriver.session,
    });
    await missingRuntime.start();
    const missingClient = await createWhatsAppClient(missingRuntime);
    try {
      await until(async () => {
        const current = await missingClient.operations.get("missing-ref");
        return current?.state.status === "failed";
      });
      const missing = await missingClient.operations.get("missing-ref");
      assert.equal(missing?.state.status, "failed");
      assert.equal(missingDriver.commands.sent.length, 0);
    } finally {
      await missingClient.close();
      await missingRuntime.stop();
      await missingBackend.close();
    }
  } finally {
    await coldClient.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
