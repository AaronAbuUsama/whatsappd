import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github/workflows/release.yml");
const historicalReceiptHead = "ce12ab3911cbc97eaef9fd19fdd5bce05585af4c";

const checkoutFetchDepth = (): number => {
  const workflow = readFileSync(workflowPath, "utf8");
  const checkout = workflow.match(/- uses: actions\/checkout@[^\n]+\n(?<body>(?: {8,}.+\n)*)/u);
  assert.ok(checkout, "release workflow has no actions/checkout step");
  const depth = checkout.groups?.body.match(/fetch-depth:\s*(\d+)/u);
  assert.ok(depth, "release checkout does not declare fetch-depth");
  return Number(depth[1]);
};

const cloneAndResolveHistory = (depth: number): ReturnType<typeof spawnSync> => {
  const directory = mkdtempSync(path.join(tmpdir(), "whatsappd-release-checkout-"));
  try {
    const clone = ["clone", "--quiet"];
    if (depth !== 0) clone.push(`--depth=${depth}`);
    clone.push(`file://${root}`, directory);
    execFileSync("git", clone, { cwd: root });
    return spawnSync("git", ["merge-base", "--is-ancestor", historicalReceiptHead, "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

void test("release checkout retains history required by committed receipt validation", () => {
  const shallow = cloneAndResolveHistory(1);
  assert.notEqual(
    shallow.status,
    0,
    "negative control unexpectedly resolved the historical receipt head from a shallow clone",
  );

  const configuredDepth = checkoutFetchDepth();
  assert.equal(configuredDepth, 0, "release checkout must fetch full history");
  const configured = cloneAndResolveHistory(configuredDepth);
  assert.equal(
    configured.status,
    0,
    `configured release checkout cannot resolve ${historicalReceiptHead}: ${String(configured.stderr)}`,
  );
});
