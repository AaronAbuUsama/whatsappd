import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./_expect.ts";
import { conformsToStore } from "./store-conformance.ts";
import { memoryStore } from "../src/stores/memory.ts";
import { fileStore } from "../src/stores/file.ts";
import { libsqlStore } from "../src/stores/libsql.ts";

// Every store must satisfy the same spec — that's what makes them swappable.
conformsToStore("memory", () => memoryStore());
conformsToStore("file", () => fileStore(mkdtempSync(join(tmpdir(), "wa-file-"))));
conformsToStore("libsql", () => libsqlStore({ url: ":memory:" }));

// libsql-specific: one database, many accounts, fully isolated row-spaces.
test("[libsql] accounts are namespaced within a single database", async () => {
  const url = `file:${join(mkdtempSync(join(tmpdir(), "wa-libsql-")), "shared.db")}`;
  const a = libsqlStore({ url, account: "971000000001" });
  const b = libsqlStore({ url, account: "971000000002" });

  await a.write({ creds: "A-creds" });
  await b.write({ creds: "B-creds" });

  expect(await a.read("creds")).toBe("A-creds");
  expect(await b.read("creds")).toBe("B-creds");

  // Wiping one account leaves the other intact.
  await a.clear();
  expect(await a.read("creds")).toBe(null);
  expect(await b.read("creds")).toBe("B-creds");
});

// libsql-specific: the table name is validated, never interpolated blindly.
test("[libsql] rejects an unsafe table name", () => {
  let threw = false;
  try {
    libsqlStore({ url: ":memory:", table: "wa; DROP TABLE x" });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});
