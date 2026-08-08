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
import { test } from "./_expect.ts";
import { createDefaultLogger } from "../src/session.ts";

const TEXT = "meet me at the safehouse";
const NUMBER = "15551230000";
const SECRET = "super-secret-token";

/** The same logger factory used by `createSession`, captured byte-for-byte. */
const captured = (): { logger: ReturnType<typeof createDefaultLogger>; written: () => string } => {
  const chunks: string[] = [];
  const logger = createDefaultLogger({
    write: (chunk: string) => chunks.push(chunk),
  });
  return { logger, written: () => chunks.join("") };
};

const assertKnownValueAbsent = (out: string, value: string): void => {
  assert.ok(out.length > 0, "the logger wrote nothing — this test would otherwise pass vacuously");
  assert.equal(knownValueHits(out, [value]), 0, `a held value reached the log: ${out}`);
};

const knownValueHits = (out: string, values: readonly string[]): number =>
  values.filter((value) => out.includes(value)).length;

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

test("every message envelope subtree is censored without hiding Error diagnostics", () => {
  const { logger, written } = captured();
  const content = {
    documentFileName: "MyDivorcePapers.pdf",
    contactDisplayName: "Dr Sarah Klein",
    contactVcard: "BEGIN:VCARD FN:Jane",
    locationName: "Home - 42 Elm St",
    selectedDisplayText: "Private button answer",
    listTitle: "Private list choice",
    pollName: "Should I resign?",
    wrappedContent: "view-once ephemeral secret",
    futureContent: "future protocol secret",
  };
  const diagnostic = "connection reset by peer";
  const error = Object.assign(new Error(diagnostic), {
    node: { message: { futureUnknownMessage: { payload: content.futureContent } } },
  });

  logger.warn(
    {
      document: { message: { documentMessage: { fileName: content.documentFileName } } },
      contact: {
        message: {
          contactMessage: {
            displayName: content.contactDisplayName,
            vcard: content.contactVcard,
          },
        },
      },
      location: { message: { locationMessage: { name: content.locationName } } },
      buttons: {
        message: {
          buttonsResponseMessage: { selectedDisplayText: content.selectedDisplayText },
        },
      },
      list: { message: { listResponseMessage: { title: content.listTitle } } },
      poll: { message: { pollCreationMessage: { name: content.pollName } } },
      wrapped: {
        message: {
          viewOnceMessage: {
            message: {
              ephemeralMessage: {
                message: { futureUnknownMessage: { payload: content.wrappedContent } },
              },
            },
          },
        },
      },
      future: {
        message: { futureUnknownMessage: { payload: content.futureContent } },
      },
      err: error,
    },
    "decrypt failure",
  );

  const out = written();
  // A caption-only probe can pass through the separate `*.caption` path.
  // documentMessage.fileName and futureUnknownMessage.payload have no such
  // path, so their absence proves the structural message-envelope formatter.
  for (const value of Object.values(content)) assertKnownValueAbsent(out, value);
  assert.ok(out.includes(diagnostic), "the Error diagnostic was censored with message content");
  assert.ok(out.includes('"stack":"[Redacted]"'), "the Error stack was not censored");

  const planted = `${out}${JSON.stringify({ message: content.documentFileName })}`;
  assert.equal(
    knownValueHits(planted, [content.documentFileName]),
    1,
    "the known-value scanner missed deliberately planted content",
  );
});

test("credentials are censored", () => {
  const { logger, written } = captured();

  logger.warn({ creds: { noiseKey: SECRET }, token: SECRET, password: SECRET }, "auth refreshed");

  const out = written();
  assert.ok(!out.includes(SECRET), `a credential reached the log: ${out}`);
  assert.ok(out.includes("auth refreshed"), "the log line's own message was lost");
});

test("baileys decrypt-failure addresses are censored at their observed paths", () => {
  const { logger, written } = captured();
  const peerJid = "100000000000000@lid";
  const participantAlt = "15551230000@s.whatsapp.net";
  const groupId = "120363042384062365@g.us";

  logger.warn(
    {
      err: Object.assign(new Error("failed to decrypt message"), {
        data: {
          remoteJid: groupId,
          participant: peerJid,
          participantAlt,
        },
      }),
    },
    "session run errored",
  );

  const out = written();
  assert.ok(out.length > 0, "the logger wrote nothing — this test would otherwise pass vacuously");
  assert.ok(!out.includes(peerJid), `the participant reached the log: ${out}`);
  assert.ok(!out.includes(groupId), `the group id reached the log: ${out}`);
  assert.ok(!out.includes(NUMBER), `the alternate participant reached the log: ${out}`);
  assert.ok(out.includes("failed to decrypt message"), "the error diagnostic was lost");
});

test("baileys trace handshake and protocol fields are censored", () => {
  const { logger, written } = captured();
  const wireValue = "A".repeat(48);
  const peerJid = "100000000000000@lid";

  logger.warn(
    {
      helloMsg: { clientHello: { ephemeral: wireValue } },
      handshake: { serverHello: { ephemeral: wireValue, static: wireValue, payload: wireValue } },
      node: { username: NUMBER },
      xml: `<message from="${peerJid}">${wireValue}</message>`,
      pnUser: peerJid,
      lidUser: peerJid,
      fromJid: peerJid,
      myPN: peerJid,
      myLID: peerJid,
    },
    "baileys trace control",
  );

  const out = written();
  assert.ok(!out.includes(wireValue), `handshake material reached the log: ${out}`);
  assert.ok(!out.includes(peerJid), `an address reached the log: ${out}`);
  assert.ok(!out.includes(NUMBER), `a phone number reached the log: ${out}`);
  assert.ok(out.includes("baileys trace control"), "the log diagnostic was lost");
});

test("baileys protocol-node address fields observed on ios are censored", () => {
  const { logger, written } = captured();
  const peerJid = "100000000000000@lid";
  const stanzaId = "1234567890123456";

  logger.warn(
    {
      from: peerJid,
      attrs: { id: stanzaId },
      recv: { attrs: { from: peerJid, id: stanzaId, t: stanzaId } },
      sent: { id: stanzaId },
      messageIds: [stanzaId],
    },
    `baileys protocol node control for ${peerJid}`,
  );

  const out = written();
  assertKnownValueAbsent(out, peerJid);
  assertKnownValueAbsent(out, stanzaId);
  assert.ok(out.includes("[Redacted]"), "the sensitive log-line message was not censored");
});
