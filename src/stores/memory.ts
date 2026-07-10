/**
 * An in-memory {@link SessionStore} backed by a `Map`. Credentials vanish when
 * the process exits, so this suits tests and short-lived scripts — use
 * {@link fileStore} or `libsqlStore` for anything that must survive a restart.
 */
import type { SessionStore } from "../ports.ts";

export function memoryStore(): SessionStore {
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
