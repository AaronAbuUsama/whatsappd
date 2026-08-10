import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ref = process.argv[2];
assert.ok(ref, "usage: tagged-registry-install.ts <git-ref>");
const core = JSON.parse(await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"));
const react = JSON.parse(await readFile(path.join(root, "packages/react/package.json"), "utf8"));
assert.equal(core.version, react.version);
const taggedResponse = await fetch(
  `https://raw.githubusercontent.com/AaronAbuUsama/whatsappd/${ref}/registry.json`,
);
assert.equal(taggedResponse.ok, true, `tagged registry returned ${taggedResponse.status}`);
const taggedRegistry = (await taggedResponse.json()) as {
  readonly items?: ReadonlyArray<Record<string, unknown>>;
};
const taggedItem = taggedRegistry.items?.find((item) => item.name === "whatsappd");
assert.ok(taggedItem, "tagged registry has no whatsappd item");
const hosted = JSON.parse(
  await readFile(path.join(root, "apps/docs/public/r/whatsappd.json"), "utf8"),
) as Record<string, unknown>;
const { $schema: _schema, ...hostedItem } = hosted;
assert.deepEqual(hostedItem, taggedItem);
async function assertTaggedRendererRegistry(family: "web" | "opentui"): Promise<void> {
  const response = await fetch(
    `https://raw.githubusercontent.com/AaronAbuUsama/whatsappd/${ref}/registry/${family}/registry.json`,
  );
  assert.equal(response.ok, true, `tagged ${family} registry returned ${response.status}`);
  const registry = (await response.json()) as {
    readonly items?: ReadonlyArray<{
      readonly name?: string;
      readonly dependencies?: readonly string[];
      readonly files?: ReadonlyArray<{
        readonly path: string;
        readonly target?: string;
        readonly type?: string;
      }>;
      readonly meta?: { readonly version?: string };
      readonly [key: string]: unknown;
    }>;
  };
  for (const item of registry.items ?? []) {
    assert.ok(item.name, `tagged ${family} item has no name`);
    assert.equal(item.meta?.version, core.version, `${item.name} tagged version`);
    for (const dependency of item.dependencies ?? []) {
      if (dependency.startsWith("whatsappd@") || dependency.startsWith("@whatsappd/react@"))
        assert.equal(
          dependency.endsWith(`@${core.version}`),
          true,
          `${item.name} dependency version`,
        );
    }
    const hosted = JSON.parse(
      await readFile(path.join(root, `apps/docs/public/r/${item.name}.json`), "utf8"),
    ) as Record<string, unknown>;
    const { $schema: _schema, ...hostedItem } = hosted;
    const files = await Promise.all(
      (item.files ?? []).map(async (file) => {
        const source = await fetch(
          `https://raw.githubusercontent.com/AaronAbuUsama/whatsappd/${ref}/${file.path}`,
        );
        assert.equal(source.ok, true, `tagged ${item.name} source returned ${source.status}`);
        return { ...file, content: await source.text() };
      }),
    );
    assert.deepEqual(
      hostedItem,
      item.files ? { ...item, files } : item,
      `${item.name} hosted and tagged items differ`,
    );
  }
}

await assertTaggedRendererRegistry("web");
await assertTaggedRendererRegistry("opentui");
const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-tagged-registry-"));

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
    }),
  );

  const { stdout } = await execFile(
    "pnpm",
    [
      "--filter",
      "@whatsappd/docs",
      "exec",
      "shadcn",
      "add",
      `AaronAbuUsama/whatsappd/whatsappd#${ref}`,
      "--dry-run",
      "--yes",
      "--cwd",
      consumer,
    ],
    { cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } },
  );
  assert.match(stdout, new RegExp(`whatsappd@${core.version.replaceAll(".", "\\.")}`));
  assert.match(stdout, new RegExp(`@whatsappd/react@${react.version.replaceAll(".", "\\.")}`));

  const { stdout: webStdout } = await execFile(
    "pnpm",
    [
      "--filter",
      "@whatsappd/docs",
      "exec",
      "shadcn",
      "add",
      `AaronAbuUsama/whatsappd/whatsapp-inbox#${ref}`,
      "--dry-run",
      "--yes",
      "--cwd",
      consumer,
    ],
    { cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } },
  );
  assert.match(webStdout, /whatsapp-inbox\.tsx/u);
  assert.match(webStdout, new RegExp(`@whatsappd/react@${react.version.replaceAll(".", "\\.")}`));

  const { stdout: opentuiStdout } = await execFile(
    "pnpm",
    [
      "--filter",
      "@whatsappd/docs",
      "exec",
      "shadcn",
      "add",
      `AaronAbuUsama/whatsappd/whatsapp-tui-inbox#${ref}`,
      "--dry-run",
      "--yes",
      "--cwd",
      consumer,
    ],
    { cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } },
  );
  assert.match(opentuiStdout, /whatsapp-inbox\.tsx/u);
  assert.match(
    opentuiStdout,
    new RegExp(`@whatsappd/react@${react.version.replaceAll(".", "\\.")}`),
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
