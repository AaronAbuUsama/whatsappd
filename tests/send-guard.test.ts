/**
 * The send guard, exercised at the surface a caller actually uses.
 *
 * Six refusals, two resolutions, and zero session sends in every refusal —
 * asserted against the recorded Session rather than against the guard's return
 * value, because "it threw" and "it did not send" are different claims and only
 * the second one is the one that matters. A guard that threw *after* handing the
 * id to the socket would pass a test written the first way.
 *
 * Every id here is **generated** at run time from `randomBytes`. None is copied
 * out of a mirror read, none is committed, and none can collide with a real
 * account: that is the difference between a fixture and a loaded weapon.
 *
 * The type-level half of the guard lives in `tests/send-guard-types.ts` and is
 * proven by `tests/send-guard-proof.ts`, which removes each `@ts-expect-error`
 * in a scratch copy of the tree and requires `pnpm check` to go red. This file
 * covers what compilation cannot: a forged brand cast through `unknown`, and the
 * absence of any subject-matching code path.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "../src/index.ts";
import { createTestWhatsAppSession, type TestWhatsAppSessionDriver } from "../src/testing.ts";
import {
  DEFAULT_ALLOWLIST_PATH,
  guardedClientSender,
  guardedSender,
  resolveAllowlistedTargetForTest,
  SendRefusedError,
  type AllowlistedTarget,
  type SendRefusalReason,
} from "./send-guard.ts";
import {
  callerControlledAllowlistReachingResolver,
  handForgedBrandReachingTheClientSendSite,
  handForgedBrandReachingTheSendSite,
  rawChatIdReachingTheClientSendSite,
  rawChatIdReachingTheSendSite,
} from "./send-guard-types.ts";
import { test } from "./_expect.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `n` decimal digits with no relationship to any real WhatsApp identifier. */
const digits = (n: number): string => Array.from(randomBytes(n), (b) => String(b % 10)).join("");
const syntheticChatId = (): string => `${digits(15)}@s.whatsapp.net`;
const syntheticGroupId = (): string => `${digits(18)}-${digits(10)}@g.us`;

interface Scratch {
  readonly allowlistPath: string;
  cleanup(): Promise<void>;
}

/** An allowlist file in a temp directory. The real one is never read or written here. */
async function scratchAllowlist(contents?: string): Promise<Scratch> {
  const directory = await mkdtemp(path.join(tmpdir(), "whatsappd-allowlist-"));
  const allowlistPath = path.join(directory, "send-allowlist.json");
  if (contents !== undefined) await writeFile(allowlistPath, contents, "utf8");
  return { allowlistPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Which of the guard's two checks refused. `undefined` means the send went through. */
type RefusedAt = "resolve" | "send" | undefined;

/**
 * The whole path a caller takes: resolve, then send.
 *
 * @returns The refusal, which stage produced it, and how many times the Session
 * was asked to send.
 * @remarks
 * Both halves run against one driver so that "refused" and "sent nothing" are
 * observed on the same attempt. A refusal counted on one object and a send count
 * read off another would not be evidence about the same event.
 *
 * `refusedAt` is here because the guard checks the allowlist **twice** — once at
 * resolution and again at the send site — and the two refusals are otherwise
 * indistinguishable. A negative control that replaced the resolver's exact
 * `Set.has` with a prefix match left this suite entirely green: every near-miss
 * resolved, and the send-site re-check refused it with the same reason and the
 * same zero send count. Fail-closed either way, and the resolver was broken with
 * nothing to say so. Naming the stage is what makes that visible.
 */
async function attemptSend(
  id: string,
  allowlistPath: string,
): Promise<{
  error: unknown;
  refusedAt: RefusedAt;
  sends: number;
  driver: TestWhatsAppSessionDriver;
}> {
  const driver = createTestWhatsAppSession();
  let error: unknown;
  let refusedAt: RefusedAt;
  let target: AllowlistedTarget | undefined;
  try {
    target = resolveAllowlistedTargetForTest(id, allowlistPath);
  } catch (thrown) {
    error = thrown;
    refusedAt = "resolve";
  }
  if (target !== undefined) {
    try {
      await guardedSender(driver.session).send(target, {
        text: "this must never leave the process",
      });
    } catch (thrown) {
      error = thrown;
      refusedAt = "send";
    }
  }
  return { error, refusedAt, sends: driver.commands.sent.length, driver };
}

/** Asserts a refusal of exactly `reason`, naming the file and never the id. */
function assertRefused(error: unknown, reason: SendRefusalReason, rejectedId: string): void {
  assert.ok(error instanceof SendRefusedError, `expected a SendRefusedError, got ${String(error)}`);
  assert.equal(error.reason, reason);
  assert.ok(
    error.message.includes(error.allowlistPath),
    "a refusal must name the allowlist file so an operator knows where to look",
  );
  // The positive control for the negative below: the same substring test does
  // find the id when it is present, so "not found" means absent rather than
  // "the check cannot see ids at all".
  assert.ok(
    `prefix ${rejectedId} suffix`.includes(rejectedId),
    "the substring check cannot see a present id — the assertion below would be vacuous",
  );
  assert.ok(
    !error.message.includes(rejectedId),
    "a refusal must never report the rejected id: a refusal is not a reason to print account material",
  );
}

// ── The six refusals ─────────────────────────────────────────────────────────

test("refusal 1/6: a target absent from a populated allowlist is refused, and nothing is sent", async () => {
  const sanctioned = syntheticChatId();
  const unlisted = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ chats: [sanctioned] }));
  try {
    const { error, refusedAt, sends } = await attemptSend(unlisted, scratch.allowlistPath);
    assertRefused(error, "target_not_allowlisted", unlisted);
    assert.equal(
      refusedAt,
      "resolve",
      "an unlisted target should never resolve in the first place",
    );
    assert.equal(sends, 0, "the Session was asked to send a target the allowlist refused");
  } finally {
    await scratch.cleanup();
  }
});

