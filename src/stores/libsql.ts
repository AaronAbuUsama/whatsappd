/**
 * A libsql-backed {@link SessionStore}. One row per `(account, key)`; the value
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
import type { SessionStore } from "../ports.ts";

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

export function libsqlStore(options: LibsqlStoreOptions): SessionStore {
  const account = options.account ?? "default";
  const table = safeTable(options.table ?? "wa_auth");

  // Lazily create the client + schema once, on first use. Memoized so concurrent
  // first calls share a single init.
  let ready: Promise<Client> | undefined;
  const connect = (): Promise<Client> =>
    (ready ??= (async () => {
      let createClient: typeof import("@libsql/client").createClient;
      try {
        ({ createClient } = await import("@libsql/client"));
      } catch {
        throw new Error(
          "libsqlStore requires the optional peer dependency '@libsql/client'. Install it: npm i @libsql/client",
        );
      }
      const client = createClient({
        url: options.url,
        ...(options.authToken != null && { authToken: options.authToken }),
      });
      await client.execute(
        `CREATE TABLE IF NOT EXISTS ${table} (account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account, key))`,
      );
      return client;
    })());

  return {
    async read(key) {
      const client = await connect();
      const result = await client.execute({
        sql: `SELECT value FROM ${table} WHERE account = ? AND key = ?`,
        args: [account, key],
      });
      const value = result.rows[0]?.value;
      return value == null ? null : String(value as string | number | bigint | Uint8Array);
    },
    async write(entries) {
      const pairs = Object.entries(entries);
      if (pairs.length === 0) return;
      const client = await connect();
      await client.batch(
        pairs.map(([key, value]) =>
          value === null
            ? { sql: `DELETE FROM ${table} WHERE account = ? AND key = ?`, args: [account, key] }
            : {
                sql: `INSERT INTO ${table} (account, key, value) VALUES (?, ?, ?) ON CONFLICT(account, key) DO UPDATE SET value = excluded.value`,
                args: [account, key, value],
              },
        ),
        "write",
      );
    },
    async clear() {
      const client = await connect();
      // Scope the wipe to THIS account — a shared db keeps other accounts intact.
      await client.execute({ sql: `DELETE FROM ${table} WHERE account = ?`, args: [account] });
    },
  };
}
