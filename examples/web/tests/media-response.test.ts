import assert from "node:assert/strict";
import test from "node:test";
import { mediaResponse } from "../src/lib/media-response.ts";

const bytes = Buffer.from("0123456789");
const target = () => ({
  source: (async function* () {
    yield bytes.subarray(0, 3);
    yield bytes.subarray(3, 8);
    yield bytes.subarray(8);
  })(),
  byteLength: bytes.byteLength,
  mimetype: "audio/ogg",
  fileName: "voice.ogg",
});

void test("media responses support bounded browser byte ranges", async () => {
  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ] as const) {
    const response = mediaResponse(
      new Request("http://local/media", { headers: { range } }),
      target(),
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.equal(response.headers.get("content-length"), String(expected.length));
    assert.equal(await response.text(), expected);
  }
});

void test("full and invalid media responses remain private and truthful", async () => {
  const full = mediaResponse(new Request("http://local/media"), target());
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("cache-control"), "private, no-store");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-length"), "10");
  assert.equal(await full.text(), "0123456789");

  const invalid = mediaResponse(
    new Request("http://local/media", { headers: { range: "bytes=20-30" } }),
    target(),
  );
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");

  const empty = mediaResponse(new Request("http://local/media"), {
    source: (async function* () {})(),
    byteLength: 0,
    mimetype: "application/octet-stream",
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal((await empty.arrayBuffer()).byteLength, 0);

  const emptyRange = mediaResponse(
    new Request("http://local/media", { headers: { range: "bytes=-3" } }),
    {
      source: (async function* () {})(),
      byteLength: 0,
      mimetype: "application/octet-stream",
    },
  );
  assert.equal(emptyRange.status, 416);
  assert.equal(emptyRange.headers.get("content-range"), "bytes */0");
});
