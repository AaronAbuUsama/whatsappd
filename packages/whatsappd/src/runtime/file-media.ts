/** Durable local media bytes, separate from structured database state (ADR-0015). */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, mkdir, open as openFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MediaStore } from "./contracts.ts";
import { consumeImmutableMedia, mediaAccountDirectory, mediaObjectName } from "./media.ts";

const NAMESPACE = ".whatsappd-media";

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

async function syncPath(path: string): Promise<void> {
  const handle = await openFile(path, "r");
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
  const paths = (accountId: string, ref: string) => {
    const objectName = mediaObjectName(ref);
    if (!objectName) return undefined;
    const accountDirectory = join(namespace, mediaAccountDirectory(accountId));
    const objectPath = join(accountDirectory, `${objectName}.bin`);
    return { accountDirectory, objectName, objectPath };
  };

  return {
    async write(input) {
      const accountDirectory = join(namespace, mediaAccountDirectory(input.accountId));
      await ensurePrivateDirectory(namespace);
      await ensurePrivateDirectory(accountDirectory);

      const temporary = join(accountDirectory, `${randomUUID()}.tmp`);
      try {
        const handle = await openFile(temporary, "wx", 0o600);
        let stored: Awaited<ReturnType<typeof consumeImmutableMedia>>;
        try {
          stored = await consumeImmutableMedia({
            ...input,
            consume: async (chunk) => {
              let offset = 0;
              while (offset < chunk.byteLength) {
                const { bytesWritten } = await handle.write(chunk, offset);
                if (bytesWritten === 0) throw new Error("media write made no progress");
                offset += bytesWritten;
              }
            },
          });
          await handle.sync();
        } finally {
          await handle.close();
        }

        const location = paths(input.accountId, stored.ref);
        if (!location) throw new Error("generated an invalid immutable media reference");
        const { objectPath } = location;
        try {
          await link(temporary, objectPath);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          const existing = await consumeImmutableMedia({
            ...input,
            source: createReadStream(objectPath),
            consume: () => {},
          });
          if (existing.ref !== stored.ref || existing.byteLength !== stored.byteLength)
            throw new Error(`existing immutable media object does not match ${stored.ref}`);
        }
        await chmod(objectPath, 0o600);
        await syncPath(objectPath);
        return stored;
      } finally {
        await rm(temporary, { force: true });
        await syncPath(accountDirectory);
      }
    },

    async open({ accountId, ref }) {
      const objectName = mediaObjectName(ref);
      if (!objectName) return null;
      const objectPath = join(namespace, mediaAccountDirectory(accountId), `${objectName}.bin`);
      try {
        if (!(await stat(objectPath)).isFile()) return null;
        return createReadStream(objectPath);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      }
    },
  };
}
