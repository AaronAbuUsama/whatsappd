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
