/**
 * `selfAddress` — the one place that decides what "the linked account" means.
 *
 * Every own-sent message's author comes from here (ADR-0001), so the device
 * suffix strip and the LID pairing are proved directly rather than assumed by
 * the conversion tests, which supply the address by hand.
 */
import { expect, test } from "./_expect.ts";
import { selfAddress } from "../packages/whatsappd/src/baileys/socket.ts";

type Sock = Parameters<typeof selfAddress>[0];

const sock = (user: Sock["user"]): Sock => ({ user });

test("the device suffix is stripped — participants are never named with one", () => {
  expect(selfAddress(sock({ id: "15551234567:12@s.whatsapp.net" } as Sock["user"]))).toEqual({
    id: "15551234567@s.whatsapp.net",
    mode: "pn",
  });
});

test("the LID form rides along as the equivalent native address", () => {
  const self = selfAddress(
    sock({ id: "15551234567:12@s.whatsapp.net", lid: "99887766:3@lid" } as Sock["user"]),
  );
  expect(self).toEqual({
    id: "15551234567@s.whatsapp.net",
    mode: "pn",
    alt: "99887766@lid",
  });
});

test("no equivalent form is invented when WhatsApp supplied none", () => {
  expect(selfAddress(sock({ id: "15551234567@s.whatsapp.net" } as Sock["user"])).alt).toBe(
    undefined,
  );
});

test("an account with no identity fails loudly instead of naming nobody", () => {
  // An empty or borrowed sender would be persisted as truth by the runtime, so
  // conversion must stop rather than emit a placeholder author.
  expect(() => selfAddress(sock(undefined))).toThrow(TypeError);
  expect(() => selfAddress(sock({ id: "" } as Sock["user"]))).toThrow(TypeError);
});
