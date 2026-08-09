import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_SYNTHETIC_ACCOUNT_FIXTURES,
  scanAccountFixtureSource,
  scanAccountFixtureTree,
} from "../support/account-fixture-scan.ts";
import { test } from "../../tooling/checks/test-harness.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("known synthetic account fixtures stay visible as plain allowlisted literals", () => {
  assert.ok(
    KNOWN_SYNTHETIC_ACCOUNT_FIXTURES.has("123456789012@s.whatsapp.net"),
    "the receipt-scanner fixture must be explicit rather than hidden from source scans",
  );

  assert.deepEqual(scanAccountFixtureTree(path.join(root, "proofs")), {
    splitAccountLiterals: [],
    unallowlistedAccountLiterals: [],
  });
});

test("a concatenated or interpolated account-shaped literal is always a hard error", () => {
  const planted = [
    'const concatenated = "123456789012" + "@s.whatsapp.net";',
    'const interpolated = `123456789012${"@s.whatsapp.net"}`;',
  ].join("\n");
  const scan = scanAccountFixtureSource("proofs/tests/planted-split.ts", planted);

  assert.equal(scan.splitAccountLiterals.length, 2);
  assert.deepEqual(
    scan.splitAccountLiterals.map(({ value }) => value),
    ["123456789012@s.whatsapp.net", "123456789012@s.whatsapp.net"],
  );
  assert.deepEqual(scan.unallowlistedAccountLiterals, []);
});

test("an unknown plain account-shaped literal remains visible to the leak scan", () => {
  const unknownFixture = ["765432109876", "@s.whatsapp.net"].join("");
  const scan = scanAccountFixtureSource(
    "proofs/tests/planted-plain.ts",
    `const fixture = "${unknownFixture}";`,
  );

  assert.deepEqual(scan.splitAccountLiterals, []);
  assert.deepEqual(scan.unallowlistedAccountLiterals, [
    {
      path: "proofs/tests/planted-plain.ts",
      line: 1,
      column: 17,
      value: unknownFixture,
    },
  ]);
});
