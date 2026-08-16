import { expect, test } from "./_expect.ts";
import { DisconnectReason } from "baileys";
import {
  assertE164,
  classifyDisconnect,
  isRetryable,
  MediaDownloadError,
  PairingError,
} from "../src/index.ts";
import { classifyMediaDownload } from "../src/errors.ts";

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

test("a media download failure classifies by status so a caller can retry correctly", () => {
  // #205: 404-expired and 429-throttled reached callers as the same opaque
  // failure. They demand opposite responses, so `retryable` is the point.
  const of = (statusCode?: number) =>
    classifyMediaDownload(statusCode === undefined ? new Error("boom") : boom(statusCode));

  expect(of(404).reason).toBe("expired");
  expect(of(410).reason).toBe("expired");
  expect(of(404).retryable).toBe(false);

  expect(of(429).reason).toBe("throttled");
  expect(of(429).retryable).toBe(true);

  expect(of(503).reason).toBe("unavailable");
  expect(of(503).retryable).toBe(true);

  expect(of(403).reason).toBe("unknown");
  expect(of(403).statusCode).toBe(403);

  // No status at all — a transport failure, or bytes that would not decrypt.
  // Not retryable: retrying never fixes a bad key.
  expect(of(undefined).reason).toBe("unknown");
  expect(of(undefined).statusCode).toBe(undefined);
  expect(of(undefined).retryable).toBe(false);

  // Already ours: classifying twice must not relabel it.
  const once = classifyMediaDownload(boom(429));
  expect(classifyMediaDownload(once)).toBe(once);
});

test("a media download error never leaks the signed CDN url", () => {
  const url = "https://mmg.whatsapp.net/d/f/SIGNED-TOKEN.enc";
  const error = classifyMediaDownload({
    message: `Failed to fetch stream from ${url}`,
    output: { statusCode: 410, payload: { message: `Failed to fetch stream from ${url}` } },
    data: { url },
  });

  expect(error instanceof MediaDownloadError).toBe(true);
  expect(error.message).not.toContain(url);
  expect(JSON.stringify(error)).not.toContain("mmg.whatsapp.net");
  expect(error.statusCode).toBe(410);
});
