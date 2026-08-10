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
const webRegistryPath = path.join(root, "registry/web/registry.json");
const opentuiRegistryPath = path.join(root, "registry/opentui/registry.json");

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

void test("web items are version locked and the example consumes their exact source", async () => {
  const version = JSON.parse(
    await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"),
  ).version;
  const registry = registrySchema.parse(JSON.parse(await readFile(webRegistryPath, "utf8")));
  assert.deepEqual(
    registry.items.map(({ name }) => name),
    [
      "whatsapp-web-contract",
      "whatsapp-chat-primitives",
      "whatsapp-avatar",
      "whatsapp-account-state",
      "whatsapp-operation-status",
      "whatsapp-composer",
      "whatsapp-message",
      "whatsapp-chat-list",
      "whatsapp-conversation",
      "whatsapp-inbox",
    ],
  );

  for (const item of registry.items) {
    assert.equal(item.meta?.version, version, `${item.name} version`);
    for (const file of item.files ?? []) {
      assert.ok(file.target, `${item.name}:${file.path} has an explicit target`);
      const source = await readFile(path.join(root, "registry/web", file.path), "utf8");
      const installed = await readFile(path.join(root, "examples/web/src", file.target!), "utf8");
      assert.equal(installed, source, `${item.name}:${file.target} drifted from registry source`);
      assert.doesNotMatch(source, /WHATSAPPD_(?:ACCOUNT|PROFILE|SEND)|\/api\//u);
      assert.doesNotMatch(source, /#[\da-f]{3,8}|(?:rgb|hsl)\(/iu);
    }
  }

  const contract = registry.items.find(({ name }) => name === "whatsapp-web-contract");
  const inbox = registry.items.find(({ name }) => name === "whatsapp-inbox");
  assert.ok(contract?.dependencies?.includes(`whatsappd@${version}`));
  assert.ok(inbox?.dependencies?.includes(`@whatsappd/react@${version}`));
});

void test("OpenTUI items are version locked and the example consumes their exact source", async () => {
  const version = JSON.parse(
    await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"),
  ).version;
  const registry = registrySchema.parse(JSON.parse(await readFile(opentuiRegistryPath, "utf8")));
  assert.deepEqual(
    registry.items.map(({ name }) => name),
    [
      "whatsapp-tui-contract",
      "whatsapp-tui-account-state",
      "whatsapp-tui-chat-list",
      "whatsapp-tui-operation-status",
      "whatsapp-tui-message",
      "whatsapp-tui-composer",
      "whatsapp-tui-conversation",
      "whatsapp-tui-inbox",
    ],
  );

  for (const item of registry.items) {
    assert.equal(item.meta?.version, version, `${item.name} version`);
    for (const file of item.files ?? []) {
      assert.ok(file.target, `${item.name}:${file.path} has an explicit target`);
      const source = await readFile(path.join(root, "registry/opentui", file.path), "utf8");
      const installed = await readFile(
        path.join(root, "examples/opentui/src", file.target!),
        "utf8",
      );
      assert.equal(installed, source, `${item.name}:${file.target} drifted from registry source`);
      assert.doesNotMatch(source, /WHATSAPPD_|\/api\/|react-dom|next\//u);
    }
    assert.ok(item.devDependencies?.length, `${item.name} has no devDependencies`);
  }

  const contract = registry.items.find(({ name }) => name === "whatsapp-tui-contract");
  const inbox = registry.items.find(({ name }) => name === "whatsapp-tui-inbox");
  assert.ok(contract?.dependencies?.includes(`whatsappd@${version}`));
  assert.ok(inbox?.dependencies?.includes(`@whatsappd/react@${version}`));
});

void test("the web block installs and typechecks in a clean source consumer", async () => {
  const version = JSON.parse(
    await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"),
  ).version;
  const generated = new Map<string, Buffer>();
  for (const item of [
    "whatsapp-inbox",
    "whatsapp-chat-list",
    "whatsapp-conversation",
    "whatsapp-web-contract",
    "whatsapp-avatar",
    "whatsapp-account-state",
    "whatsapp-chat-primitives",
    "whatsapp-composer",
    "whatsapp-message",
    "whatsapp-operation-status",
  ]) {
    const body = JSON.parse(await readFile(path.join(docsRoot, `public/r/${item}.json`), "utf8"));
    body.dependencies = (body.dependencies ?? []).map((dependency: string) => {
      if (dependency === `whatsappd@${version}`)
        return `whatsappd@file:${path.join(root, "packages/whatsappd")}`;
      if (dependency === `@whatsappd/react@${version}`)
        return `@whatsappd/react@file:${path.join(root, "packages/react")}`;
      return dependency;
    });
    generated.set(`/${item}.json`, Buffer.from(JSON.stringify(body)));
  }
  const server = createServer((request, response) => {
    const body = generated.get(request.url ?? "");
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-web-source-"));

  try {
    await mkdir(path.join(consumer, "app"));
    await writeFile(path.join(consumer, "app/globals.css"), '@import "tailwindcss";\n');
    await writeFile(
      path.join(consumer, "app/page.tsx"),
      `"use client";
import { WhatsAppShell } from "@/components/whatsapp-shell";
import type { WhatsAppBrowser } from "@/lib/whatsappd/web-contract";
const browser = {} as WhatsAppBrowser;
export default function Page() { return <WhatsAppShell browser={browser} />; }
`,
    );
    await writeFile(
      path.join(consumer, "types.d.ts"),
      `declare module "@/lib/utils" {
  export function cn(...inputs: unknown[]): string;
}
`,
    );
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { next: "16.3.0", react: "19.2.8", "react-dom": "19.2.8" },
        devDependencies: {
          "@types/node": "^26.1.1",
          "@types/react": "^19",
          "@types/react-dom": "^19",
          tailwindcss: "^4",
          typescript: "^6.0.3",
        },
      }),
    );
    await writeFile(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "esnext"],
          strict: true,
          noEmit: true,
          jsx: "react-jsx",
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          ignoreDeprecations: "6.0",
          baseUrl: ".",
          paths: {
            "@/*": [`${consumer}/*`],
          },
        },
        include: ["**/*.ts", "**/*.tsx"],
      }),
    );
    await writeFile(
      path.join(consumer, "pnpm-workspace.yaml"),
      "allowBuilds:\n  baileys: false\n  protobufjs: false\n",
    );
    await writeFile(
      path.join(consumer, "components.json"),
      JSON.stringify({
        $schema: "https://ui.shadcn.com/schema.json",
        style: "radix-nova",
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
          "@whatsappd": `http://127.0.0.1:${address.port}/{name}.json`,
        },
      }),
    );
    await execFile("pnpm", ["install", "--ignore-scripts"], { cwd: consumer });
    try {
      await execFile(
        path.join(docsRoot, "node_modules/.bin/shadcn"),
        ["add", "@whatsappd/whatsapp-inbox", "--yes", "--cwd", consumer],
        {
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "",
            PNPM_HOME: process.env.PNPM_HOME ?? "",
          },
        },
      );
    } catch (cause) {
      const output = cause as { readonly stdout?: string; readonly stderr?: string };
      throw new Error(`${output.stdout ?? ""}\n${output.stderr ?? ""}`, { cause });
    }
    await execFile(path.join(consumer, "node_modules/.bin/tsc"), ["--noEmit"], {
      cwd: consumer,
    });
  } finally {
    server.close();
    await rm(consumer, { recursive: true, force: true });
  }
});

