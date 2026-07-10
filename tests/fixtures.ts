/**
 * Proto fixtures for the inbound mapper — no phone.
 *
 * Two sources, mirroring how the protocol library tests itself:
 *  1. `baseMessage(key, message)` — hand-built plain objects in the same idiom
 *     the library's own tests use.
 *  2. `realMessage(content)` — a high-fidelity round-trip through the library's
 *     own `generateWAMessage`, so assertions run against the proto the library
 *     actually produces, not a hand-guess. (Media needs a network upload, so
 *     media stays hand-built — see inbound.test.ts.)
 */
import { generateWAMessage, type AnyMessageContent, type WAMessage } from "baileys";

const CHAT = "1234567890@s.whatsapp.net";

/** Build a minimal base message in the protocol library's own test idiom. */
export function baseMessage(
  key: Partial<WAMessage["key"]>,
  message?: WAMessage["message"],
): WAMessage {
  return {
    key: { remoteJid: CHAT, fromMe: false, id: "ABC", ...key },
    message: message ?? { conversation: "hello" },
    messageTimestamp: 1675888000,
  };
}

/** Turn intended content into a REAL WAMessage via Baileys' own generator. */
export async function realMessage(
  content: AnyMessageContent,
  jid: string = CHAT,
): Promise<WAMessage> {
  return generateWAMessage(jid, content, {
    userJid: "me@s.whatsapp.net",
    messageId: "RT1",
    // text/location/contacts don't upload; throw if a fixture accidentally needs it.
    upload: () => {
      throw new Error("fixture should not upload media — use a hand-built proto");
    },
  });
}
