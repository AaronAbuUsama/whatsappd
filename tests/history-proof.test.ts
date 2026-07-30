import { expect, test } from "./_expect.ts";
import { boundaryVerdict } from "./history-proof.ts";

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

import { deliveryAcksFor } from "./history-proof-receipt.ts";

test("delivery acks are extracted only for matching peer_msg receipt stanzas", () => {
  const log = `
    "tag": "receipt",
      "attrs": {
        "from": "<acct>@s.whatsapp.net",
        "type": "peer_msg",
        "id": "REQ-A",
        "t": "1785448017"
    "tag": "receipt",
      "attrs": {
        "type": "sender",
        "id": "REQ-A",
        "t": "1785448099"
    "tag": "receipt",
      "attrs": {
        "type": "peer_msg",
        "id": "REQ-B",
        "t": "1785449473"
  `;
  expect(deliveryAcksFor(log, "REQ-A")).toEqual(["2026-07-30T21:46:57.000Z"]);
  expect(deliveryAcksFor(log, "REQ-B")).toEqual(["2026-07-30T22:11:13.000Z"]);
  expect(deliveryAcksFor(log, "REQ-C")).toEqual([]);
});
