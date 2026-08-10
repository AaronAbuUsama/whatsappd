import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proof = await mkdtemp(path.join(tmpdir(), "whatsappd-packed-renderers-"));
const archives = path.join(proof, "archives");
const web = path.join(proof, "web");
const opentui = path.join(proof, "opentui");
const webOnly = process.argv.includes("--web");

try {
  await mkdir(archives);
  await execFile("pnpm", ["--filter", "whatsappd", "pack", "--pack-destination", archives], {
    cwd: root,
  });
  await execFile("pnpm", ["--filter", "@whatsappd/react", "pack", "--pack-destination", archives], {
    cwd: root,
  });
  const packed = await readdir(archives);
  const core = packed.find((file) => file.startsWith("whatsappd-") && file.endsWith(".tgz"));
  const react = packed.find((file) => file.startsWith("whatsappd-react-") && file.endsWith(".tgz"));
  assert.ok(core && react, "both package-family tarballs must exist");

  await cp(path.join(root, "examples/web"), web, {
    recursive: true,
    filter: (source) => !["node_modules", ".next"].includes(path.basename(source)),
  });
  if (!webOnly)
    await cp(path.join(root, "examples/opentui"), opentui, {
      recursive: true,
      filter: (source) => !["node_modules", ".next"].includes(path.basename(source)),
    });
  for (const directory of webOnly ? [web] : [web, opentui]) {
    const target = path.join(directory, "package.json");
    const manifest = JSON.parse(await readFile(target, "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies.whatsappd = `file:${path.join(archives, core)}`;
    manifest.dependencies["@whatsappd/react"] = `file:${path.join(archives, react)}`;
    await writeFile(target, `${JSON.stringify(manifest, undefined, 2)}\n`);
  }
  await writeFile(
    path.join(proof, "pnpm-workspace.yaml"),
    `packages:\n  - "web"\n${webOnly ? "" : '  - "opentui"\n'}allowBuilds:\n  baileys: false\n  esbuild: true\n  ffmpeg-static: true\n  protobufjs: false\n`,
  );
  await execFile("pnpm", ["install"], { cwd: proof });

  const installedCore = JSON.parse(
    await readFile(path.join(web, "node_modules/whatsappd/package.json"), "utf8"),
  ) as { version: string };
  const installedReact = JSON.parse(
    await readFile(path.join(web, "node_modules/@whatsappd/react/package.json"), "utf8"),
  ) as { version: string };
  assert.equal(installedReact.version, installedCore.version);

  const webTests = (await readdir(path.join(web, "tests")))
    .filter((file) => file.endsWith(".test.ts") && file !== "state-lab.test.ts")
    .map((file) => path.join("tests", file));
  await execFile(process.execPath, ["--experimental-strip-types", "--test", ...webTests], {
    cwd: web,
  });
  await execFile("pnpm", ["exec", "next", "build"], { cwd: web });
  await execFile("pnpm", ["test:storybook"], { cwd: web });

  if (!webOnly) {
    await execFile(
      process.execPath,
      ["--experimental-strip-types", "--test", "tests/application.test.ts"],
      { cwd: opentui },
    );
    await execFile("bun", ["tests/app.tui.test.tsx"], { cwd: opentui });
  }
  console.log(
    `Packed renderer proof: web browser${webOnly ? "" : " and OpenTUI native interactions"} passed at ${installedCore.version}`,
  );
} finally {
  await rm(proof, { recursive: true, force: true });
}
