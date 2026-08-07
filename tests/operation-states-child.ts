import assert from "node:assert/strict";
import {
  createWhatsAppClient,
  libsqlBackend,
  memoryMediaStore,
  type RuntimeSession,
  type WhatsAppOperation,
} from "../src/index.ts";
import {
  createTestWhatsAppRuntime as createWhatsAppRuntime,
  createTestWhatsAppSession,
} from "../src/testing.ts";

type StateName = "queued" | "claimed" | "executing" | "succeeded" | "failed" | "outcome_unknown";

const [databasePath, serializedIds] = process.argv.slice(2);
if (!databasePath || !serializedIds)
  throw new Error("database path and operation ids are required");
const ids = JSON.parse(serializedIds) as Record<StateName, string>;
const names = Object.keys(ids) as StateName[];

const backend = libsqlBackend({
  url: `file:${databasePath}`,
  accountId: "personal",
  media: memoryMediaStore(),
});
const driver = createTestWhatsAppSession();
const session: RuntimeSession = {
  ...driver.session,
  status: { phase: "connecting" },
};
const runtime = createWhatsAppRuntime({
  accountId: "personal",
  backend,
  openSession: () => session,
});
await runtime.start();
const client = await createWhatsAppClient(runtime);

const states = async (): Promise<Record<StateName, WhatsAppOperation["state"]>> => {
  const operations = await client.operations.get(names.map((name) => ids[name]));
  return Object.fromEntries(
    names.map((name, index) => {
      const operation = operations[index];
      assert.ok(operation, `replacement process could not read ${name}`);
      return [name, operation.state] as const;
    }),
  ) as Record<StateName, WhatsAppOperation["state"]>;
};

try {
  const before = await states();
  await driver.emit({ type: "connection", status: { phase: "online" } });
  for (let turn = 0; turn < 100; turn += 1) {
    const operation = await client.operations.get(ids.queued);
    if (operation?.state.status === "succeeded") break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const after = await states();
  assert.equal(after.queued.status, "succeeded");
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      before,
      after,
      commands: {
        sent: driver.commands.sent.length,
        read: driver.commands.read.length,
        typing: driver.commands.typing,
        history: driver.commands.historyRequests.length,
      },
    }),
  );
} finally {
  await client.close();
  await runtime.stop();
  await backend.close();
}
