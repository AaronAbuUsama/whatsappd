/** Durable local media bytes, separate from structured database state (ADR-0015). */
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  const paths = (accountId: string, ref: string) => {
    const objectName = mediaObjectName(ref);
    if (!objectName) return undefined;
    const accountDirectory = join(namespace, mediaAccountDirectory(accountId));
    const objectPath = join(accountDirectory, `${objectName}.bin`);
    return {
      accountDirectory,
      objectName,
      objectPath,
      retainedPath: `${objectPath}.retained`,
      leasePath: (leaseId: string) => `${objectPath}.${leaseId}.lease`,
    };
  };

  return {
    async put(input) {
      const bytes = Uint8Array.from(input.bytes);
      const ref = immutableMediaRef({ ...input, bytes });
      const objectName = mediaObjectName(ref);
      if (!objectName) throw new Error("generated an invalid immutable media reference");
      const location = paths(input.accountId, ref)!;
      const { accountDirectory, objectPath, retainedPath, leasePath } = location;
      await ensurePrivateDirectory(namespace);
      await ensurePrivateDirectory(accountDirectory);

      const leaseId = randomUUID();
      const heldPath = leasePath(leaseId);
      await writeFile(heldPath, "", { flag: "wx", mode: 0o600, flush: true });
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
        if (!input.temporary) {
          await writeFile(retainedPath, "", { flag: "a", mode: 0o600, flush: true });
          await syncPath(retainedPath);
          await rm(heldPath);
        }
      } catch (error) {
        await rm(heldPath, { force: true });
        throw error;
      } finally {
        await rm(temporary, { force: true });
        await syncPath(accountDirectory);
      }
      return {
        ref,
        byteLength: bytes.byteLength,
        ...(input.temporary && { leaseId }),
      };
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
    async retain({ accountId, ref, leaseId }) {
      const location = paths(accountId, ref);
      if (!location) throw new Error("invalid media staging reference");
      await readFile(location.leasePath(leaseId));
      await writeFile(location.retainedPath, "", { flag: "a", mode: 0o600, flush: true });
      await syncPath(location.retainedPath);
      await rm(location.leasePath(leaseId));
      await syncPath(location.accountDirectory);
    },
    async discard({ accountId, ref, leaseId }) {
      const location = paths(accountId, ref);
      if (!location) return;
      try {
        await rm(location.leasePath(leaseId));
      } catch (error) {
        if (hasCode(error, "ENOENT")) return;
        throw error;
      }
      const entries = await readdir(location.accountDirectory).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return [];
        throw error;
      });
      const leased = entries.some(
        (entry) => entry.startsWith(`${location.objectName}.bin.`) && entry.endsWith(".lease"),
      );
      const retained = await readFile(location.retainedPath)
        .then(() => true)
        .catch((error: unknown) => {
          if (hasCode(error, "ENOENT")) return false;
          throw error;
        });
      if (!leased && !retained) await rm(location.objectPath, { force: true });
      await syncPath(location.accountDirectory);
    },
  };
}