test("refusal 2/6: prefix, suffix and substring near-misses are refused — matching is exact", async () => {
  const sanctioned = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ chats: [sanctioned] }));
  try {
    // Every one of these "looks right" to a human reading a diff, which is the
    // point: an id one character away belongs to somebody else.
    const nearMisses = [
      sanctioned.slice(0, -1), // a truncated id — a prefix of the sanctioned one
      sanctioned.slice(1), // a suffix of it
      `9${sanctioned}`, // the sanctioned id as a substring, with a digit in front
      `${sanctioned}9`, // and with one appended
      ` ${sanctioned}`, // whitespace: no trimming
      `${sanctioned} `,
      sanctioned.toUpperCase(), // no case folding
      sanctioned.replace("@s.whatsapp.net", "@g.us"), // right number, wrong domain
    ];
    assert.ok(
      nearMisses.every((m) => m !== sanctioned),
      "a near-miss must not equal the real id",
    );

    for (const nearMiss of nearMisses) {
      const { error, refusedAt, sends } = await attemptSend(nearMiss, scratch.allowlistPath);
      assertRefused(error, "target_not_allowlisted", nearMiss);
      // At `resolve`, specifically: a resolver that matched on a prefix would
      // hand back a target and let the send-site re-check produce an identical
      // refusal, which is how a broken resolver hides behind a working one.
      assert.equal(
        refusedAt,
        "resolve",
        "a near-miss resolved, and was only caught at the send site",
      );
      assert.equal(sends, 0, "a near-miss reached the Session");
    }
  } finally {
    await scratch.cleanup();
  }
});

test("refusal 3/6: a group whose subject contains 'test' is refused when its id is absent", async () => {
  // The `ios` mirror holds several groups with "test" in the subject that are
  // NOT the sanctioned one, so this is the case that puts a message in front of
  // strangers. The guard is given the record a mirror read would hand back —
  // subject and all — and still has nothing to match it on but the id.
  const sanctionedGroup = syntheticGroupId();
  const scratch = await scratchAllowlist(JSON.stringify({ groups: [sanctionedGroup] }));
  try {
    const temptingGroups = [
      { id: syntheticGroupId(), subject: "test" },
      { id: syntheticGroupId(), subject: "Test Group" },
      { id: syntheticGroupId(), subject: "family — test" },
      { id: syntheticGroupId(), subject: "whatsappd test group" },
    ];
    for (const group of temptingGroups) {
      const { error, refusedAt, sends } = await attemptSend(group.id, scratch.allowlistPath);
      assertRefused(error, "target_not_allowlisted", group.id);
      assert.equal(refusedAt, "resolve", "a 'test'-subject group resolved before being refused");
      assert.ok(
        !(error as SendRefusedError).message.includes(group.subject),
        "a refusal must not echo a group subject either",
      );
      assert.equal(sends, 0, "a group matched by subject reached the Session");
    }
  } finally {
    await scratch.cleanup();
  }
});

