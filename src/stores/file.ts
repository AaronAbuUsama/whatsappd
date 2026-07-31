/**
 * A file-backed {@link CredentialStore} — one file per key under a directory.
 * Durable across restarts; a good default for a single account worker.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore } from "../ports.ts";

/** Make a key safe to use as a filename. */
const fileName = (key: string): string => `${key.replace(/[^0-9A-Za-z._-]/g, "_")}.json`;

export function fileStore(dir: string): CredentialStore {
  const path = (key: string): string => join(dir, fileName(key));

  return {
    async read(key) {
      try {
        return await readFile(path(key), "utf-8");
      } catch {
        return null; // missing key
      }
    },
    async write(entries) {
      // Every write, not once at creation: the directory can disappear under a
      // live store — a cleanup job, a tmpfs, an operator with `rm -rf` — and a
      // credential save that ENOENTs there is the save that loses the session.
      // `recursive: true` makes this a no-op when the directory already exists.
      await mkdir(dir, { recursive: true });
      await Promise.all(
        Object.entries(entries).map(([key, value]) =>
          value === null ? rm(path(key), { force: true }) : writeFile(path(key), value),
        ),
      );
    },
    async clear() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
