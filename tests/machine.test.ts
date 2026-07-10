import { expect, test } from "./_expect.ts";
import {
  backoffDelay,
  initialState,
  transition,
  type Input,
  type MachineCtx,
} from "../src/machine.ts";
import type { Status } from "../src/model/index.ts";
import type { WhatsAppFault } from "../src/errors.ts";

const QR: MachineCtx = { method: "qr" };
const CODE: MachineCtx = { method: "pairing_code" };

const fault = (reason: WhatsAppFault["reason"]): WhatsAppFault => ({
  reason,
  retryable: false, // not consumed by the machine; disposition is derived from reason
  disposition: "retryable",
});

/** Drive a sequence of inputs from a start state; returns the final Status. */
function run(start: Status, ctx: MachineCtx, inputs: Input[], now = 0): Status {
  return inputs.reduce((s, i) => transition(s, i, ctx, now), start);
}

test("pairing-code happy path: connecting → code → paired → 515 reconnect → open → synced → online", () => {
  const end = run(initialState, CODE, [
    { t: "start" },
    { t: "code_ready", code: "ABCD-1234", expiresAt: 30_000 },
    { t: "paired" }, // isNewLogin
    { t: "close", fault: fault("restart_required") }, // the expected 515
    { t: "open" }, // reconnect succeeds
    { t: "pending_drained" },
    { t: "synced" },
  ]);
  expect(end).toEqual({ phase: "online" });
});

test("after code_ready the challenge is live with the code", () => {
  const s = run(initialState, CODE, [
    { t: "start" },
    { t: "code_ready", code: "ABCD-1234", expiresAt: 30_000 },
  ]);
  expect(s).toEqual({
    phase: "pairing",
    pairing: {
      step: "challenge_live",
      method: "pairing_code",
      code: "ABCD-1234",
      expiresAt: 30_000,
    },
  });
});

test("qr path: first qr puts the qr challenge live immediately", () => {
  const s = run(initialState, QR, [{ t: "start" }, { t: "ready", qr: "qr1", expiresAt: 60_000 }]);
  expect(s).toEqual({
    phase: "pairing",
    pairing: { step: "challenge_live", method: "qr", qr: "qr1", expiresAt: 60_000 },
  });
});

test("qr refresh updates the displayed qr (does not reject)", () => {
  const s = run(initialState, QR, [
    { t: "start" },
    { t: "ready", qr: "qr1", expiresAt: 60_000 },
    { t: "qr_refresh", qr: "qr2", expiresAt: 20_000 },
  ]);
  expect(s).toEqual({
    phase: "pairing",
    pairing: { step: "challenge_live", method: "qr", qr: "qr2", expiresAt: 20_000 },
  });
});

test("THE SILENT 400: verdict window elapses without `paired` → logged_out(pairing_rejected)", () => {
  const s = run(initialState, CODE, [
    { t: "start" },
    { t: "code_ready", code: "ABCD-1234", expiresAt: 30_000 },
    { t: "pairing_rejected" }, // refresh-or-timer fired, no isNewLogin ever arrived
  ]);
  expect(s).toEqual({ phase: "logged_out", reason: "pairing_rejected" });
});

test("returning device: connecting → open with no pairing at all", () => {
  const s = run(initialState, CODE, [{ t: "start" }, { t: "open" }]);
  expect(s).toEqual({ phase: "authenticated", sync: { step: "draining" } });
});

test("sync gate: open is NOT online; only `synced` advances", () => {
  const open = run(initialState, QR, [{ t: "start" }, { t: "open" }]);
  expect(open.phase).toBe("authenticated");

  const draining = transition(open, { t: "pending_drained" }, QR, 0);
  expect(draining).toEqual({ phase: "authenticated", sync: { step: "syncing" } });

  const online = transition(draining, { t: "synced" }, QR, 0);
  expect(online).toEqual({ phase: "online" });
});

test("history sync progress updates connection status without marking online", () => {
  const open = run(initialState, QR, [{ t: "start" }, { t: "open" }]);

  const progress = transition(open, { t: "sync_progress", progress: 50 }, QR, 0);
  expect(progress).toEqual({ phase: "authenticated", sync: { step: "syncing", progress: 50 } });

  const later = transition(progress, { t: "sync_progress", progress: 75 }, QR, 0);
  expect(later).toEqual({ phase: "authenticated", sync: { step: "syncing", progress: 75 } });

  expect(transition(later, { t: "synced" }, QR, 0)).toEqual({ phase: "online" });
});