test("refusal 4/6: with no allowlist file at all, sending is disabled — and that is distinguishable from 'not listed'", async () => {
  const scratch = await scratchAllowlist(); // the directory exists; the file does not
  try {
    const wouldBeSanctioned = syntheticChatId();
    const { error, refusedAt, sends } = await attemptSend(wouldBeSanctioned, scratch.allowlistPath);
    assertRefused(error, "allowlist_file_absent", wouldBeSanctioned);
    assert.equal(refusedAt, "resolve", "nothing may resolve while there is no allowlist file");
    assert.equal(sends, 0, "a send happened with no allowlist file present");

    // Fails closed, not open: the missing file is not a default-allow, and the
    // operator can tell "nothing is set up" from "your target is not on the list".
    const populated = await scratchAllowlist(JSON.stringify({ chats: [wouldBeSanctioned] }));
    try {
      const listed = await attemptSend(wouldBeSanctioned, populated.allowlistPath);
      assert.equal(listed.error, undefined, "the same id is sendable once a file sanctions it");
      assert.equal(listed.refusedAt, undefined, "a sanctioned id was refused at one of the stages");
      assert.equal(listed.sends, 1, "a sanctioned id did not reach the Session");
      const other = await attemptSend(syntheticChatId(), populated.allowlistPath);
      assert.notEqual(
        (other.error as SendRefusedError).reason,
        (error as SendRefusedError).reason,
        "a missing file must be distinguishable from an unlisted target",
      );
    } finally {
      await populated.cleanup();
    }
  } finally {
    await scratch.cleanup();
  }
});

test("refusal 5/6: an empty allowlist file sanctions nothing", async () => {
  for (const empty of ["", "   \n", "{}", '{ "chats": [] }', '{ "groups": [], "chats": [] }']) {
    const scratch = await scratchAllowlist(empty);
    try {
      const id = syntheticChatId();
      const { error, refusedAt, sends } = await attemptSend(id, scratch.allowlistPath);
      assert.ok(error instanceof SendRefusedError, `"${empty}" was not refused`);
      // `{}` has neither key and is a malformed file; the rest sanction nothing.
      const expected: SendRefusalReason =
        empty.trim() === "{}" ? "allowlist_file_malformed" : "allowlist_file_empty";
      assertRefused(error, expected, id);
      assert.equal(refusedAt, "resolve", "an empty allowlist still resolved a target");
      assert.equal(sends, 0, "an empty allowlist still let something through");
    } finally {
      await scratch.cleanup();
    }
  }
});

test("refusal 6/6: a malformed allowlist file is refused, and the error names the file", async () => {
  const malformed = [
    "{ not json",
    "[]",
    '"a string"',
    "null",
    '{ "chats": "not-an-array" }',
    '{ "groups": [42] }',
    '{ "chats": ["", "  "] }',
    '{ "unrelated": ["x"] }',
  ];
  for (const contents of malformed) {
    const scratch = await scratchAllowlist(contents);
    try {
      const id = syntheticChatId();
      const { error, refusedAt, sends } = await attemptSend(id, scratch.allowlistPath);
      assertRefused(error, "allowlist_file_malformed", id);
      assert.equal(refusedAt, "resolve", `malformed allowlist ${contents} still resolved a target`);
      assert.equal(sends, 0, `malformed allowlist ${contents} still let something through`);
    } finally {
      await scratch.cleanup();
    }
  }
});

// ── The two resolutions, and the positive control ────────────────────────────

