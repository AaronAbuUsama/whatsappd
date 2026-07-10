import { DisconnectReason } from "baileys";

/**
 * Closed union of domain reasons a WhatsApp connection can fault on, mapped
 * from the transport's status codes rather than any raw error payload.
 */
export type FaultReason =
  // ── retryable: the lifecycle loop reconnects automatically ──
  | "restart_required" // 515 — expected post-pairing restart
  | "connection_lost" // 428/408 — ws closed / keep-alive death
  | "timed_out" // 408 — QR-refs / query timeout (see note below)
  | "service_unavailable" // 503 — server says try later (retryable, longer backoff)
  // ── terminal → logged_out: creds are dead, wipe + re-pair ──
  | "logged_out_remote" // 401 — unauthorized / remote logout
  | "connection_replaced" // 440 — another device took over (retrying = replaced again)
  // ── terminal → suspended: account/device problem, re-pairing won't help ──
  | "credentials_invalid" // 403 — banned / forbidden / deprecated client
  | "multidevice_mismatch" // 411 — not in multi-device
  | "bad_session" // 500 — unrecognized stream error
  // ── pairing ──
  | "pairing_rejected" // 400 server rejection — terminal, re-pair
  // ── never a fault ──
  | "intentional" // our own teardown
  | "unknown";

// NOTE: status 408 is overloaded (a keep-alive connection loss vs. a QR-refs
// timeout), distinguished only by the error message text. Both collapse to
// connection_lost for now; message-text disambiguation is future work.

/**
 * Which terminal sink a fault lands in — the single source of truth.
 *   "retryable"  → the spine reconnects automatically.
 *   "logged_out" → creds are dead; wipe the SessionStore and re-pair.
 *   "suspended"  → account/device problem; re-pairing won't help.
 */
export type Disposition = "retryable" | "logged_out" | "suspended";

const DISPOSITION: Record<FaultReason, Disposition> = {
  restart_required: "retryable",
  connection_lost: "retryable",
  timed_out: "retryable",
  service_unavailable: "retryable",
  unknown: "retryable", // residual transport error — safe to retry with backoff
  logged_out_remote: "logged_out",
  connection_replaced: "logged_out",
  pairing_rejected: "logged_out", // re-pair is the recovery; no creds to wipe yet
  credentials_invalid: "suspended",
  multidevice_mismatch: "suspended",
  bad_session: "suspended",
  intentional: "retryable", // never a fault; value is moot (see classifyDisconnect)
};

/** Which sink this reason lands in. */
export function dispositionFor(reason: FaultReason): Disposition {
  return DISPOSITION[reason];
}

export interface WhatsAppFault {
  readonly reason: FaultReason;
  readonly statusCode?: number;
  /** Whether reconnecting with the same creds could plausibly help. */
  readonly retryable: boolean;
  /** Which terminal sink (or retry) this fault lands in. */
  readonly disposition: Disposition;
}

/** Reconnect only what is genuinely retryable. No fix-by-retry. */
export function isRetryable(reason: FaultReason): boolean {
  if (reason === "intentional") return false;
  return dispositionFor(reason) === "retryable";
}

/**
 * Classify a disconnect into a sanitized domain {@link WhatsAppFault}.
 *
 * @param error - The transport error that closed the connection, or a falsy
 * value for an intentional teardown. The raw payload is never surfaced on the
 * result — only its mapped status code.
 * @param intentional - `true` when the caller closed the connection on purpose;
 * such a close is never treated as a fault.
 * @returns The classified fault, including its {@link Disposition}.
 */
export function classifyDisconnect(error: unknown, intentional: boolean): WhatsAppFault {
  if (intentional) {
    // Never a fault; disposition/retryable are not consumed for this reason.
    return { reason: "intentional", retryable: false, disposition: "retryable" };
  }

  const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;

  const reason = reasonFromStatus(statusCode);
  return {
    reason,
    statusCode,
    retryable: isRetryable(reason),
    disposition: dispositionFor(reason),
  };
}

function reasonFromStatus(statusCode?: number): FaultReason {
  switch (statusCode) {
    case DisconnectReason.restartRequired:
      return "restart_required";
    case DisconnectReason.connectionClosed:
    case DisconnectReason.timedOut: // 408 (also DisconnectReason.connectionLost)
      return "connection_lost";
    case DisconnectReason.unavailableService:
      return "service_unavailable";
    case DisconnectReason.loggedOut:
      return "logged_out_remote";
    case DisconnectReason.connectionReplaced:
      return "connection_replaced";
    case DisconnectReason.forbidden:
      return "credentials_invalid";
    case DisconnectReason.multideviceMismatch:
      return "multidevice_mismatch";
    case DisconnectReason.badSession:
      return "bad_session";
    default:
      return "unknown";
  }
}

/** Why a pairing attempt failed. */
export type PairingErrorReason =
  | "connection_closed_before_ready"
  | "pairing_readiness_timeout"
  | "pairing_rejected"
  | "invalid_phone";

/**
 * A tagged error for the pairing flow. Carries only safe metadata (the reason
 * and an optional status code); the underlying error is logged, never attached.
 */
export class PairingError extends Error {
  // fallow-ignore-next-line unused-class-member
  readonly _tag = "PairingError";
  readonly reason: PairingErrorReason;
  readonly statusCode?: number;
  constructor(reason: PairingErrorReason, statusCode?: number) {
    super(`PairingError(${reason}${statusCode ? `, ${statusCode}` : ""})`);
    this.name = "PairingError";
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/** Validate E.164 at the edge so bad input fails loudly before reaching Baileys. */
export function assertE164(input: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(input)) throw new PairingError("invalid_phone");
  return input;
}
