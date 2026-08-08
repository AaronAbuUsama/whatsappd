import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createSession,
  createWhatsAppClient,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
  type CredentialStore,
} from "../src/index.ts";
import { createTestWhatsAppRuntime as createWhatsAppRuntime } from "../src/testing.ts";
import { DEFAULT_ALLOWLIST_PATH } from "./send-guard.ts";

export interface LoggerScanReport {
  readonly lineCount: number;
  readonly patternHits: number;
  readonly knownValueHits: number;
  readonly lifecycleLinesObserved: number;
  readonly errLinesObserved: number;
  readonly floorPassed: boolean;
}

const JID_PATTERN = /@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)/u;
const BASE64_PATTERN = /[A-Za-z0-9+/_-]{32,}={0,2}/u;
const QR_PATTERN = /(?:[A-Za-z0-9+/_-]+={0,2},){2,}[A-Za-z0-9+/_-]+={0,2}/u;
const LIFECYCLE_MESSAGES = new Set(["opening baileys socket", "connection update"]);

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
  }
  return [];
}

function patternHits(value: string): number {
  let hits = 0;
  if (/\d{7,}/u.test(value.replace(/[\s\-().+]/gu, ""))) hits++;
  if (JID_PATTERN.test(value)) hits++;
  if (BASE64_PATTERN.test(value)) hits++;
  if (QR_PATTERN.test(value)) hits++;
  if (value.includes(".proof-private")) hits++;
  return hits;
}

export function scanLoggerOutput(raw: string, knownValues: readonly string[]): LoggerScanReport {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  let leakPatternHits = 0;
  let lifecycleLinesObserved = 0;
  let errLinesObserved = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = line;
    }
    for (const value of stringLeaves(parsed)) leakPatternHits += patternHits(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.msg === "string" && LIFECYCLE_MESSAGES.has(record.msg)) {
        lifecycleLinesObserved++;
      }
      if (Object.hasOwn(record, "err")) errLinesObserved++;
    }
  }

  const knownValueHits = knownValues.filter(
    (value) => value.length > 0 && raw.includes(value),
  ).length;
  return {
    lineCount: lines.length,
    patternHits: leakPatternHits,
    knownValueHits,
    lifecycleLinesObserved,
    errLinesObserved,
    floorPassed: lines.length > 0 && lifecycleLinesObserved > 0 && errLinesObserved > 0,
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const privateRoot = path.join(root, ".proof-private");

function allowlistKnownValues(): string[] {
  const parsed = JSON.parse(readFileSync(DEFAULT_ALLOWLIST_PATH, "utf8")) as unknown;
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  const { groups, chats } = parsed as { groups?: unknown; chats?: unknown };
  assert.ok(Array.isArray(groups) && groups.every((value) => typeof value === "string"));
  assert.ok(Array.isArray(chats) && chats.every((value) => typeof value === "string"));
  assert.ok(groups.length > 0, "the owner-controlled allowlist has no group");
  assert.ok(chats.length > 0, "the owner-controlled allowlist has no peer chat");
  return [...groups, ...chats];
}

async function waitForOnline(readPhase: () => string | undefined): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (readPhase() !== "online") {
    if (Date.now() > deadline) throw new Error("timed out waiting for the real account to resume");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runChild(profile: string): Promise<void> {
  const knownValues = JSON.parse(process.env.LOGGER_PROOF_KNOWN_VALUES ?? "[]") as unknown;
  const nonce = process.env.LOGGER_PROOF_NONCE;
  assert.ok(
    Array.isArray(knownValues) &&
      knownValues.length >= 2 &&
      knownValues.every((value) => typeof value === "string" && value.length > 0),
  );
  assert.ok(nonce);

  const directory = path.join(privateRoot, profile);
  const media = fileMediaStore({ directory });
  const backend = libsqlBackend({
    url: `file:${path.join(directory, "whatsapp.db")}`,
    accountId: profile,
    media,
  });
  const [groupId, peerJid, participantAlt = peerJid] = knownValues;
  const runtime = createWhatsAppRuntime({
    accountId: profile,
    backend,
    openSession(credentials: CredentialStore) {
      return createSession({
        store: credentials,
        auth: qrAuth(),
        metrics() {
          throw Object.assign(new Error("logger redaction control"), {
            data: {
              remoteJid: groupId,
              participant: peerJid,
              participantAlt,
              text: nonce,
            },
          });
        },
      });
    },
  });

  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    await waitForOnline(() => client.account.get().connection?.phase);
  } finally {
    await client.close();
    await runtime.stop();
    await backend.close();
  }
}

function runParent(profile: string): void {
  const knownValues = [...allowlistKnownValues(), randomUUID()];
  const nonce = knownValues.at(-1);
  assert.ok(nonce);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const logPath = path.join(privateRoot, `logger-redaction-${profile}-${Date.now()}.jsonl`);
  const logFd = openSync(logPath, "wx", 0o600);
  let child: ReturnType<typeof spawnSync>;
  try {
    child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url), "--child", profile],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.HOME && { HOME: process.env.HOME }),
          WA_LOG_LEVEL: "trace",
          LOGGER_PROOF_KNOWN_VALUES: JSON.stringify(knownValues.slice(0, -1)),
          LOGGER_PROOF_NONCE: nonce,
        },
        input: "",
        stdio: ["pipe", logFd, "pipe"],
        timeout: 120_000,
        encoding: "utf8",
      },
    );
  } finally {
    closeSync(logFd);
  }

  const raw = readFileSync(logPath, "utf8");
  assert.equal(child.status, 0, `logger proof child failed (stderr bytes: ${child.stderr.length})`);
  assert.ok(statSync(logPath).size > 0, "the captured default-logger output is empty");

  const report = scanLoggerOutput(raw, knownValues);
  assert.equal(report.patternHits, 0, "the default logger emitted a receipt leak pattern");
  assert.equal(report.knownValueHits, 0, "the default logger emitted a held account value");
  assert.ok(report.floorPassed, "the default-logger proof did not meet its anti-skip floor");

  const planted = scanLoggerOutput(
    `${raw}\n${JSON.stringify({ planted: knownValues })}`,
    knownValues,
  );
  assert.equal(
    planted.knownValueHits,
    knownValues.length,
    "the known-value scanner missed a planted held value",
  );
  assert.ok(planted.patternHits > report.patternHits, "the pattern scanner missed planted values");

  console.log(
    JSON.stringify({
      loggerWasDefault: true,
      lineCount: report.lineCount,
      lifecycleLinesObserved: report.lifecycleLinesObserved,
      errLinesObserved: report.errLinesObserved,
      patternHits: report.patternHits,
      knownValueHits: report.knownValueHits,
      positiveControlDetectedAllKnownValues: true,
      logCapturedUnderProofPrivate: true,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--child") await runChild(args[1] ?? "android");
  else runParent(args.find((arg) => arg !== "--") ?? "android");
}
