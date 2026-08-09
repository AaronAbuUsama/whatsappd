import { expect, test } from "../../tooling/checks/test-harness.ts";
import { boundaryVerdict } from "../runners/history-proof.ts";

test("boundary verdict classifies returned rows against the anchor", () => {
  const verdict = boundaryVerdict(1000, "anchor-hash", [
    { msgHash: "a", timestamp: 400 },
    { msgHash: "b", timestamp: 900 },
    { msgHash: "anchor-hash", timestamp: 1000 },
    { msgHash: "c", timestamp: 1500 },
  ]);
  expect(verdict).toEqual({
    returned: 4,
    olderThanAnchor: 2,
    atAnchorTimestamp: 1,
    newerThanAnchor: 1,
    anchorRedelivered: true,
    oldestReturned: 400,
    newestReturned: 1500,
  });
});

test("boundary verdict on an empty result claims nothing", () => {
  expect(boundaryVerdict(1000, "anchor-hash", [])).toEqual({
    returned: 0,
    olderThanAnchor: 0,
    atAnchorTimestamp: 0,
    newerThanAnchor: 0,
    anchorRedelivered: false,
    oldestReturned: null,
    newestReturned: null,
  });
});

import { deliveryAcksFor } from "../support/history-proof-receipt.ts";

const logLine = (recv: unknown): string => JSON.stringify({ level: 20, msg: "sent ack", recv });

test("delivery acks are extracted only for matching peer_msg receipt stanzas", () => {
  const log = [
    logLine({
      tag: "receipt",
      attrs: { from: "<acct>@s.whatsapp.net", type: "peer_msg", id: "REQ-A", t: "1785448017" },
    }),
    logLine({ tag: "receipt", attrs: { type: "sender", id: "REQ-A", t: "1785448099" } }),
    logLine({ tag: "receipt", attrs: { type: "peer_msg", id: "REQ-B", t: "1785449473" } }),
    "not json at all",
  ].join("\n");
  expect(deliveryAcksFor(log, "REQ-A")).toEqual(["2026-07-30T21:46:57.000Z"]);
  expect(deliveryAcksFor(log, "REQ-B")).toEqual(["2026-07-30T22:11:13.000Z"]);
  expect(deliveryAcksFor(log, "REQ-C")).toEqual([]);
});

test("an ack outside a stanza's own attrs is never credited to it", () => {
  // A sent-echo object carries the id without tag/attrs, and a free-text line
  // mentions another request — neither may be credited as a delivery ack.
  const log = [
    logLine({ tag: "receipt", attrs: { type: "peer_msg", id: "REQ-X", t: "1785448017" } }),
    JSON.stringify({ level: 20, sent: { id: "REQ-X", class: "receipt", type: "peer_msg" } }),
    JSON.stringify({ level: 20, msg: 'retry cache note "id": "REQ-Y" "type": "peer_msg"' }),
  ].join("\n");
  expect(deliveryAcksFor(log, "REQ-X")).toEqual(["2026-07-30T21:46:57.000Z"]);
  expect(deliveryAcksFor(log, "REQ-Y")).toEqual([]);
});

import { redact } from "../support/history-proof-receipt.ts";

test("redaction catches separated and long digit runs, keeps short ones", () => {
  expect(redact("call me at 555-123-4567 later")).toBe("call me at <redacted> later");
  expect(redact("+1 555 123 4567")).toBe("<redacted>");
  expect(redact("group 120363042384062365@g.us")).toBe("group <redacted>@g.us");
  expect(redact("counts 50, 25 on one anchor")).toBe("counts 50, 25 on one anchor");
});
