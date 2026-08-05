import { expect, test } from "./_expect.ts";
import { classify, parseBlockers, type Node } from "./execution-state.ts";

const node = (number: number, over: Partial<Node> = {}): Node => ({
  number,
  title: `issue ${number}`,
  closed: false,
  labels: [],
  blockers: [],
  ...over,
});

test("a blocker bullet contributes its first reference and nothing after it", () => {
  // The real #107 body. Every trailing reference is commentary about a
  // blocker's history, and treating one as an edge invents a dependency.
  const blockers = parseBlockers(`# Parent

## Blocked by

- #106 — complete conversations. **Closed**: PR #125 merged 2026-08-04, so #105 is closed too.
- #127 — a real-account read-path smoke test.

## Plain-English outcome

Depends on #999 in prose.
`);
  expect(blockers).toEqual([106, 127]);
});

test("no Blocked by section means no declared blockers", () => {
  expect(parseBlockers("# Title\n\n## Blocks\n\n- #107\n")).toEqual([]);
});

test("the frontier is open with every declared blocker closed", () => {
  const all = [
    node(106, { closed: true }),
    node(107, { blockers: [106], labels: ["ready-for-agent"] }),
  ];
  expect(classify(all[1]!, all)).toEqual({ kind: "frontier", ready: true });
});

test("a frontier node without a ready label is reported unready", () => {
  const all = [
    node(106, { closed: true }),
    node(107, { blockers: [106], labels: ["needs-triage"] }),
  ];
  expect(classify(all[1]!, all)).toEqual({ kind: "frontier", ready: false });
});

test("one open blocker is enough to block", () => {
  const all = [node(106), node(127, { closed: true }), node(107, { blockers: [106, 127] })];
  expect(classify(all[2]!, all)).toEqual({ kind: "blocked", by: [106] });
});

test("a node that declares no blockers is on the graph when something depends on it", () => {
  // #127 declares no blockers and blocks #107. Without the reverse edge the
  // node the DAG is actually waiting on prints as an unrelated open issue.
  const all = [node(127, { labels: ["ready-for-agent"] }), node(107, { blockers: [127] })];
  expect(classify(all[0]!, all)).toEqual({ kind: "frontier", ready: true });
});

test("an issue nothing depends on and that waits for nothing is not on the graph", () => {
  const all = [node(121), node(107, { blockers: [127] })];
  expect(classify(all[0]!, all)).toEqual({ kind: "loose" });
});

test("deferred outranks every other standing", () => {
  const all = [node(83, { labels: ["deferred"], blockers: [113] }), node(113)];
  expect(classify(all[0]!, all)).toEqual({ kind: "deferred" });
});
