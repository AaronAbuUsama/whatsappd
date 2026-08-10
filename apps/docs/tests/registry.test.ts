import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "shadcn/registry";
import { registryItemSchema, registrySchema } from "shadcn/schema";

const execFile = promisify(execFileCallback);
const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(docsRoot, "../..");

void test("the canonical registry builds one version-locked hosted item", async () => {
  const core = JSON.parse(
    await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"),
  );
  const react = JSON.parse(await readFile(path.join(root, "packages/react/package.json"), "utf8"));
  assert.equal(core.version, react.version);

  const sourceRegistry = registrySchema.parse(
    JSON.parse(await readFile(path.join(root, "registry.json"), "utf8")),
  );
  assert.deepEqual(sourceRegistry.include, [
    "./registry/web/registry.json",
    "./registry/opentui/registry.json",
  ]);
  for (const child of sourceRegistry.include) {
    registrySchema.parse(JSON.parse(await readFile(path.resolve(root, child), "utf8")));
  }

  const registry = await loadRegistry({ cwd: root, registryFile: "registry.json" });
  const base = registry.items.find((item) => item.name === "whatsappd");
  assert.ok(base);
  assert.deepEqual(base.dependencies, [
    `whatsappd@${core.version}`,
    `@whatsappd/react@${react.version}`,
  ]);
  assert.equal(base.meta?.version, core.version);

  const generated = registryItemSchema.parse(
    JSON.parse(await readFile(path.join(docsRoot, "public/r/whatsappd.json"), "utf8")),
  );
  const { files: _files, ...built } = base;
  assert.deepEqual(generated, { $schema: generated.$schema, ...built });
});

void test("the hosted namespace completes a shadcn dry-run install", async () => {
  const registryItem = await readFile(path.join(docsRoot, "public/r/whatsappd.json"));
  const item = registryItemSchema.parse(JSON.parse(registryItem.toString()));
  const version = String(item.meta?.version).replaceAll(".", "\\.");
  const server = createServer((request, response) => {
    if (request.url !== "/r/whatsappd.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(registryItem);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-registry-"));

  try {
    await mkdir(path.join(consumer, "app"));
    await writeFile(path.join(consumer, "app/globals.css"), '@import "tailwindcss";\n');
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies: { next: "16.3.0" } }),
    );
    await writeFile(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }),
    );
    await writeFile(
      path.join(consumer, "components.json"),
      JSON.stringify({
        $schema: "https://ui.shadcn.com/schema.json",
        style: "new-york",
        rsc: true,
        tsx: true,
        tailwind: {
          config: "",
          css: "app/globals.css",
          baseColor: "neutral",
          cssVariables: true,
        },
        aliases: {
          components: "@/components",
          utils: "@/lib/utils",
          ui: "@/components/ui",
          lib: "@/lib",
          hooks: "@/hooks",
        },
        registries: {
          "@whatsappd": `http://127.0.0.1:${address.port}/r/{name}.json`,
        },
      }),
    );

    const { stdout } = await execFile(
      path.join(docsRoot, "node_modules/.bin/shadcn"),
      ["add", "@whatsappd/whatsappd", "--dry-run", "--yes", "--cwd", consumer],
      { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } },
    );
    assert.match(stdout, new RegExp(`@whatsappd/react@${version}`));
    assert.match(stdout, new RegExp(`whatsappd@${version}`));
  } finally {
    server.close();
    await rm(consumer, { recursive: true, force: true });
  }
});
