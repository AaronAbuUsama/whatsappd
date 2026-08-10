import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(
  await readFile(path.join(root, "packages/whatsappd/package.json"), "utf8"),
).version as string;
const files = ["registry.json", "registry/web/registry.json", "registry/opentui/registry.json"];
const versionPattern = /(?<=(?:whatsappd|@whatsappd\/react)@)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/gu;
const metadataPattern = /(?<="version": ")\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?=")/gu;
const check = process.argv.includes("--check");

for (const file of files) {
  const target = path.join(root, file);
  const source = await readFile(target, "utf8");
  const updated = source.replace(versionPattern, version).replace(metadataPattern, version);
  if (check) assert.equal(source, updated, `${file} is not version ${version}`);
  else if (source !== updated) await writeFile(target, updated);
}

for (const family of ["web", "opentui"]) {
  const packageTarget = path.join(root, `registry/${family}/package.json`);
  const packageSource = await readFile(packageTarget, "utf8");
  const packageJson = JSON.parse(packageSource) as { version: string };
  if (check) assert.equal(packageJson.version, version, `registry/${family}/package.json version`);
  else if (packageJson.version !== version) {
    packageJson.version = version;
    await writeFile(packageTarget, `${JSON.stringify(packageJson, undefined, 2)}\n`);
  }
}
