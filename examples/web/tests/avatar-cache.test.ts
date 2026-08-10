import assert from "node:assert/strict";
import test from "node:test";
import { avatarSource, clearAvatarCache } from "../src/lib/avatar-cache.ts";

void test("avatar loads are de-duplicated and failures are negatively cached", async () => {
  clearAvatarCache();
  let successful = 0;
  const fetchSuccess = async (): Promise<Response> => {
    successful += 1;
    return new Response("picture", { headers: { "Content-Type": "image/jpeg" } });
  };
  const [first, second] = await Promise.all([
    avatarSource("success", fetchSuccess),
    avatarSource("success", fetchSuccess),
  ]);
  assert.equal(successful, 1);
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
