import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Client, InStatement, Transaction } from "@libsql/client";

let failNext: RegExp | undefined;
let failOnMatch = 1;
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
            failOnMatch -= 1;
            if (failOnMatch === 0) {
              failNext = undefined;
              failOnMatch = 1;
              throw new Error("injected operation write failure");
            }
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
  const url = pathToFileURL(path.join(directory, "whatsapp.db")).href;
  const backend = libsqlBackend({
    url,
    accountId: ACCOUNT,
    media: memoryMediaStore(),
  });
  const oracle = libsql.createClient({ url });
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
  const rawOperations = async () => {
    const result = await oracle.execute({
      sql: `SELECT operation_id, sequence, operation_json
        FROM wa_operations WHERE account_id = ? ORDER BY sequence`,
      args: [ACCOUNT],
    });
    return result.rows.map((row) => {
      if (typeof row.operation_id !== "string" || typeof row.operation_json !== "string")
        throw new TypeError("operation oracle returned an invalid row");
      return {
        id: row.operation_id,
        sequence: Number(row.sequence),
        json: row.operation_json,
      };
    });
  };
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

    await backend.operations.claim(ACCOUNT, "expired-at-once", 0);
    const queuedKey = "queued-behind-expired";
    await backend.operations.submit({
      ...submission,
      id: operationIdFor(ACCOUNT, queuedKey),
      idempotencyKey: queuedKey,
      input: { ...submission.input, content: { text: "queued behind expired" } },
    });
    const beforeClaim = await backend.operations.list(ACCOUNT);
    const rawBeforeClaim = await rawOperations();
    changes.length = 0;
    failNext = /^\s*UPDATE wa_operations/i;
    failOnMatch = 2;
    await assert.rejects(
      backend.operations.claim(ACCOUNT, "replacement", 60_000),
      /injected operation write failure/,
    );
    assert.deepEqual(await backend.operations.list(ACCOUNT), beforeClaim);
    assert.deepEqual(await rawOperations(), rawBeforeClaim);
    assert.deepEqual(changes, []);

    await backend.operations.claim(ACCOUNT, "attempt", 60_000);
    const beforeStart = await backend.operations.get(ACCOUNT, id);
    changes.length = 0;
    failNext = /^\s*UPDATE wa_operations/i;
    await assert.rejects(
      backend.operations.start(ACCOUNT, id, "attempt", 60_000),
      /injected operation write failure/,
    );
    assert.deepEqual(await backend.operations.get(ACCOUNT, id), beforeStart);
    assert.deepEqual(changes, []);

    await backend.operations.start(ACCOUNT, id, "attempt", 60_000);
    const beforeCompletion = await backend.operations.get(ACCOUNT, id);
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
    assert.deepEqual(await backend.operations.get(ACCOUNT, id), beforeCompletion);
    assert.deepEqual(changes, []);
  } finally {
    off();
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