void test("the OpenTUI block installs and typechecks in a clean source consumer", async () => {
  const version = JSON.parse(
    await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"),
  ).version;
  const itemNames = [
    "whatsapp-tui-contract",
    "whatsapp-tui-account-state",
    "whatsapp-tui-chat-list",
    "whatsapp-tui-operation-status",
    "whatsapp-tui-message",
    "whatsapp-tui-composer",
    "whatsapp-tui-conversation",
    "whatsapp-tui-inbox",
  ];
  const generated = new Map<string, Buffer>();
  for (const item of itemNames) {
    const body = JSON.parse(await readFile(path.join(docsRoot, `public/r/${item}.json`), "utf8"));
    body.dependencies = (body.dependencies ?? []).map((dependency: string) => {
      if (dependency === `whatsappd@${version}`)
        return `whatsappd@file:${path.join(root, "packages/whatsappd")}`;
      if (dependency === `@whatsappd/react@${version}`)
        return `@whatsappd/react@file:${path.join(root, "packages/react")}`;
      return dependency;
    });
    generated.set(`/${item}.json`, Buffer.from(JSON.stringify(body)));
  }
  const server = createServer((request, response) => {
    const body = generated.get(request.url ?? "");
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const consumer = await mkdtemp(path.join(tmpdir(), "whatsappd-opentui-source-"));

  try {
    await writeFile(
      path.join(consumer, "app.tsx"),
      `import { WhatsAppTui } from "./components/whatsappd-tui/components/whatsapp-inbox.tsx";
import type { TerminalApplication } from "./components/whatsappd-tui/lib/whatsapp-terminal.ts";
declare const application: TerminalApplication;
export const app = <WhatsAppTui application={application} />;
`,
    );
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { react: "19.2.8" },
        devDependencies: {
          typescript: "^6.0.3",
        },
      }),
    );
    await writeFile(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          jsxImportSource: "@opentui/react",
          allowImportingTsExtensions: true,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["**/*.ts", "**/*.tsx"],
      }),
    );
    await writeFile(
      path.join(consumer, "components.json"),
      JSON.stringify({
        $schema: "https://ui.shadcn.com/schema.json",
        style: "new-york",
        rsc: false,
        tsx: true,
        tailwind: { config: "", css: "", baseColor: "neutral", cssVariables: false },
        aliases: {
          components: "@/components",
          utils: "@/lib/utils",
          ui: "@/components/ui",
          lib: "@/lib",
          hooks: "@/hooks",
        },
        registries: {
          "@whatsappd": `http://127.0.0.1:${address.port}/{name}.json`,
        },
      }),
    );
    await writeFile(
      path.join(consumer, "pnpm-workspace.yaml"),
      "allowBuilds:\n  baileys: false\n  protobufjs: false\n",
    );
    await execFile("pnpm", ["install", "--ignore-scripts"], { cwd: consumer });
    try {
      const { stdout } = await execFile(
        path.join(docsRoot, "node_modules/.bin/shadcn"),
        ["add", "@whatsappd/whatsapp-tui-inbox", "--dry-run", "--yes", "--cwd", consumer],
        {
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "",
            PNPM_HOME: process.env.PNPM_HOME ?? "",
          },
        },
      );
      assert.match(stdout, /whatsapp-inbox\.tsx/u);
      assert.match(stdout, /@opentui\/react/u);
      await execFile(
        path.join(docsRoot, "node_modules/.bin/shadcn"),
        ["add", "@whatsappd/whatsapp-tui-inbox", "--yes", "--cwd", consumer],
        {
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "",
            PNPM_HOME: process.env.PNPM_HOME ?? "",
          },
        },
      );
    } catch (cause) {
      const output = cause as { readonly stdout?: string; readonly stderr?: string };
      throw new Error(`${output.stdout ?? ""}\n${output.stderr ?? ""}`, { cause });
    }
    await execFile(path.join(consumer, "node_modules/.bin/tsc"), ["--noEmit"], {
      cwd: consumer,
    });
  } finally {
    server.close();
    await rm(consumer, { recursive: true, force: true });
  }
});
