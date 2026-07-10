import { expect, test } from "./_expect.ts";
import { Channel } from "../src/stream.ts";

test("on: a registered handler receives each pushed value in order", () => {
  const ch = new Channel<number>();
  const seen: number[] = [];
  ch.on((v) => void seen.push(v));

  ch.push(1);
  ch.push(2);

  expect(seen).toEqual([1, 2]);
});

test("on: the returned unsubscribe stops further delivery", () => {
  const ch = new Channel<number>();
  const seen: number[] = [];
  const off = ch.on((v) => void seen.push(v));

  ch.push(1);
  off();
  ch.push(2);

  expect(seen).toEqual([1]);
});

test("on: multiple handlers each receive every value", () => {
  const ch = new Channel<number>();
  const a: number[] = [];
  const b: number[] = [];
  ch.on((v) => void a.push(v));
  ch.on((v) => void b.push(v));

  ch.push(7);

  expect(a).toEqual([7]);
  expect(b).toEqual([7]);
});

test("on: a throwing handler is isolated — others still run, error goes to the sink", () => {
  const errors: unknown[] = [];
  const ch = new Channel<number>((err) => errors.push(err));
  const seen: number[] = [];
  ch.on(() => {
    throw new Error("boom");
  });
  ch.on((v) => void seen.push(v));

  ch.push(1);

  expect(seen).toEqual([1]); // a bad handler never starves the others
  expect(errors.length).toBe(1);
});

test("on: an async handler rejection is routed to the error sink", async () => {
  const errors: unknown[] = [];
  const ch = new Channel<number>((err) => errors.push(err));
  ch.on(async () => {
    throw new Error("async boom");
  });

  ch.push(1);
  await new Promise((r) => setTimeout(r, 5));

  expect(errors.length).toBe(1);
});

test("for await: delivers values pushed while iterating, and ends on close", async () => {
  const ch = new Channel<number>();
  const got: number[] = [];
  const done = (async () => {
    for await (const v of ch) got.push(v);
  })();
  await new Promise((r) => setTimeout(r, 0)); // let the loop tap in

  ch.push(1);
  ch.push(2);
  ch.close();
  await done;

  expect(got).toEqual([1, 2]);
});

test("for await: the async side stays dormant until first iterated (no buffering for callback-only use)", async () => {
  const ch = new Channel<number>();
  ch.push(1); // nobody iterating and no callbacks — must be dropped, not retained

  const got: number[] = [];
  const done = (async () => {
    for await (const v of ch) got.push(v);
  })();
  await new Promise((r) => setTimeout(r, 0));

  ch.push(2);
  ch.close();
  await done;

  expect(got).toEqual([2]);
});
