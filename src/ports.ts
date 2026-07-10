/**
 * The two pluggable seams — where credentials live and how login happens. Both
 * are deliberately free of any WhatsApp-protocol types, so a custom store or a
 * host adapter needs no knowledge of the underlying socket library.
 *
 * @packageDocumentation
 */
import { assertE164 } from "./errors.ts";

/**
 * An opaque key/value store for a session's credentials.
 *
 * @remarks
 * The library serializes authentication state into plain strings (the root
 * `creds` entry plus per-signal-key entries) and reads them back. The store
 * only persists strings — it never interprets them, so values may be encrypted
 * at rest without changing this contract.
 *
 * Keys look like `"creds"`, `"pre-key:42"`, `"session:123_1.0"`, or
 * `"sender-key:…"`; a value is a serialized string, or `null` to delete the
 * entry.
 *
 * @see {@link memoryStore}, {@link fileStore}, and `libsqlStore` for the
 * built-in implementations.
 */
export interface SessionStore {
  /** Read one entry, resolving to `null` when the key is absent. */
  read(key: string): Promise<string | null>;
  /**
   * Apply a batch of writes. Each value is a string to set, or `null` to
   * delete that key.
   */
  write(entries: Record<string, string | null>): Promise<void>;
  /**
   * Erase every entry for this session. Called automatically on a terminal
   * logout so dead credentials are never reused.
   */
  clear(): Promise<void>;
}

/**
 * How a session authenticates: scan a QR code, or enter a pairing code on a
 * known phone number.
 *
 * @see {@link qrAuth}, {@link pairingAuth}
 */
export type AuthStrategy = { method: "qr" } | { method: "pairing_code"; phone: string };

/**
 * Log in by scanning a QR code shown to the user.
 *
 * @returns A QR {@link AuthStrategy}.
 */
export function qrAuth(): AuthStrategy {
  return { method: "qr" };
}

/**
 * Log in with a pairing code delivered to a known phone number.
 *
 * @param phone - The phone number in E.164 format (e.g. `+15551234567`).
 * @returns A pairing-code {@link AuthStrategy}.
 * @throws {@link PairingError} with reason `"invalid_phone"` when `phone` is
 * not valid E.164 — validated here so bad input fails before any network call.
 */
export function pairingAuth(phone: string): AuthStrategy {
  return { method: "pairing_code", phone: assertE164(phone) };
}
