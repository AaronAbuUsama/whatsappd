import { expect, test } from "./_expect.ts";
import { createPacer } from "../src/pacer.ts";

test("runs tasks in FIFO order even when queued concurrently", async () => {
  const pacer = createPacer(0);
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => pacer.run(async () => void order.push(n))));
  expect(order).toEqual([1, 2, 3]);
});

test("returns each task's own resolved value", async () => {
  const pacer = createPacer(0);
  const [a, b] = await Promise.all([pacer.run(async () => "a"), pacer.run(async () => "b")]);
  expect(a).toBe("a");
  expect(b).toBe("b");
});

test("enforces the minimum gap between starts (virtual clock)", async () => {
  let nowMs = 0;
  const pacer = createPacer(100, () => nowMs);
  const starts: number[] = [];
  // First runs immediately (last = -Infinity). Each subsequent waits for the gap;
  // we advance the virtual clock past each delay so the real timers fire.
  const p1 = pacer.run(async () => void starts.push(nowMs));
  await p1;
  expect(starts).toEqual([0]); // ran without waiting

  nowMs = 50; // only 50ms elapsed → next must wait ~50ms more
  const p2 = pacer.run(async () => void starts.push(nowMs));
  // let the real setTimeout(50) resolve, then it stamps last = now (50)
  nowMs = 150;
  await p2;
  expect(starts[1]).toBe(150);
});

test("a rejecting task does not poison the queue", async () => {
  const pacer = createPacer(0);
  const boom = pacer.run(async () => {
    throw new Error("boom");
  });
  let caught = false;
  try {
    await boom;
  } catch {
    caught = true;
  }
  const after = await pacer.run(async () => "ok");
  expect(caught).toBe(true);
  expect(after).toBe("ok");
});

test("minGapMs <= 0 disables waiting", async () => {
  const calls: number[] = [];
  let nowMs = 0;
  const pacer = createPacer(0, () => nowMs);
  await pacer.run(async () => void calls.push(nowMs));
  await pacer.run(async () => void calls.push(nowMs));
  expect(calls).toEqual([0, 0]); // no clock advance needed
});