test("sync skip (returning device): synced straight from draining → online", () => {
  const open = run(initialState, QR, [{ t: "start" }, { t: "open" }]);
  expect(transition(open, { t: "synced" }, QR, 0)).toEqual({ phase: "online" });
});

test("terminal split: 401/440 → logged_out; 403/411/500 → suspended", () => {
  const online: Status = { phase: "online" };
  expect(transition(online, { t: "close", fault: fault("logged_out_remote") }, QR, 0)).toEqual({
    phase: "logged_out",
    reason: "logged_out_remote",
  });
  expect(transition(online, { t: "close", fault: fault("connection_replaced") }, QR, 0)).toEqual({
    phase: "logged_out",
    reason: "connection_replaced",
  });
  expect(transition(online, { t: "close", fault: fault("credentials_invalid") }, QR, 0)).toEqual({
    phase: "suspended",
    reason: "credentials_invalid",
  });
  expect(transition(online, { t: "close", fault: fault("bad_session") }, QR, 0)).toEqual({
    phase: "suspended",
    reason: "bad_session",
  });
});

test("retryable close from online → backing_off with scheduled retry", () => {
  const online: Status = { phase: "online" };
  const s = transition(online, { t: "close", fault: fault("connection_lost") }, QR, 1_000);
  expect(s).toEqual({
    phase: "backing_off",
    reason: "connection_lost",
    retryAttempt: 0,
    nextRetryAt: 2_000,
  });
});

test("backoff escalates across repeated drops (attempt counter survives reconnect)", () => {
  const ctx = QR;
  let s: Status = { phase: "online" };
  // first drop
  s = transition(s, { t: "close", fault: fault("connection_lost") }, ctx, 0);
  expect(s).toMatchObject({ phase: "backing_off", retryAttempt: 0, nextRetryAt: 1_000 });
  // retry, then drop again before reaching open
  s = transition(s, { t: "retry_due" }, ctx, 0);
  expect(s).toMatchObject({ phase: "connecting", retryAttempt: 1 });
  s = transition(s, { t: "close", fault: fault("connection_lost") }, ctx, 0);
  expect(s).toMatchObject({ phase: "backing_off", retryAttempt: 1, nextRetryAt: 2_000 });
  s = transition(s, { t: "retry_due" }, ctx, 0);
  s = transition(s, { t: "close", fault: fault("connection_lost") }, ctx, 0);
  expect(s).toMatchObject({ phase: "backing_off", retryAttempt: 2, nextRetryAt: 4_000 });
});

test("backoff is capped", () => {
  expect(backoffDelay(20, { method: "qr", reconnectBaseMs: 1_000, reconnectMaxMs: 30_000 })).toBe(
    30_000,
  );
});

test("intentional stop from any live phase → disconnected, never a fault", () => {
  const online: Status = { phase: "online" };
  expect(transition(online, { t: "stop" }, QR, 0)).toEqual({ phase: "disconnected" });
  const pairing: Status = { phase: "pairing", pairing: { step: "awaiting_ready" } };
  expect(transition(pairing, { t: "stop" }, QR, 0)).toEqual({ phase: "disconnected" });
});

test("terminal states are sticky: nothing moves out of logged_out/suspended", () => {
  const out: Status = { phase: "logged_out", reason: "logged_out_remote" };
  expect(transition(out, { t: "start" }, QR, 0)).toBe(out);
  expect(transition(out, { t: "open" }, QR, 0)).toBe(out);
  expect(transition(out, { t: "stop" }, QR, 0)).toBe(out);
  expect(transition(out, { t: "close", fault: fault("connection_lost") }, QR, 0)).toBe(out);
});

test("out-of-order inputs are no-ops (cannot reach an invalid state)", () => {
  // `paired` before we've even started is ignored.
  expect(transition(initialState, { t: "paired" }, QR, 0)).toBe(initialState);
  // `synced` while connecting is ignored.
  const connecting: Status = { phase: "connecting", retryAttempt: 0 };
  expect(transition(connecting, { t: "synced" }, QR, 0)).toBe(connecting);
});
