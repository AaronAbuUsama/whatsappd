/**
 * The connection, pairing, and sync state machines as one pure reducer:
 *
 *     transition(state, input, ctx, now) -> Status
 *
 * No I/O and no clock of its own (`now` is passed in), so the entire
 * decision-making core is unit-testable with scripted input sequences and no
 * live connection. The session orchestrator produces `Input`s from the live
 * socket and arms the timers; this file makes every state decision.
 */
import type { FaultReason, WhatsAppFault } from "./errors.ts";
import { dispositionFor } from "./errors.ts";
import type { Status } from "./model/index.ts";

/**
 * The input alphabet: observable connection signals already translated into
 * clean semantic events. The session orchestrator owns the messy mapping (e.g.
 * "first QR = ready", "refresh-or-timer = pairing_rejected").
 */
export type Input =
  | { t: "start" }
  /** First QR after the socket opens and handshakes; carries the QR to display. */
  | { t: "ready"; qr: string; expiresAt: number }
  /** subsequent qr refresh (qr-method display update). */
  | { t: "qr_refresh"; qr: string; expiresAt: number }
  /** pairing-code obtained from requestPairingCode and surfaced. */
  | { t: "code_ready"; code: string; expiresAt: number }
  /** isNewLogin:true — WhatsApp confirmed the pairing. */
  | { t: "paired" }
  /** connection:'open' — socket authenticated. */
  | { t: "open" }
  /** receivedPendingNotifications:true — offline backlog drained. */
  | { t: "pending_drained" }
  /** messaging-history.set progress — status only, not persistence proof. */
  | { t: "sync_progress"; progress: number }
  /** history complete OR sync-skip (returning device) — truly online. */
  | { t: "synced" }
  /** connection:'close' with a classified fault. */
  | { t: "close"; fault: WhatsAppFault }
  /** backoff timer elapsed. */
  | { t: "retry_due" }
  /** Verdict window elapsed without a `paired` signal — a silent rejection. */
  | { t: "pairing_rejected" }
  /** our own teardown — never a fault. */
  | { t: "stop" };

export interface MachineCtx {
  readonly method: "qr" | "pairing_code";
  readonly reconnectBaseMs?: number; // default 1_000
  readonly reconnectMaxMs?: number; // default 30_000
}

export const initialState: Status = { phase: "disconnected" };

/** Exponential backoff with cap. Pure: caller supplies `now`. */
export function backoffDelay(attempt: number, ctx: MachineCtx): number {
  const base = ctx.reconnectBaseMs ?? 1_000;
  const max = ctx.reconnectMaxMs ?? 30_000;
  return Math.min(max, base * 2 ** attempt);
}

/** Route a terminal/retry close into the next state. */
function onClose(
  state: Status,
  fault: WhatsAppFault,
  ctx: MachineCtx,
  now: number,
  attempt: number,
): Status {
  // Rule 5: our own teardown is never a fault.
  if (fault.reason === "intentional") return { phase: "disconnected" };

  switch (dispositionFor(fault.reason)) {
    case "logged_out":
      return { phase: "logged_out", reason: fault.reason };
    case "suspended":
      return { phase: "suspended", reason: fault.reason };
    case "retryable":
      return enterBackoff(fault.reason, ctx, now, attempt);
  }
}

function enterBackoff(reason: FaultReason, ctx: MachineCtx, now: number, attempt: number): Status {
  return {
    phase: "backing_off",
    reason,
    retryAttempt: attempt,
    nextRetryAt: now + backoffDelay(attempt, ctx),
  };
}

/**
 * The reducer. Unhandled (state, input) pairs are no-ops — the machine simply
 * stays put, so out-of-order or duplicate inputs can never push it into an
 * invalid state.
 */
