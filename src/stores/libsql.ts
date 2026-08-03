/**
 * A libsql-backed {@link CredentialStore}. One row per `(account, key)`; the value
 * column holds the library's opaque serialized strings, which libsql never
 * interprets. The same store works against a local file (`file:wa.db`) or a
 * remote libsql/Turso URL, and its async API matches this contract directly.
 *
 * `@libsql/client` is an OPTIONAL peer dependency, imported dynamically so the
 * core package never forces it on consumers who use a different store.
 *
 * The `account` column namespaces sessions, so a single database can hold many
 * WhatsApp accounts (the production `(accountId, key, value)` shape) — the host
 * app passes one `account` per supervised number.
 */
import type { Client } from "@libsql/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CredentialStore } from "../ports.ts";

export interface LibsqlStoreOptions {
  /** `file:wa-auth.db` for local, or a `libsql://…turso.io` URL for remote. */
  url: string;
  /** Auth token for a remote Turso database. */
  authToken?: string;
  /** Namespace — one row-space per account. Default `"default"`. */
  account?: string;
  /** Table name. Default `"wa_auth"`. */
  table?: string;
}

/** Validate the table name ourselves — it's interpolated, never parameterizable. */
function safeTable(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`libsqlStore: invalid table name ${JSON.stringify(name)}`);
  }
  return name;
}

/** One lazily opened libSQL client shared by several backend capabilities. */
export interface LazyLibsqlClient {
  /**
   * Run one operation against the open client. A `"read"` operation promises
   * to take no write lock, which is what lets it skip the local write queue
   * once the database is in WAL; anything else is serialized.
   */
  run<T>(operation: (client: Client) => Promise<T>, mode?: "read" | "write"): Promise<T>;
  close(): Promise<void>;
}

const fileOperations = new Map<string, Promise<void>>();

