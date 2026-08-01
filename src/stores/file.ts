/**
 * A file-backed {@link CredentialStore} under one private, library-owned
 * namespace. Durable across restarts; a good default for one account worker.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SignalDataTypeMap } from "baileys";
import type { CredentialStore } from "../ports.ts";

const NAMESPACE = ".whatsappd-credentials";
const STATE_FILE = "store.json";

interface FileState {
  readonly version: 1;
  readonly legacyFallback: boolean;
  readonly values: Readonly<Record<string, string | null>>;
}

const emptyState = (legacyFallback: boolean): FileState => ({
  version: 1,
  legacyFallback,
  values: {},
});

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** The pre-0.2.3 filename, retained only for safe on-demand migration. */
const legacyFileName = (key: string): string => `${key.replace(/[^0-9A-Za-z._-]/g, "_")}.json`;

// The old store had no manifest and claimed the whole supplied directory.
// Restrict cleanup to the exact credential name/prefixes it could emit; every
// other caller-owned entry survives.
const legacySignalTypes = {
  "pre-key": true,
  session: true,
  "sender-key": true,
  "sender-key-memory": true,
  "app-state-sync-key": true,
  "app-state-sync-version": true,
  "lid-mapping": true,
  "device-list": true,
  tctoken: true,
  "identity-key": true,
} satisfies Record<keyof SignalDataTypeMap, true>;

const legacySignalPrefixes = Object.keys(legacySignalTypes);
const isLegacyCredentialFile = (name: string): boolean =>
  name === "creds.json" ||
  legacySignalPrefixes.some((prefix) => name.startsWith(`${prefix}_`) && name.endsWith(".json"));

function parseState(source: string): FileState {
  const parsed: unknown = JSON.parse(source);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { legacyFallback?: unknown }).legacyFallback !== "boolean" ||
    (parsed as { values?: unknown }).values === null ||
    typeof (parsed as { values?: unknown }).values !== "object" ||
    Array.isArray((parsed as { values?: unknown }).values) ||
    Object.values((parsed as FileState).values).some(
      (value) => value !== null && typeof value !== "string",
    )
  )
    throw new TypeError("invalid whatsappd credential file");
  return parsed as FileState;
}

export function fileStore(dir: string): CredentialStore {
  const namespace = join(dir, NAMESPACE);
  const statePath = join(namespace, STATE_FILE);
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const load = async (): Promise<FileState | undefined> => {
    try {
      return parseState(await readFile(statePath, "utf8"));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const commit = async (state: FileState): Promise<void> => {
    await mkdir(namespace, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by umask and does not tighten an existing path.
    await chmod(namespace, 0o700);
    const temporary = join(namespace, `${STATE_FILE}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await rename(temporary, statePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  return {
    read(key) {
      return serialize(async () => {
        const current = await load();
        if (current && Object.hasOwn(current.values, key)) return current.values[key] ?? null;
        if (current && !current.legacyFallback) return null;

        const legacyPath = join(dir, legacyFileName(key));
        let value: string;
        try {
          value = await readFile(legacyPath, "utf8");
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }

        await commit({
          version: 1,
          legacyFallback: true,
          values: { ...current?.values, [key]: value },
        });
        return value;
      });
    },

    write(entries) {
      if (Object.keys(entries).length === 0) return Promise.resolve();
      return serialize(async () => {
        const current = (await load()) ?? emptyState(true);
        const values: Record<string, string | null> = { ...current.values };
        for (const [key, value] of Object.entries(entries)) values[key] = value;
        await commit({ ...current, values });
      });
    },

    clear() {
      return serialize(async () => {
        const legacyFiles = await readdir(dir).catch((error: unknown) => {
          if (isMissing(error)) return [];
          throw error;
        });
        await Promise.all(
          legacyFiles
            .filter(isLegacyCredentialFile)
            .map((name) => rm(join(dir, name), { force: true })),
        );
        // An empty owned state is the durable tombstone that prevents legacy
        // files from reappearing after a normal process restart.
        await commit(emptyState(false));
      });
    },
  };
}
