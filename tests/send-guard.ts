/**
 * The send guard: a type, not a rule.
 *
 * Two real WhatsApp accounts are linked on the development machine, and one of
 * them holds hundreds of real conversations with real people. A send to the
 * wrong chat id is a message from the owner's own number to a stranger, and it
 * cannot be recalled. `docs/runbooks/real-account-testing.md` lists the three
 * destinations that are permitted; this module is what enforces that list.
 *
 * `docs/client-stack-defect-ledger.md` C10 records why it is a module and not a
 * paragraph: an obligation is missed when the correct path costs more to type
 * than the incorrect one. A `chatId` read straight out of a mirror is the cheap
 * wrong path here — so the guard sits where the send happens, and the send
 * entry point does not accept a `string` at all.
 *
 *   const target = resolveAllowlistedTarget(id);      // may refuse
 *   await guardedSender(session).send(target, { text });
 *
 * Three properties hold together, and none of them is sufficient alone:
 *
 * 1. {@link AllowlistedTarget} is opaque and phantom-branded, so a raw
 *    `chatId: string` and a hand-written `{ … }` both fail to compile at the
 *    send site. `tests/send-guard.test.ts` pins that with `@ts-expect-error`
 *    fixtures, and asserts `pnpm check` goes red when either one is removed.
 * 2. The brand is *also* checked at runtime, from a module-private `WeakMap`
 *    that only this module's resolvers write to. A forged brand cast through
 *    `unknown` type-checks — nothing can stop that — and is still refused.
 * 3. The destination handed to the session is read out of that `WeakMap`, never
 *    off the caller's object. The target therefore exposes no `id` to read, to
 *    pass around, or to tamper with: there is nothing on it to reach for.
 *
 * Matching is exact, and there is deliberately no code path that looks at a
 * group's *subject*. The `ios` mirror alone contains several groups with "test"
 * in the subject that are **not** the sanctioned one, so subject matching is how
 * a message reaches strangers. `tests/send-guard.test.ts` scans this file for
 * substring, prefix, case-folding and regex matching and fails if any appears.
 *
 * A missing allowlist file **disables sending**. That is the correct failure,
 * not a bug to work around: a harness that cannot find its allowlist has not
 * been set up, and guessing an id is exactly the behaviour this prevents.
 *
 * Refusals name the file so a human knows where to look. They never report the
 * rejected id — a refusal is not a reason to print account material. Note that
 * {@link SendRefusedError.allowlistPath} is a `.proof-private/` path: report
 * `reason` in a receipt, never the error itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageRef, Outbound, SendOptions, WhatsAppSession } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the sanctioned ids live, beside the profiles they belong to.
 *
 * @remarks
 * Gitignored, and absent until the owner creates it — the ids are real WhatsApp
 * identifiers, so no agent may write this file. Tests use the explicit
 * test-only resolver seam with a temporary path instead of touching this one.
 */
export const DEFAULT_ALLOWLIST_PATH = path.join(
  here,
  "..",
  ".proof-private",
  "send-allowlist.json",
);

/** Why a send was refused. Every value is safe to record in a receipt. */
export type SendRefusalReason =
  /** No allowlist file exists, so sending is disabled outright. */
  | "allowlist_file_absent"
  /** The file exists but sanctions nothing. */
  | "allowlist_file_empty"
  /** The file exists but is not a readable `{ groups?: string[], chats?: string[] }`. */
  | "allowlist_file_malformed"
  /** The file sanctions targets, and the requested one is not among them. */
  | "target_not_allowlisted"
  /** Something reached the send site without passing through the resolver. */
  | "target_not_resolved_through_the_guard";

/**
 * A refused send.
 *
 * @remarks
 * `reason` is what callers should branch on and what a receipt may record: it
 * distinguishes "there is no allowlist" from "your target is not on it", which
 * are different operator problems with different fixes. The message names the
 * file and never the rejected id.
 */
export class SendRefusedError extends Error {
  override readonly name = "SendRefusedError";
  readonly reason: SendRefusalReason;
  /** The file the verdict came from. A `.proof-private/` path — keep it out of receipts. */
  readonly allowlistPath: string;

  constructor(reason: SendRefusalReason, allowlistPath: string, detail: string) {
    super(`send refused (${reason}): ${detail}. Allowlist file: ${allowlistPath}`);
    this.reason = reason;
    this.allowlistPath = allowlistPath;
  }
}

/**
 * A destination that has been checked against the allowlist.
 *
 * @remarks
 * Opaque on purpose. The brand is a non-exported `unique symbol`, so no caller
 * can spell the type's only member and no object literal can satisfy it; and
 * there is no `id` member, so there is nothing to peel off and hand to a raw
 * `session.send`. The value carries no information at all — the destination it
 * stands for lives in this module's `WeakMap`.
 */
export interface AllowlistedTarget {
  readonly [brand]: true;
}
declare const brand: unique symbol;

/**
 * The destinations this module has issued. The only writer is
 * {@link resolveAllowlistedTarget}.
 *
 * @remarks
 * A `WeakMap` rather than a property on the target, for two reasons: a forged
 * brand cast through `unknown` is not a key here and so cannot send, and the id
 * the session receives is read from here rather than from the caller's object,
 * so tampering with the object cannot redirect a message.
 */
const issued = new WeakMap<AllowlistedTarget, { readonly id: string; readonly path: string }>();

/** True for an array of non-blank strings. A blank entry would be an id that matches by accident. */
function isIdArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((e) => typeof e === "string" && e.trim().length > 0);
}

