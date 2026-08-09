/**
 * The default logger must not write message content, addresses, or credentials.
 *
 * @remarks
 * Every deliberate log call in this codebase already passes counts and flags
 * rather than the things they describe — `qrChars` instead of the QR, chat
 * totals instead of chats. Those were never the risk.
 *
 * The gap was the two sites that log `{ err }`. Those errors come from Baileys
 * or the socket, so their shape is not chosen here: a send failure can carry
 * the outbound payload, and an HTTP-ish failure can carry request headers. An
 * error carrying a message body, a phone number, and an auth token was
 * confirmed to serialize all three in full before this was added.
 *
 * The assertions are on the bytes the logger wrote, not on the config it was
 * given. A `redact` list can be present and still miss the path that matters,
 * and only the output distinguishes those two cases.
 */
import assert from "node:assert/strict";
import pino from "pino";
import { test } from "./_expect.ts";
import { REDACTED_PATHS } from "../src/session.ts";

const TEXT = "meet me at the safehouse";
const NUMBER = "15551230000";
const SECRET = "super-secret-token";

/** A logger configured exactly as `createSession` configures its default. */
const captured = (): { logger: pino.Logger; written: () => string } => {
  const chunks: string[] = [];
  const logger = pino({ level: "warn", redact: { paths: [...REDACTED_PATHS] } }, {
    write: (chunk: string) => chunks.push(chunk),
  } as pino.DestinationStream);
  return { logger, written: () => chunks.join("") };
};

test("an error carrying a payload does not put it in the log", () => {
  const { logger, written } = captured();

  // The shape a failed send plausibly arrives in: the library did not build
  // this object, which is exactly why it is dangerous to log.
  const error = Object.assign(new Error("send failed"), {
    data: { to: `${NUMBER}@s.whatsapp.net`, text: TEXT },
    config: { headers: { authorization: `Bearer ${SECRET}` } },
  });
  logger.error({ err: error }, "session run errored");

  const out = written();
  assert.ok(out.length > 0, "the logger wrote nothing — this test would otherwise pass vacuously");
  assert.ok(!out.includes(TEXT), `the message body reached the log: ${out}`);
  assert.ok(!out.includes(NUMBER), `the phone number reached the log: ${out}`);
  assert.ok(!out.includes(SECRET), `the auth token reached the log: ${out}`);

  // Redaction that also removes the diagnostic has just broken logging.
  assert.ok(out.includes("send failed"), "the error message was censored along with the secrets");
  assert.ok(out.includes("session run errored"), "the log line's own message was lost");
});

test("message fields are censored wherever they appear in a logged object", () => {
  const { logger, written } = captured();

  logger.warn(
    { outbound: { to: `${NUMBER}@s.whatsapp.net`, text: TEXT }, attempt: 2 },
    "retrying send",
  );

  const out = written();
  assert.ok(!out.includes(TEXT), `the message body reached the log: ${out}`);
  assert.ok(!out.includes(NUMBER), `the recipient reached the log: ${out}`);
  // Non-sensitive context is the reason to log at all, so it must survive.
  assert.ok(out.includes('"attempt":2'), `the surrounding context was lost: ${out}`);
});

test("credentials are censored", () => {
  const { logger, written } = captured();

  logger.warn({ creds: { noiseKey: SECRET }, token: SECRET, password: SECRET }, "auth refreshed");

  const out = written();
  assert.ok(!out.includes(SECRET), `a credential reached the log: ${out}`);
  assert.ok(out.includes("auth refreshed"), "the log line's own message was lost");
});
