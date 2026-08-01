/** Durable local media bytes, separate from structured database state (ADR-0015). */
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MediaStore } from "./contracts.ts";
import { immutableMediaRef, mediaAccountDirectory, mediaObjectName } from "./media.ts";

const NAMESPACE = ".whatsappd-media";

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  if (created === undefined) {
    await syncPath(path);
    return;
  }

  const createdDirectories: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    createdDirectories.unshift(current);
    if (current === created) break;
  }
  await syncPath(dirname(created));
  for (const directory of createdDirectories) await syncPath(directory);
}

export interface FileMediaStoreOptions {
  readonly directory: string;
}

export function fileMediaStore({ directory }: FileMediaStoreOptions): MediaStore {
  const namespace = resolve(directory, NAMESPACE);

  return {
    async put(input) {
      const bytes = Uint8Array.from(input.bytes);
      const ref = immutableMediaRef({ ...input, bytes });
      const objectName = mediaObjectName(ref);
      if (!objectName) throw new Error("generated an invalid immutable media reference");
      const accountDirectory = join(namespace, mediaAccountDirectory(input.accountId));
      const objectPath = join(accountDirectory, `${objectName}.bin`);
      await ensurePrivateDirectory(namespace);
      await ensurePrivateDirectory(accountDirectory);

      const temporary = join(accountDirectory, `${objectName}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
        try {
          await link(temporary, objectPath);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          const existing = await readFile(objectPath);
          if (!existing.equals(Buffer.from(bytes)))
            throw new Error(`existing immutable media object does not match ${ref}`);
        }
        await chmod(objectPath, 0o600);
        await syncPath(objectPath);
      } finally {
        await rm(temporary, { force: true });
        await syncPath(accountDirectory);
      }
      return { ref, byteLength: bytes.byteLength };
    },

    async read({ accountId, ref }) {
      const objectName = mediaObjectName(ref);
      if (!objectName) return null;
      const objectPath = join(namespace, mediaAccountDirectory(accountId), `${objectName}.bin`);
      try {
        return Uint8Array.from(await readFile(objectPath));
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      }
    },
  };
}
