/**
 * The read paths must not issue one query per row.
 *
 * @remarks
 * N+1 is the defect that never fails a test: every assertion passes, the shape
 * of the result is right, and the cost only appears once a real account has
 * thousands of chats. It is also the easiest regression to introduce here,
 * because `snapshot()` and `messages()` both map rows into records, and moving
 * one lookup inside that `map` is a one-line change nothing else notices.
 *
 * So these tests assert the statement *count*, and assert it at two sizes. A
 * count that is equal at three rows and at forty is a constant; a count taken
 * once could be any shape at all.
 *
 * Counting the statements is the whole difficulty, and three earlier attempts
 * were wrong in a way worth recording, because two of them looked like they
 * worked:
 *
 *   - Opening a second libSQL client on the same file and wrapping that. Two
 *     connections to one SQLite file share the file, not the call path, so it
 *     observed *zero* statements. Both tests passed, comparing 0 to 0.
 *   - Reassigning `createClient` on the imported module object. ES module
 *     namespaces are frozen; this throws.
 *   - `PRAGMA sqlite_stmt` / `PRAGMA stats`, which return no rows here.
 *
 * What works is `mock.module`, which replaces the specifier the runtime
 * resolves, so the client the backend builds internally is the counted one.
 * The mock is installed at module scope, before the dynamic imports below,
 * because a static import of the backend would be hoisted above it and would
 * capture the real client first.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./_expect.ts";
import type { WhatsAppDataEvent, WhatsAppDurableEvent } from "../src/runtime/contracts.ts";

const ACCOUNT = "personal";
const AT = 1_700_000_000_000;

/** Every statement the backend has issued since the last {@link reset}. */
const seen: string[] = [];

/**
 * Statements SQLite runs to manage the transaction rather than to answer a
 * question, which would otherwise inflate every count.
 */
const isBookkeeping = (sql: string): boolean =>
  /^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA|CREATE|SAVEPOINT|RELEASE)/i.test(sql);

const record = (statement: InStatement): void => {
  const sql = typeof statement === "string" ? statement : statement.sql;
  if (!isBookkeeping(sql)) seen.push(sql);
};

const reset = (): void => {
  seen.length = 0;
};

/** The SELECTs among them — the reads whose count must not track row count. */
const selects = (): string[] => seen.filter((sql) => /^\s*SELECT/i.test(sql));

const libsql = await import("@libsql/client");

mock.module("@libsql/client", {
  // `namedExports` rather than `exports`, which Node 24 prefers and Node 22
  // ignores outright: on 22 the replacement is accepted and then not applied,
  // so `createClient` resolves to undefined and the backend cannot open a
  // database at all. `namedExports` is deprecated on 24 but honoured by both,
  // and this suite runs on both.
  namedExports: {
    ...libsql,
    createClient: (config: Parameters<typeof libsql.createClient>[0]): Client => {
      const client = libsql.createClient(config);
      const execute = client.execute.bind(client);
      const transaction = client.transaction.bind(client);
      client.execute = ((statement: InStatement) => {
        record(statement);
        return execute(statement as never);
      }) as Client["execute"];
      client.transaction = (async (mode?: never): Promise<Transaction> => {
        const opened = await transaction(mode);
        const run = opened.execute.bind(opened);
        opened.execute = ((statement: InStatement) => {
          record(statement);
          return run(statement as never);
        }) as Transaction["execute"];
        return opened;
      }) as Client["transaction"];
      return client;
    },
  },
});

const { libsqlBackend, memoryMediaStore } = await import("../src/index.ts");
const { textMessage } = await import("../src/testing.ts");

const observed = (event: WhatsAppDurableEvent, observedAt = AT): WhatsAppDataEvent => ({
  observedAt,
  event,
});

/** A backend on its own temporary database, plus the directory to remove. */
const backendOn = async (): Promise<{
  backend: ReturnType<typeof libsqlBackend>;
  dispose: () => Promise<void>;
}> => {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-query-count-"));
  const backend = libsqlBackend({
    url: pathToFileURL(path.join(directory, "whatsapp.db")).href,
    accountId: ACCOUNT,
    media: memoryMediaStore(),
  });
  return {
    backend,
    dispose: async () => {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** One message into each of `count` distinct chats, so both grow together. */
const chatsWithMessages = (count: number): WhatsAppDataEvent[] =>
  Array.from({ length: count }, (_, index) =>
    observed({
      type: "message",
      message: textMessage({
        id: `m${index}`,
        chatId: `chat-${index}@s.whatsapp.net`,
        text: `message ${index}`,
        timestamp: AT + index,
      }),
    }),
  );

test("snapshot() issues the same number of queries for 3 chats as for 40", async () => {
  const small = await backendOn();
  const large = await backendOn();
  try {
    await small.backend.data.accept(ACCOUNT, chatsWithMessages(3), 1);
    await large.backend.data.accept(ACCOUNT, chatsWithMessages(40), 1);

    reset();
    const few = await small.backend.data.snapshot(ACCOUNT);
    const fewQueries = selects().length;

    reset();
    const many = await large.backend.data.snapshot(ACCOUNT);
    const manyQueries = selects().length;

    // If the counter ever silently observes nothing again, this is what says
    // so, rather than the equality below passing on 0 === 0.
    assert.ok(
      fewQueries > 0,
      "counted no queries at all — the interception is not observing the backend",
    );
    expect(few.chats.length).toBe(3);
    expect(many.chats.length).toBe(40);

    assert.equal(
      manyQueries,
      fewQueries,
      `snapshot() issued ${fewQueries} queries for 3 chats and ${manyQueries} for 40. ` +
        "A count that grows with the row count is an N+1: the per-row work belongs in the query, not in the loop over its results.",
    );
  } finally {
    await small.dispose();
    await large.dispose();
  }
});

test("messages() issues the same number of queries for a 5-message page as for a 50-message page", async () => {
  const resource = await backendOn();
  try {
    const chatId = "person@s.whatsapp.net";
    await resource.backend.data.accept(
      ACCOUNT,
      Array.from({ length: 60 }, (_, index) =>
        observed({
          type: "message",
          message: textMessage({
            id: `m${index}`,
            chatId,
            text: `message ${index}`,
            timestamp: AT + index,
          }),
        }),
      ),
      1,
    );

    reset();
    const small = await resource.backend.data.messages(ACCOUNT, chatId, { limit: 5 });
    const smallQueries = selects().length;

    reset();
    const large = await resource.backend.data.messages(ACCOUNT, chatId, { limit: 50 });
    const largeQueries = selects().length;

    assert.ok(
      smallQueries > 0,
      "counted no queries at all — the interception is not observing the backend",
    );
    expect(small.messages.length).toBe(5);
    expect(large.messages.length).toBe(50);

    assert.equal(
      largeQueries,
      smallQueries,
      `messages() issued ${smallQueries} queries for a 5-message page and ${largeQueries} for 50. ` +
        "A page read is a fixed number of statements regardless of page size; one query per message is the N+1 this test exists to catch.",
    );
  } finally {
    await resource.dispose();
  }
});