/**
 * Read the sanctioned ids, or refuse.
 *
 * @remarks
 * Read fresh on every call rather than cached. The file is the authority, and a
 * cache would let a target resolved minutes ago outlive its own sanction.
 */
function sanctionedIds(allowlistPath: string): ReadonlySet<string> {
  const refusal = (reason: SendRefusalReason, detail: string): SendRefusedError =>
    new SendRefusedError(reason, allowlistPath, detail);

  let raw: string;
  try {
    raw = readFileSync(allowlistPath, "utf8");
  } catch (cause) {
    throw (cause as { code?: string }).code === "ENOENT"
      ? refusal(
          "allowlist_file_absent",
          "there is no allowlist file, so sending is disabled. Only the owner may create it — do not guess ids",
        )
      : refusal("allowlist_file_malformed", "the allowlist file could not be read");
  }

  if (raw.trim().length === 0) {
    throw refusal("allowlist_file_empty", "the allowlist file is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refusal("allowlist_file_malformed", "the allowlist file is not valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw refusal("allowlist_file_malformed", "the allowlist file is not a JSON object");
  }

  const { groups, chats } = parsed as { groups?: unknown; chats?: unknown };
  if (groups === undefined && chats === undefined) {
    throw refusal(
      "allowlist_file_malformed",
      "the allowlist file has neither a `groups` nor a `chats` key",
    );
  }
  if (groups !== undefined && !isIdArray(groups)) {
    throw refusal("allowlist_file_malformed", "`groups` is not an array of non-blank strings");
  }
  if (chats !== undefined && !isIdArray(chats)) {
    throw refusal("allowlist_file_malformed", "`chats` is not an array of non-blank strings");
  }

  const ids = new Set<string>([...(groups ?? []), ...(chats ?? [])]);
  if (ids.size === 0) {
    throw refusal("allowlist_file_empty", "the allowlist file sanctions no destination");
  }
  return ids;
}

/**
 * Check one destination against the allowlist, and refuse anything else.
 *
 * @param id - The exact chat or group id to send to. Exact match only: no
 * trimming, no case folding, no prefix, suffix or substring matching, and no
 * subject lookup. A near-miss is a refusal.
 * @returns An opaque {@link AllowlistedTarget}, the only thing a guarded sender
 * accepts.
 * @throws SendRefusedError - On an unlisted target, and on an absent, empty or
 * malformed allowlist file. The error names the file, never the rejected id.
 */
function resolveAgainstAllowlist(id: string, allowlistPath: string): AllowlistedTarget {
  const ids = sanctionedIds(allowlistPath);
  // `Set.has` is the whole matching rule. It is also why a caller that reaches
  // this line with a non-string from untyped code is refused rather than
  // coerced into something that might match.
  if (!ids.has(id)) {
    throw new SendRefusedError(
      "target_not_allowlisted",
      allowlistPath,
      "the requested target is not sanctioned (exact match only; the rejected id is deliberately not reported)",
    );
  }
  const target = Object.freeze({}) as unknown as AllowlistedTarget;
  issued.set(target, { id, path: allowlistPath });
  return target;
}

/**
 * Check one production destination against the owner-controlled allowlist.
 *
 * @remarks
 * There is deliberately no path parameter. Ordinary callers cannot nominate
 * their own authority file and then prove only that they agree with themselves.
 */
export function resolveAllowlistedTarget(id: string): AllowlistedTarget {
  return resolveAgainstAllowlist(id, DEFAULT_ALLOWLIST_PATH);
}

/**
 * Resolve against an isolated allowlist fixture.
 *
 * @remarks
 * Test-only seam. Real-profile harnesses mechanically forbid this export and
 * must use {@link resolveAllowlistedTarget}, which is bound to
 * {@link DEFAULT_ALLOWLIST_PATH}.
 */
export function resolveAllowlistedTargetForTest(
  id: string,
  allowlistPath: string,
): AllowlistedTarget {
  return resolveAgainstAllowlist(id, allowlistPath);
}

/** The send entry point. It has no overload that takes a `string`. */
export interface GuardedSender {
  /**
   * Send to a checked destination.
   *
   * @throws SendRefusedError - Before the session is touched, when the target
   * did not come from {@link resolveAllowlistedTarget} or when its sanction has
   * since been withdrawn.
   */
  send(target: AllowlistedTarget, content: Outbound, options?: SendOptions): Promise<MessageRef>;
}

/**
 * Wrap a session so that the only way to send through it is with a resolved
 * target.
 *
 * @param session - Anything with the session's `send` seam, real or recorded.
 *
 * @remarks
 * The allowlist is re-read here, not trusted from resolution time. Resolution
 * and the send are separate moments, and the file is allowed to change between
 * them; the send site is the last point at which refusing still costs nothing.
 */
export function guardedSender(session: Pick<WhatsAppSession, "send">): GuardedSender {
  return {
    async send(target, content, options) {
      // Not `target.id` — there is no such member, and that is the point. A
      // forged brand, a raw string from untyped code, and a cast through
      // `unknown` all miss this map and all stop here, before `session.send`.
      const record = issued.get(target);
      if (!record) {
        throw new SendRefusedError(
          "target_not_resolved_through_the_guard",
          DEFAULT_ALLOWLIST_PATH,
          "this target was not produced by resolveAllowlistedTarget, so nothing has checked it",
        );
      }
      if (!sanctionedIds(record.path).has(record.id)) {
        throw new SendRefusedError(
          "target_not_allowlisted",
          record.path,
          "this target was sanctioned when it was resolved and is not sanctioned now",
        );
      }
      return session.send(record.id, content, options);
    },
  };
}
