import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const documentedQuickStart = async (file: string): Promise<string> => {
  const markdown = await readFile(path.join(root, file), "utf8");
  const match = markdown.match(
    /<!-- quick-start:start -->\s*```ts\n([^]*?)\n```\s*<!-- quick-start:end -->/,
  );
  assert.ok(match, `${file} is missing the checked quick-start block`);
  return match[1] + "\n";
};

void test("README quick starts are the package-compiled docs example", async () => {
  const source = await readFile(path.join(root, "apps/docs/snippets/quick-start.ts"), "utf8");
  assert.equal(await documentedQuickStart("README.md"), source);
  assert.equal(await documentedQuickStart("packages/whatsappd/README.md"), source);
});
