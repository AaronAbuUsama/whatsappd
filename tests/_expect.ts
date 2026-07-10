/**
 * Minimal jest/vitest-style `expect` over Node's built-in test runner.
 *
 * The project's `vp test` runner is broken (vite-plus 0.2.1 expects a `vitest`
 * bin that vite-plus-test 0.1.24 doesn't ship). This shim lets the suites run on
 * `node --experimental-strip-types --test` with zero extra deps. Swap the import
 * back to "vite-plus/test" once the toolchain is fixed — the API is compatible.
 */
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";

/**
 * Wrapper that returns `void` instead of `Promise<void>` — Node's test runner
 * tracks tests via registration, not the returned promise, so voiding the return
 * is safe and silences `no-floating-promises` across all test files at once.
 */
export function test(name: string, fn: () => void | Promise<void>): void {
  void nodeTest(name, fn);
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function matchesSubset(actual: unknown, subset: unknown): boolean {
  if (subset === null || typeof subset !== "object") return Object.is(actual, subset);
  if (actual === null || typeof actual !== "object") return false;
  for (const k of Object.keys(subset as object)) {
    const sv = (subset as Record<string, unknown>)[k];
    const av = (actual as Record<string, unknown>)[k];
    if (sv !== null && typeof sv === "object") {
      if (!matchesSubset(av, sv)) return false;
    } else if (!Object.is(av, sv)) return false;
  }
  return true;
}

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(subset: unknown): void;
  toContain(needle: string): void;
  toThrow(expected?: unknown): void;
}

export function expect(actual: unknown): Matchers & { not: Matchers } {
  const make = (negate: boolean): Matchers => ({
    toBe(expected) {
      const ok = Object.is(actual, expected);
      assert.ok(
        negate ? !ok : ok,
        `expected ${JSON.stringify(actual)} ${negate ? "NOT " : ""}toBe ${JSON.stringify(expected)}`,
      );
    },
    toEqual(expected) {
      const ok = deepEqual(actual, expected);
      assert.ok(
        negate ? !ok : ok,
        `expected ${JSON.stringify(actual)} ${negate ? "NOT " : ""}toEqual ${JSON.stringify(expected)}`,
      );
    },
    toMatchObject(subset) {
      const ok = matchesSubset(actual, subset);
      assert.ok(
        negate ? !ok : ok,
        `expected ${JSON.stringify(actual)} ${negate ? "NOT " : ""}toMatchObject ${JSON.stringify(subset)}`,
      );
    },
    toContain(needle) {
      const ok = typeof actual === "string" && actual.includes(needle);
      assert.ok(
        negate ? !ok : ok,
        `expected ${JSON.stringify(actual)} ${negate ? "NOT " : ""}toContain ${JSON.stringify(needle)}`,
      );
    },
    toThrow(expected) {
      assert.ok(typeof actual === "function", "toThrow expects a function");
      let thrown: unknown;
      try {
        (actual as () => unknown)();
      } catch (e) {
        thrown = e ?? new Error("thrown");
      }
      const didThrow = thrown !== undefined;
      if (negate) {
        assert.ok(!didThrow, "expected function NOT to throw");
        return;
      }
      assert.ok(didThrow, "expected function to throw");
      if (typeof expected === "function") {
        assert.ok(
          thrown instanceof (expected as new (...a: never[]) => unknown),
          `expected throw to be instanceof ${(expected as { name?: string }).name}`,
        );
      }
    },
  });
  return Object.assign(make(false), { not: make(true) });
}