function fileOperationKey(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  if (url.startsWith("file::memory:")) return url;
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return fileURLToPath(parsed);
  }
  const path = url.slice("file:".length).split(/[?#]/, 1)[0] ?? "";
  return resolve(decodeURIComponent(path));
}

export function lazyLibsqlClient(
  options: Pick<LibsqlStoreOptions, "url" | "authToken">,
  initialize: (client: Client) => Promise<void>,
): LazyLibsqlClient {
  let ready: Promise<Client> | undefined;
  let operations: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  /** Whether this database reached WAL — only knowable once it is open. */
  let walJournal = false;
  /** Unqueued reads still in flight, which close() has to outlive. */
  const reads = new Set<Promise<void>>();
  const fileKey = fileOperationKey(options.url);
  const connect = (): Promise<Client> =>
    (ready ??= (async () => {
      let createClient: typeof import("@libsql/client").createClient;
      try {
        ({ createClient } = await import("@libsql/client"));
      } catch {
        throw new Error(
          "libSQL requires the optional peer dependency '@libsql/client'. Install it: npm i @libsql/client",
        );
      }
      const client = createClient({
        url: options.url,
        ...(options.authToken != null && { authToken: options.authToken }),
      });
      try {
        if (client.protocol === "file") {
          // Separate local clients wait for SQLite's writer instead of leaking
          // SQLITE_BUSY through a backend contention boundary.
          await client.execute("PRAGMA busy_timeout = 5000");
          // Without this a local file runs the rollback journal, where one open
          // read transaction refuses every writer on the file — across
          // connections, backends and worker threads — for as long as the read
          // is held, and the native busy wait blocks the event loop while it
          // waits. WAL puts each reader on its own snapshot instead. The pragma
          // reports the mode actually reached rather than the one asked for: an
          // in-memory database answers `memory`, and a filesystem without
          // shared memory need not reach WAL either, so the answer is read back
          // instead of assumed. It has to run before `initialize`, because WAL
          // cannot be entered from inside a transaction.
          const journal = await client.execute("PRAGMA journal_mode = WAL");
          walJournal = journal.rows[0]?.journal_mode === "wal";
        }
        await initialize(client);
        return client;
      } catch (error) {
        client.close();
        throw error;
      }
    })());

  // Local clients in one process share a queue because the native driver's busy
  // wait blocks the event loop that would otherwise release its lock. WAL only
  // retires the reader-against-writer half of that: two writers still contend,
  // and the loser still busy-waits with the loop stopped, so writes stay here.
  const queued = <T>(operation: (client: Client) => Promise<T>): Promise<T> => {
    const before = fileKey === undefined ? operations : (fileOperations.get(fileKey) ?? operations);
    const result = before.then(async () => {
      const opened = await connect();
      // The local driver hands each transaction a fresh connection, so this
      // connection-local setting must be restored before every operation.
      if (fileKey !== undefined) await opened.execute("PRAGMA busy_timeout = 5000");
      return operation(opened);
    });
    const settled = result.then(
      () => {},
      () => {},
    );
    operations = settled;
    if (fileKey !== undefined) {
      fileOperations.set(fileKey, settled);
      void settled.then(() => {
        if (fileOperations.get(fileKey) === settled) fileOperations.delete(fileKey);
      });
    }
    return result;
  };

  return {
    run(operation, mode = "write") {
      if (closed) return Promise.reject(new Error("libSQL client is closed"));
      if (mode !== "read" || fileKey === undefined) return queued(operation);
      // A WAL reader holds its own snapshot and never waits for a writer, so it
      // does not belong in the queue: `WhatsAppDataStore.read()` keeps its
      // transaction open for a function this package does not control, and
      // queueing it stalls every writer on the file — the runtime's `accept()`
      // among them — for as long as that function runs. Whether this database
      // reached WAL is only settled by opening it, so the queue is still the
      // answer when it did not.
      const result = (async () => {
        const opened = await connect();
        if (!walJournal) return queued(operation);
        await opened.execute("PRAGMA busy_timeout = 5000");
        return operation(opened);
      })();
      // Unqueued reads are outside `operations`, so close() tracks them here
      // rather than closing the client out from under one still in flight.
      const settled = result.then(
        () => {},
        () => {},
      );
      reads.add(settled);
      void settled.then(() => reads.delete(settled));
      return result;
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        await Promise.all([operations, ...reads]);
        if (ready)
          await ready.then(
            (client) => client.close(),
            () => {},
          );
      })());
    },
  };
}

export function libsqlCredentialStore(
  client: LazyLibsqlClient,
  account: string,
  tableName = "wa_auth",
): CredentialStore {
  const table = safeTable(tableName);
  return {
    async read(key) {
      const result = await client.run((opened) =>
        opened.execute({
          sql: `SELECT value FROM ${table} WHERE account = ? AND key = ?`,
          args: [account, key],
        }),
      );
      const value = result.rows[0]?.value;
      if (value == null) return null;
      if (typeof value !== "string") throw new Error("invalid libSQL credential value");
      return value;
    },
    async write(entries) {
      const pairs = Object.entries(entries);
      if (pairs.length === 0) return;
      await client.run((opened) =>
        opened.batch(
          pairs.map(([key, value]) =>
            value === null
              ? { sql: `DELETE FROM ${table} WHERE account = ? AND key = ?`, args: [account, key] }
              : {
                  sql: `INSERT INTO ${table} (account, key, value) VALUES (?, ?, ?) ON CONFLICT(account, key) DO UPDATE SET value = excluded.value`,
                  args: [account, key, value],
                },
          ),
          "write",
        ),
      );
    },
    async clear() {
      await client.run((opened) =>
        opened.execute({ sql: `DELETE FROM ${table} WHERE account = ?`, args: [account] }),
      );
    },
  };
}

export function libsqlStore(options: LibsqlStoreOptions): CredentialStore {
  const account = options.account ?? "default";
  const table = safeTable(options.table ?? "wa_auth");
  const client = lazyLibsqlClient(options, async (opened) => {
    await opened.execute(
      `CREATE TABLE IF NOT EXISTS ${table} (account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account, key))`,
    );
  });
  return libsqlCredentialStore(client, account, table);
}
