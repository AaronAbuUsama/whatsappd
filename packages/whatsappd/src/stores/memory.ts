/**
 * An in-memory {@link CredentialStore} backed by a `Map`. Credentials vanish when
 * the process exits, so this suits tests and short-lived scripts — use
 * {@link fileStore} for anything that must survive a restart.
 */
import type { CredentialStore } from "../ports.ts";

export function memoryStore(): CredentialStore {
  const map = new Map<string, string>();
  return {
    async read(key) {
      return map.get(key) ?? null;
    },
    async write(entries) {
      for (const [key, value] of Object.entries(entries)) {
        if (value === null) map.delete(key);
        else map.set(key, value);
      }
    },
    async clear() {
      map.clear();
    },
  };
}
