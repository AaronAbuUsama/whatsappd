/** Durable local media bytes, separate from structured database state (ADR-0015). */
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaStore } from "./contracts.ts";
import { immutableMediaRef, mediaAccountDirectory, mediaObjectName } from "./media.ts";

const NAMESPACE = ".whatsappd-media";

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

export interface FileMediaStoreOptions {
  readonly directory: string;
}

export function fileMediaStore({ directory }: FileMediaStoreOptions): MediaStore {
  const namespace = join(directory, NAMESPACE);

  return {
    async put(input) {
      const bytes = Uint8Array.from(input.bytes);
      const ref = immutableMediaRef({ ...input, bytes });
      const objectName = mediaObjectName(ref);
      if (!objectName) throw new Error("generated an invalid immutable media reference");
      const accountDirectory = join(namespace, mediaAccountDirectory(input.accountId));
      const objectPath = join(accountDirectory, `${objectName}.bin`);
      await mkdir(namespace, { recursive: true, mode: 0o700 });
      await chmod(namespace, 0o700);
      await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
      await chmod(accountDirectory, 0o700);

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
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
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
