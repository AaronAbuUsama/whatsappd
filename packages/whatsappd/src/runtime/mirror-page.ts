/**
 * The one page request check every {@link WhatsAppDataStore} applies.
 *
 * @remarks
 * Shared rather than repeated per backend: what counts as a legal page request
 * is a property of the contract, not of the engine answering it, and two
 * copies of it would drift into two different answers for the same call.
 *
 * @packageDocumentation
 */
import type { StoredMessagePageOptions } from "./contracts.ts";

/**
 * Check a page request and answer the page size it asks for.
 *
 * @throws {@link RangeError} when `limit` is not a positive integer, or when
 * `before` is not a whole-millisecond position naming a message.
 */
export function validatePage(options: StoredMessagePageOptions | undefined): number {
  const limit = options?.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  const before = options?.before;
  if (
    before &&
    (!Number.isFinite(before.timestamp) ||
      !Number.isSafeInteger(before.timestamp) ||
      !before.messageId)
  )
    throw new RangeError("before must contain an integer timestamp and messageId");
  return limit;
}