test("a sanctioned group id and a sanctioned chat id both resolve and reach the Session", async () => {
  const group = syntheticGroupId();
  const chat = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ groups: [group], chats: [chat] }));
  try {
    // The positive control the six refusals need: a check that refuses
    // everything is indistinguishable from a working guard until something is
    // allowed through, and observed arriving.
    for (const id of [group, chat]) {
      const driver = createTestWhatsAppSession();
      const target = resolveAllowlistedTargetForTest(id, scratch.allowlistPath);
      const ref = await guardedSender(driver.session).send(target, { text: "sanctioned" });

      assert.equal(
        driver.commands.sent.length,
        1,
        "an allowlisted target did not reach the Session",
      );
      assert.equal(
        driver.commands.sent[0]?.to,
        id,
        "the Session was handed a different destination",
      );
      assert.deepEqual(driver.commands.sent[0]?.content, { text: "sanctioned" });
      assert.equal(ref.chatId, id);
    }
  } finally {
    await scratch.cleanup();
  }
});

test("the destination is read from the guard's own record, not off the caller's object", async () => {
  const sanctioned = syntheticChatId();
  const elsewhere = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ chats: [sanctioned] }));
  try {
    const driver = createTestWhatsAppSession();
    const target = resolveAllowlistedTargetForTest(sanctioned, scratch.allowlistPath);

    // A checked target carries no id to overwrite, and is frozen besides.
    // Redirecting it is the attack a `{ id }`-shaped token would allow.
    assert.throws(
      () => Object.assign(target as object, { id: elsewhere, chatId: elsewhere, to: elsewhere }),
      TypeError,
      "a checked target accepted a caller's own destination fields",
    );
    assert.deepEqual(Object.keys(target as object), [], "a checked target must expose nothing");

    await guardedSender(driver.session).send(target, { text: "sanctioned" });
    assert.equal(driver.commands.sent[0]?.to, sanctioned, "the send was redirected by a caller");
  } finally {
    await scratch.cleanup();
  }
});

test("a target is re-checked at the send site, so a withdrawn sanction stops the send", async () => {
  const sanctioned = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ chats: [sanctioned] }));
  try {
    const driver = createTestWhatsAppSession();
    const target = resolveAllowlistedTargetForTest(sanctioned, scratch.allowlistPath);
    await writeFile(scratch.allowlistPath, JSON.stringify({ chats: [syntheticChatId()] }), "utf8");

    await assert.rejects(
      () => guardedSender(driver.session).send(target, { text: "revoked" }),
      (error: unknown) => {
        assertRefused(error, "target_not_allowlisted", sanctioned);
        return true;
      },
    );
    assert.equal(driver.commands.sent.length, 0, "a withdrawn sanction still sent");
  } finally {
    await scratch.cleanup();
  }
});

test("a caller-authored allowlist cannot authorize the production resolver", async () => {
  const unsanctioned = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ chats: [unsanctioned] }));
  try {
    const driver = createTestWhatsAppSession();

    await assert.rejects(
      async () => {
        const target = callerControlledAllowlistReachingResolver(
          unsanctioned,
          scratch.allowlistPath,
        );
        await guardedSender(driver.session).send(target, { text: "self-authorized" });
      },
      (error: unknown) => {
        assert.ok(error instanceof SendRefusedError);
        assert.equal(
          error.allowlistPath,
          DEFAULT_ALLOWLIST_PATH,
          "production resolution accepted the caller's authority file",
        );
        assert.notEqual(error.allowlistPath, scratch.allowlistPath);
        return true;
      },
    );
    assert.equal(driver.commands.sent.length, 0, "a self-authorized target reached the Session");
  } finally {
    await scratch.cleanup();
  }
});

// ── What the type system cannot reach ────────────────────────────────────────

test("a brand forged and cast through `unknown` is refused at runtime, before the Session", async () => {
  const driver = createTestWhatsAppSession();
  const forgeries: unknown[] = [
    { brand: true },
    Object.create(null),
    syntheticChatId(), // untyped code handing a raw string across the boundary
    Object.freeze({}),
  ];
  for (const forgery of forgeries) {
    await assert.rejects(
      () => guardedSender(driver.session).send(forgery as AllowlistedTarget, { text: "forged" }),
      (error: unknown) => {
        assert.ok(error instanceof SendRefusedError);
        assert.equal(error.reason, "target_not_resolved_through_the_guard");
        return true;
      },
    );
  }
  assert.equal(driver.commands.sent.length, 0, "a forged target reached the Session");
});

