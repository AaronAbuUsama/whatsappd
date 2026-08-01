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
  run<T>(operation: (client: Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const fileOperations = new Map<string, Promise<void>>();

export function lazyLibsqlClient(
  options: Pick<LibsqlStoreOptions, "url" | "authToken">,
  initialize: (client: Client) => Promise<void>,
): LazyLibsqlClient {
  let ready: Promise<Client> | undefined;
  let operations: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  const fileKey = options.url.startsWith("file:") ? options.url : undefined;
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
        // Separate local clients wait for SQLite's writer instead of leaking
        // SQLITE_BUSY through a backend contention boundary.
        if (client.protocol === "file") await client.execute("PRAGMA busy_timeout = 5000");
        await initialize(client);
        return client;
      } catch (error) {
        client.close();
        throw error;
      }
    })());

  return {
    run(operation) {
      if (closed) return Promise.reject(new Error("libSQL client is closed"));
      // Local clients in one process share a queue because the native driver's
      // busy wait blocks the event loop that would otherwise release its lock.
      const before =
        fileKey === undefined ? operations : (fileOperations.get(fileKey) ?? operations);
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
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        await operations;
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
