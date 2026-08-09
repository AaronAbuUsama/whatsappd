import assert from "node:assert/strict";
import test from "node:test";
import { createWhatsAppClient, createWhatsAppRuntime, memoryBackend } from "../src/index.ts";
import { createTestWhatsAppSession } from "../src/testing.ts";

void test("Client exposes the Session's live group administration surface", async () => {
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntime({
    accountId: "groups",
    backend: memoryBackend(),
    openSession: () => driver.session,
  });
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  try {
    await driver.emit({ type: "connection", status: { phase: "online" } });
    const created = await client.groups.create("Evidence", ["peer@s.whatsapp.net"]);
    await client.groups.updateSubject(created.id, "Evidence renamed");
    await client.groups.updateDescription(created.id, "Browser proof group");
    await client.groups.updateParticipants(created.id, ["peer@s.whatsapp.net"], "promote");
    await client.groups.updateSetting(created.id, "announcement");
    assert.equal(await client.groups.inviteCode(created.id), "test-invite");
    assert.equal(await client.groups.revokeInvite(created.id), "test-invite-revoked");
    await client.groups.updatePicture(created.id, Buffer.from("picture"));
    await client.groups.removePicture(created.id);
    await client.groups.leave(created.id);

    assert.deepEqual(driver.commands.groups, [
      ["create", "Evidence", ["peer@s.whatsapp.net"]],
      ["subject", created.id, "Evidence renamed"],
      ["description", created.id, "Browser proof group"],
      ["participants", created.id, ["peer@s.whatsapp.net"], "promote"],
      ["setting", created.id, "announcement"],
      ["invite", created.id],
      ["revoke_invite", created.id],
      ["picture", created.id, 7],
      ["remove_picture", created.id],
      ["leave", created.id],
    ]);
  } finally {
    await client.close();
    await runtime.stop();
  }
});
