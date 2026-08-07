/**
 * The three ways a send is attempted without passing the guard, pinned as
 * compile-time fixtures.
 *
 * Each function below is written the way the mistake is actually made, and each
 * carries a `@ts-expect-error`. That directive is an assertion in both
 * directions: `pnpm check` is green only while the line beneath it really is a
 * type error, and it goes red the moment the guard stops rejecting it — because
 * an unused `@ts-expect-error` is itself an error.
 *
 * That is half the proof. The other half is that removing either directive must
 * make `pnpm check` go red, which is what `tests/send-guard-proof.ts` does in a
 * scratch copy of the tree. A guard nobody has watched fail is an assumption.
 * The `guard-fixture:` markers are how that script locates each directive.
 *
 * Each fixture also *returns* its call, so `tests/send-guard.test.ts` can await
 * the same expression and confirm the runtime refuses it too. Compilation is
 * the barrier that matters for code someone writes; the runtime check is what
 * catches a cast through `unknown` and anything arriving from untyped code.
 */
import type { MessageRef } from "../src/index.ts";
import {
  resolveAllowlistedTarget,
  type AllowlistedTarget,
  type GuardedClientSender,
  type GuardedSender,
} from "./send-guard.ts";

/**
 * A caller nominates a file that sanctions the destination it wants.
 *
 * @remarks
 * Production resolution has one authority, the owner-controlled default file.
 * Temporary authority files belong only to the explicit test seam.
 */
export function callerControlledAllowlistReachingResolver(
  chatId: string,
  allowlistPath: string,
): AllowlistedTarget {
  // guard-fixture:caller-allowlist
  // @ts-expect-error production callers cannot nominate their own allowlist authority.
  return resolveAllowlistedTarget(chatId, { allowlistPath });
}

/**
 * A chat id read straight out of a mirror, handed to the send site.
 *
 * @remarks
 * This is the cheap wrong path defect-ledger C10 describes: the mirror hands
 * back a `string`, and passing it on is less work than resolving it. It must
 * therefore be the path that does not compile.
 */
export async function rawChatIdReachingTheSendSite(
  sender: GuardedSender,
  chatIdFromAMirrorRead: string,
): Promise<MessageRef> {
  // guard-fixture:raw-string
  // @ts-expect-error a raw chat id string must not be sendable: only a target resolved through resolveAllowlistedTarget is.
  return sender.send(chatIdFromAMirrorRead, { text: "" });
}

/**
 * A hand-written object shaped like a checked target.
 *
 * @remarks
 * `AllowlistedTarget`'s only member is keyed by a `unique symbol` this module
 * cannot name, so no literal can satisfy it. Without that, "resolve it first"
 * would be advice rather than a rule, and a caller in a hurry would write the
 * object.
 */
export async function handForgedBrandReachingTheSendSite(
  sender: GuardedSender,
): Promise<MessageRef> {
  const forged = { brand: true };
  // guard-fixture:forged-brand
  // @ts-expect-error a hand-forged brand must not stand in for a target the allowlist has actually cleared.
  return sender.send(forged, { text: "" });
}

/** A raw mirror id handed to the durable Client send path. */
export function rawChatIdReachingTheClientSendSite(
  sender: GuardedClientSender,
  chatIdFromAMirrorRead: string,
) {
  // guard-fixture:client-raw-string
  // @ts-expect-error the real-profile Client harness must resolve an AllowlistedTarget before durable submission.
  return sender.text(chatIdFromAMirrorRead, "");
}

/** A hand-written object handed to the durable Client send path. */
export function handForgedBrandReachingTheClientSendSite(sender: GuardedClientSender) {
  const forged = { brand: true };
  // guard-fixture:client-forged-brand
  // @ts-expect-error a forged target must not reach the durable Client send path.
  return sender.text(forged, "");
}
