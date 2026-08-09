import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Client, InStatement, Transaction } from "@libsql/client";

let failNext: RegExp | undefined;
const libsql = await import("@libsql/client");

mock.module("@libsql/client", {
  namedExports: {
    ...libsql,
    createClient: (config: Parameters<typeof libsql.createClient>[0]): Client => {
      const client = libsql.createClient(config);
      const transaction = client.transaction.bind(client);
      client.transaction = (async (mode?: never): Promise<Transaction> => {
        const opened = await transaction(mode);
        const execute = opened.execute.bind(opened);
        opened.execute = ((statement: InStatement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (failNext?.test(sql)) {
            failNext = undefined;
            throw new Error("injected operation write failure");
          }
          return execute(statement as never);
        }) as Transaction["execute"];
        return opened;
      }) as Client["transaction"];
      return client;
    },
  },
});

const { libsqlBackend, memoryMediaStore } = await import("../src/index.ts");
const { operationIdFor } = await import("../src/runtime/operations.ts");

const ACCOUNT = "operation-faults";
const CHAT = "faults@s.whatsapp.net";

void test("libSQL operation writes roll back state and publication at every transition", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-operation-faults-"));
  const backend = libsqlBackend({
    url: pathToFileURL(path.join(directory, "whatsapp.db")).href,
    accountId: ACCOUNT,
    media: memoryMediaStore(),
  });
  const idempotencyKey = "fault-injection";
  const id = operationIdFor(ACCOUNT, idempotencyKey);
  const submission = {
    accountId: ACCOUNT,
    id,
    idempotencyKey,
    input: {
      version: 1,
      type: "send",
      chatId: CHAT,
      content: { text: "atomic" },
    },
  } as const;
  const changes: unknown[] = [];
  const off = backend.operations.subscribe(ACCOUNT, (operation) => changes.push(operation));
  try {
    failNext = /^\s*INSERT INTO wa_operations/i;
    await assert.rejects(backend.operations.submit(submission), /injected operation write failure/);
    assert.deepEqual(await backend.operations.list(ACCOUNT), []);
    assert.deepEqual(changes, []);

    await backend.operations.submit(submission);
    changes.length = 0;
    failNext = /^\s*UPDATE wa_operations/i;
    await assert.rejects(
      backend.operations.claim(ACCOUNT, "attempt", 60_000),
      /injected operation write failure/,
    );
    assert.deepEqual((await backend.operations.get(ACCOUNT, id))?.state, { status: "queued" });
    assert.equal((await backend.operations.get(ACCOUNT, id))?.revision, 0);
    assert.deepEqual(changes, []);

    await backend.operations.claim(ACCOUNT, "attempt", 60_000);
    changes.length = 0;
    failNext = /^\s*UPDATE wa_operations/i;
    await assert.rejects(
      backend.operations.start(ACCOUNT, id, "attempt", 60_000),
      /injected operation write failure/,
    );
    assert.equal((await backend.operations.get(ACCOUNT, id))?.state.status, "claimed");
    assert.equal((await backend.operations.get(ACCOUNT, id))?.revision, 1);
    assert.deepEqual(changes, []);

    await backend.operations.start(ACCOUNT, id, "attempt", 60_000);
    changes.length = 0;
    failNext = /^\s*UPDATE wa_operations/i;
    await assert.rejects(
      backend.operations.succeed(ACCOUNT, id, "attempt", {
        id: "sent",
        chatId: CHAT,
        fromMe: true,
      }),
      /injected operation write failure/,
    );
    assert.equal((await backend.operations.get(ACCOUNT, id))?.state.status, "executing");
    assert.equal((await backend.operations.get(ACCOUNT, id))?.revision, 2);
    assert.deepEqual(changes, []);
  } finally {
    off();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
