/**
 * A file-backed {@link SessionStore} — one file per key under a directory.
 * Durable across restarts; a good default for a single sidecar process.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "../ports.ts";

/** Make a key safe to use as a filename. */
const fileName = (key: string): string => `${key.replace(/[^0-9A-Za-z._-]/g, "_")}.json`;

export function fileStore(dir: string): SessionStore {
  const path = (key: string): string => join(dir, fileName(key));
  let ensured = false;
  const ensureDir = async (): Promise<void> => {
    if (ensured) return;
    await mkdir(dir, { recursive: true });
    ensured = true;
  };

  return {
    async read(key) {
      try {
        return await readFile(path(key), "utf-8");
      } catch {
        return null; // missing key
      }
    },
    async write(entries) {
      await ensureDir();
      await Promise.all(
        Object.entries(entries).map(([key, value]) =>
          value === null ? rm(path(key), { force: true }) : writeFile(path(key), value),
        ),
      );
    },
    async clear() {
      ensured = false;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
