import { expect, test } from "./_expect.ts";
import { DisconnectReason } from "baileys";
import { assertE164, classifyDisconnect, isRetryable, PairingError } from "../src/index.ts";

const boom = (statusCode: number) => ({ output: { statusCode } });

test("515 restart_required is a retryable fault (reconnect after pairing)", () => {
  const f = classifyDisconnect(boom(DisconnectReason.restartRequired), false);
  expect(f.reason).toBe("restart_required");
  expect(f.retryable).toBe(true);
  expect(f.disposition).toBe("retryable");
});

test("440 connection_replaced is terminal → logged_out (don't reconnect — would be replaced again)", () => {
  const f = classifyDisconnect(boom(DisconnectReason.connectionReplaced), false);
  expect(f.reason).toBe("connection_replaced");
  expect(f.retryable).toBe(false);
  expect(f.disposition).toBe("logged_out");
});

test("411 multidevice_mismatch is terminal → suspended (re-pairing won't help)", () => {
  const f = classifyDisconnect(boom(DisconnectReason.multideviceMismatch), false);
  expect(f.reason).toBe("multidevice_mismatch");
  expect(f.disposition).toBe("suspended");
});

test("403 forbidden → suspended", () => {
  const f = classifyDisconnect(boom(DisconnectReason.forbidden), false);
  expect(f.reason).toBe("credentials_invalid");
  expect(f.disposition).toBe("suspended");
});

test("503 service_unavailable stays retryable", () => {
  const f = classifyDisconnect(boom(DisconnectReason.unavailableService), false);
  expect(f.reason).toBe("service_unavailable");
  expect(f.retryable).toBe(true);
  expect(f.disposition).toBe("retryable");
});

test("408 (overloaded) collapses to connection_lost, retryable", () => {
  const f = classifyDisconnect(boom(DisconnectReason.timedOut), false);
  expect(f.reason).toBe("connection_lost");
  expect(f.retryable).toBe(true);
});

test("401 logged out is terminal", () => {
  const f = classifyDisconnect(boom(DisconnectReason.loggedOut), false);
  expect(f.reason).toBe("logged_out_remote");
  expect(f.retryable).toBe(false);
});

test("our own teardown is intentional, never a fault (Rule 5)", () => {
  const f = classifyDisconnect(undefined, true);
  expect(f.reason).toBe("intentional");
  expect(f.retryable).toBe(false);
});

test("400 pairing rejection is terminal — no fix-by-retry", () => {
  expect(isRetryable("pairing_rejected")).toBe(false);
});

test("faults never leak raw upstream payloads (Lesson 2)", () => {
  const f = classifyDisconnect(
    { output: { statusCode: 401, payload: { message: "Logged Out" } } },
    false,
  );
  expect(JSON.stringify(f)).not.toContain("Logged Out");
});

test("E.164 is validated at the edge (Lesson 4)", () => {
  expect(assertE164("+15551234567")).toBe("+15551234567");
  expect(() => assertE164("15551234567")).toThrow(PairingError);
  expect(() => assertE164("+0123")).toThrow(PairingError);
});
