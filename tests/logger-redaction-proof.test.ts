import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./_expect.ts";
import { scanLoggerOutput } from "./logger-redaction-proof.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("logger scan detects planted account values and rejects an empty log", () => {
  const knownValues = ["100000000000000@lid", "120363042384062365@g.us", "proof-nonce-123456789"];
  const clean = [
    JSON.stringify({ level: 30, msg: "connection update" }),
    JSON.stringify({ level: 40, err: { message: "control failure" }, msg: "metrics hook threw" }),
  ].join("\n");

  const report = scanLoggerOutput(clean, knownValues);
  assert.equal(report.patternHits, 0);
  assert.equal(report.knownValueHits, 0);
  assert.equal(report.lineCount, 2);
  assert.equal(report.lifecycleLinesObserved, 1);
  assert.equal(report.errLinesObserved, 1);
  assert.equal(report.floorPassed, true);

  const planted = scanLoggerOutput(
    `${clean}\n${JSON.stringify({ leaked: knownValues })}`,
    knownValues,
  );
  assert.equal(planted.knownValueHits, knownValues.length);
  assert.ok(planted.patternHits >= knownValues.length);

  assert.equal(scanLoggerOutput("", knownValues).floorPassed, false);
});

test("proof-profile cannot bypass the session's default logger", () => {
  const source = readFileSync(path.join(here, "proof-profile.ts"), "utf8");
  assert.doesNotMatch(source, /import pino from "pino"/u);
  assert.doesNotMatch(source, /createSession\(\{[^}]*\blogger\b/su);
});
