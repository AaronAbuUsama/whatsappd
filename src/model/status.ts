/**
 * The connection status: three nested state machines (connection, pairing, and
 * sync) composed into one {@link Status} value. Protocol-free types.
 *
 * @packageDocumentation
 */
import type { FaultReason } from "../errors.ts";

/** The pairing sub-state, present while `Status.phase` is `"pairing"`. */
export type PairingState =
  /** waiting for the first qr (ws open + handshake done); for pairing-code, also awaiting the code */
  | { step: "awaiting_ready" }
  /** the qr/code is live and shown to the human */
  | {
      step: "challenge_live";
      method: "qr" | "pairing_code";
      qr?: string;
      code?: string;
      expiresAt: number;
    }
  /** paired; awaiting the expected 515 restart before reconnecting with creds */
  | { step: "restart_pending" };

/** The sync sub-state — an open socket is not yet sendable until sync settles. */
export type SyncState =
  /** socket open; awaiting receivedPendingNotifications */
  | { step: "draining" }
  /** history sync in flight */
  | { step: "syncing"; progress?: number };

/** The connection lifecycle, with the pairing and sync sub-states nested in. */
export type Status =
  | { phase: "disconnected" }
  | { phase: "connecting"; retryAttempt?: number } // retryAttempt carried across backoff→reconnect
  | { phase: "pairing"; pairing: PairingState }
  | { phase: "authenticated"; sync: SyncState } // socket open, may not be sendable yet
  | { phase: "online" } // synced — safe to send
  | { phase: "backing_off"; reason: FaultReason; retryAttempt: number; nextRetryAt: number }
  | { phase: "logged_out"; reason: FaultReason } // terminal — creds dead, re-pair
  | { phase: "suspended"; reason: FaultReason }; // terminal — account/device problem

/** Stream element on `session.connection` — a Status emitted on transition. */
export type ConnectionEvent = Status;

/** True once a status is terminal (the `connection` stream ends here). */
export function isTerminal(status: Status): boolean {
  return status.phase === "logged_out" || status.phase === "suspended";
}

/** True once the device is genuinely sendable. */
export function isOnline(status: Status): boolean {
  return status.phase === "online";
}

/** The connected account's own identity, read from the live socket once open. */
export interface WaIdentity {
  /** the account's own jid (e.g. `15551234567:12@s.whatsapp.net`). */
  readonly jid: string;
  readonly pushName?: string;
  /** E.164, derived from the jid's number part when it is purely numeric. */
  readonly phoneE164?: string;
}