test("the `@ts-expect-error` fixtures are refused at run time too", async () => {
  const driver = createTestWhatsAppSession();
  const sender = guardedSender(driver.session);
  await assert.rejects(
    () => rawChatIdReachingTheSendSite(sender, syntheticChatId()),
    SendRefusedError,
  );
  await assert.rejects(() => handForgedBrandReachingTheSendSite(sender), SendRefusedError);
  assert.equal(driver.commands.sent.length, 0, "a fixture the compiler rejects still sent");
});

test("the durable Client harness accepts only a resolved target and re-checks it before submission", async () => {
  const sanctioned = syntheticChatId();
  const scratch = await scratchAllowlist(JSON.stringify({ chats: [sanctioned] }));
  const driver = createTestWhatsAppSession();
  const backend = memoryBackend();
  const runtime = createWhatsAppRuntime({
    accountId: "personal",
    backend,
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    const sender = guardedClientSender(client);
    assert.throws(() => rawChatIdReachingTheClientSendSite(sender, sanctioned), SendRefusedError);
    assert.throws(() => handForgedBrandReachingTheClientSendSite(sender), SendRefusedError);
    assert.equal(driver.commands.sent.length, 0, "a forged Client target reached the Session");

    const target = resolveAllowlistedTargetForTest(sanctioned, scratch.allowlistPath);
    const operation = await sender.text(target, "sanctioned", {
      idempotencyKey: "guarded-client-send",
    });
    assert.equal(operation.input.type, "send");
    assert.equal(operation.input.chatId, sanctioned);

    await writeFile(scratch.allowlistPath, JSON.stringify({ chats: [syntheticChatId()] }), "utf8");
    assert.throws(() => sender.text(target, "withdrawn"), SendRefusedError);
  } finally {
    await client.close();
    await runtime.stop().catch(() => {});
    await scratch.cleanup();
  }
});

// ── There is no subject-matching code path ───────────────────────────────────

/** Fuzzy-matching operators, each of which would turn an exact rule into a guess. */
const FUZZY = [
  ".includes(",
  ".startsWith(",
  ".endsWith(",
  ".indexOf(",
  ".lastIndexOf(",
  ".toLowerCase(",
  ".toUpperCase(",
  ".localeCompare(",
  ".normalize(",
  ".match(",
  ".matchAll(",
  ".search(",
  ".test(",
  "RegExp",
  "subject",
] as const;

/** Strips comments and reports every fuzzy operator left in the code. */
function fuzzyMatchingIn(source: string): string[] {
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  return FUZZY.filter((operator) => code.includes(operator));
}

test("the guard contains no subject lookup and no fuzzy matching — exact ids only", async () => {
  // Anti-vacuity: the scanner finds these when they are there. Without this, a
  // scanner with a typo in every pattern would report a clean guard forever.
  const planted = `
    function pick(chat: { id: string; subject: string }): boolean {
      return chat.subject.toLowerCase().includes("test") || /test/.test(chat.id);
    }
  `;
  const found = fuzzyMatchingIn(planted);
  for (const expected of ["subject", ".toLowerCase(", ".includes(", ".test("]) {
    assert.ok(found.includes(expected), `the scanner cannot see ${expected}`);
  }
  // ...and it does not simply flag everything: a comment describing subject
  // matching is not a code path, and this file's own prose says so at length.
  assert.deepEqual(fuzzyMatchingIn("/* subject .includes( */\n// .toLowerCase(\nconst a = 1;"), []);

  const guard = await readFile(path.join(here, "send-guard.ts"), "utf8");
  assert.ok(guard.length > 0, "the guard source was not read — this check would be vacuous");
  assert.deepEqual(
    fuzzyMatchingIn(guard),
    [],
    "the guard matches on something other than an exact id",
  );
});

test("the default allowlist path is the profiles' own gitignored file", () => {
  // Not asserted as a literal string: what matters is that it resolves under
  // `.proof-private/`, which `.gitignore:10` keeps out of the repository.
  assert.equal(path.basename(DEFAULT_ALLOWLIST_PATH), "send-allowlist.json");
  assert.equal(path.basename(path.dirname(DEFAULT_ALLOWLIST_PATH)), ".proof-private");
  assert.ok(path.isAbsolute(DEFAULT_ALLOWLIST_PATH));
});
