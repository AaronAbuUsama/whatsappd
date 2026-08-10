import assert from "node:assert/strict";
import test from "node:test";
import { avatarSource, clearAvatarCache } from "../src/lib/avatar-cache.ts";

void test("avatar loads are de-duplicated and failures are negatively cached", async () => {
  clearAvatarCache();
  let successful = 0;
  let requested: string | undefined;
  const fetchSuccess = async (url: string): Promise<Response> => {
    successful += 1;
    requested = url;
    return new Response("picture", { headers: { "Content-Type": "image/jpeg" } });
  };
  const [first, second] = await Promise.all([
    avatarSource("https://consumer.test/avatar", fetchSuccess),
    avatarSource("https://consumer.test/avatar", fetchSuccess),
  ]);
  assert.equal(successful, 1);
  assert.equal(requested, "https://consumer.test/avatar");
  assert.equal(first, second);

  let failed = 0;
  const fetchFailure = async (): Promise<Response> => {
    failed += 1;
    return new Response(null, { status: 404 });
  };
  assert.equal(await avatarSource("missing", fetchFailure), undefined);
  assert.equal(await avatarSource("missing", fetchFailure), undefined);
  assert.equal(failed, 1);
});