export function transition(state: Status, input: Input, ctx: MachineCtx, now: number): Status {
  // `stop` is universal: intentional teardown from any non-terminal state.
  if (input.t === "stop") {
    return state.phase === "logged_out" || state.phase === "suspended"
      ? state
      : { phase: "disconnected" };
  }

  // `close` is near-universal: any live phase can drop. Terminal phases ignore it.
  if (input.t === "close") {
    if (state.phase === "logged_out" || state.phase === "suspended") return state;
    // 515 (and any retryable close) right after pairing is the *expected* restart:
    // reconnect immediately with the freshly-registered creds, attempt counter reset.
    if (state.phase === "pairing" && state.pairing.step === "restart_pending") {
      return dispositionFor(input.fault.reason) === "retryable"
        ? { phase: "connecting", retryAttempt: 0 }
        : onClose(state, input.fault, ctx, now, 0);
    }
    const attempt = state.phase === "connecting" ? (state.retryAttempt ?? 0) : 0;
    return onClose(state, input.fault, ctx, now, attempt);
  }

  switch (state.phase) {
    case "disconnected":
      if (input.t === "start") return { phase: "connecting", retryAttempt: 0 };
      return state;

    case "connecting": {
      // Returning device (has creds): straight to open, no pairing.
      if (input.t === "open") return { phase: "authenticated", sync: { step: "draining" } };
      // Pairing-code mode does not wait for QR refs. Baileys expects
      // requestPairingCode() immediately after socket creation.
      if (input.t === "code_ready" && ctx.method === "pairing_code") {
        return {
          phase: "pairing",
          pairing: {
            step: "challenge_live",
            method: "pairing_code",
            code: input.code,
            expiresAt: input.expiresAt,
          },
        };
      }
      // Fresh login: first qr = ws ready.
      if (input.t === "ready") {
        return ctx.method === "qr"
          ? {
              phase: "pairing",
              pairing: {
                step: "challenge_live",
                method: "qr",
                qr: input.qr,
                expiresAt: input.expiresAt,
              },
            }
          : { phase: "pairing", pairing: { step: "awaiting_ready" } };
      }
      return state;
    }

    case "pairing": {
      const p = state.pairing;
      if (input.t === "paired") return { phase: "pairing", pairing: { step: "restart_pending" } };

      if (p.step === "awaiting_ready") {
        // pairing-code: the code has been requested and obtained.
        if (input.t === "code_ready") {
          return {
            phase: "pairing",
            pairing: {
              step: "challenge_live",
              method: "pairing_code",
              code: input.code,
              expiresAt: input.expiresAt,
            },
          };
        }
        return state;
      }

      if (p.step === "challenge_live") {
        // The silent 400: verdict window elapsed without a `paired`.
        if (input.t === "pairing_rejected")
          return { phase: "logged_out", reason: "pairing_rejected" };
        // qr-method display refresh.
        if (input.t === "qr_refresh" && p.method === "qr") {
          return { phase: "pairing", pairing: { ...p, qr: input.qr, expiresAt: input.expiresAt } };
        }
        return state;
      }

      // restart_pending: only `close` (handled above) and `open` are meaningful.
      if (input.t === "open") return { phase: "authenticated", sync: { step: "draining" } };
      return state;
    }

    case "authenticated": {
      const s = state.sync;
      // Sync gate: an authenticated ("open") socket is not yet "online".
      if (input.t === "synced") return { phase: "online" };
      if (s.step === "draining" && input.t === "pending_drained") {
        return { phase: "authenticated", sync: { step: "syncing" } };
      }
      if (input.t === "sync_progress") {
        if (s.step === "syncing" && s.progress === input.progress) return state;
        return { phase: "authenticated", sync: { step: "syncing", progress: input.progress } };
      }
      return state;
    }

    case "online":
      return state; // only `close`/`stop` (handled above) move us out

    case "backing_off":
      if (input.t === "retry_due") {
        return { phase: "connecting", retryAttempt: state.retryAttempt + 1 };
      }
      return state;

    case "logged_out":
    case "suspended":
      return state; // terminal
  }
}
