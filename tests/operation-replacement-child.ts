import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
} from "../src/index.ts";
import { createTestWhatsAppSession } from "../src/testing.ts";

const [databasePath, mediaDirectory, operationId] = process.argv.slice(2);
if (!databasePath || !mediaDirectory || !operationId)
  throw new Error("database path, media directory, and operation id are required");

const backend = libsqlBackend({
  url: `file:${databasePath}`,
  accountId: "personal",
  media: fileMediaStore({ directory: mediaDirectory }),
});
const driver = createTestWhatsAppSession();
const runtime = createWhatsAppRuntime({
  accountId: "personal",
  backend,
  openSession: () => driver.session,
});
await runtime.start();
const client = await createWhatsAppClient(runtime);

try {
  for (let turn = 0; turn < 100; turn += 1) {
    const operation = await client.operations.get(operationId);
    if (
      operation?.state.status === "succeeded" ||
      operation?.state.status === "failed" ||
      operation?.state.status === "outcome_unknown"
    )
      break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const operation = await client.operations.get(operationId);
  assert.equal(operation?.state.status, "succeeded");
  const content = driver.commands.sent[0]?.content;
  if (!content || !("document" in content) || !Buffer.isBuffer(content.document))
    assert.fail("replacement did not send a buffered document");
  process.stdout.write(
    JSON.stringify({
      status: operation.state.status,
      sends: driver.commands.sent.length,
      sha256: createHash("sha256").update(content.document).digest("hex"),
    }),
  );
} finally {
  await client.close();
  await runtime.stop();
  await backend.close();
}
