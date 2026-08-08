import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./_expect.ts";
import {
  AccountAlreadyLinkedError,
  createWhatsAppClient,
  createWhatsAppRuntime,
  libsqlBackend,
  memoryBackend,
  memoryMediaStore,
  memoryPairingChallengeStore,
  type WhatsAppOperationInput,
} from "../src/index.ts";
import { createTestWhatsAppSession, createWhatsAppRuntimeForTesting } from "../src/testing.ts";
import { memoryStore } from "../src/stores/memory.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(done: () => boolean | Promise<boolean>, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await done()) return;
    await tick();
  }
  assert.fail(`condition did not hold within ${turns} event-loop turns`);
}

test("a pairing challenge is account-scoped, refresh-safe, once-only, and expiry-safe", async () => {
  let now = 100;
  const challenges = memoryPairingChallengeStore({ now: () => now });
  await challenges.publish({
    id: "first",
    accountId: "personal",
    method: "qr",
    value: "first-secret",
    expiresAt: 200,
  });

  expect(await challenges.consume("other", "first")).toBe(null);
  await challenges.publish({
    id: "refresh",
    accountId: "personal",
    method: "qr",
    value: "refreshed-secret",
    expiresAt: 200,
  });
  expect(await challenges.consume("personal", "first")).toBe(null);
  expect(await challenges.consume("personal", "refresh")).toEqual({
    id: "refresh",
    accountId: "personal",
    method: "qr",
    value: "refreshed-secret",
    expiresAt: 200,
  });
  expect(await challenges.consume("personal", "refresh")).toBe(null);

  await challenges.publish({
    id: "expired",
    accountId: "personal",
    method: "pairing_code",
    value: "expired-secret",
    expiresAt: 150,
  });
  now = 150;
  expect(await challenges.consume("personal", "expired")).toBe(null);
});

test("pair and unlink use the one durable operation table and idempotency machine", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whatsappd-lifecycle-queue-"));
  const url = `file:${path.join(directory, "whatsapp.db")}`;
  const backend = libsqlBackend({ url, accountId: "lifecycle", media: memoryMediaStore() });
  const oracle = createClient({ url });
  const pair = { type: "pair", method: "qr" } satisfies WhatsAppOperationInput;
  const unlink = { type: "unlink" } satisfies WhatsAppOperationInput;
  try {
    const first = await backend.operations.submit({
      accountId: "lifecycle",
      id: "pair-operation",
      idempotencyKey: "pair-key",
      operation: pair,
    });
    const replay = await backend.operations.submit({
      accountId: "lifecycle",
      id: "ignored-replay-id",
      idempotencyKey: "pair-key",
      operation: pair,
    });
    await backend.operations.submit({
      accountId: "lifecycle",
      id: "unlink-operation",
      idempotencyKey: "unlink-key",
      operation: unlink,
    });

    expect(replay.id).toBe(first.id);
    const schema = await oracle.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = schema.rows.map((row) => {
      if (typeof row.name !== "string") throw new Error("sqlite table name was not text");
      return row.name;
    });
    expect(names.filter((name) => name === "wa_operations")).toEqual(["wa_operations"]);
    expect(names.filter((name) => /pairing|challenge|lifecycle/i.test(name))).toEqual([]);

    const rows = await oracle.execute(
      "SELECT input_json FROM wa_operations WHERE account_id = ? ORDER BY operation_id",
      ["lifecycle"],
    );
    expect(
      rows.rows.map((row) => {
        if (typeof row.input_json !== "string") throw new Error("operation input was not text");
        return JSON.parse(row.input_json);
      }),
    ).toEqual([pair, unlink]);
  } finally {
    oracle.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unregistered runtime reports needs_pairing without opening a Session", async () => {
  const backend = memoryBackend();
  let registrationChecks = 0;
  let openCalls = 0;
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "fresh", backend },
    {
      async registration() {
        registrationChecks += 1;
        return "unregistered";
      },
      async open() {
        openCalls += 1;
        throw new Error("an unregistered startup must not open a Session");
      },
    },
  );

  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    expect(client.account.get().link).toEqual({ status: "needs_pairing" });
    expect(registrationChecks).toBe(1);
    expect(openCalls).toBe(0);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

test("the production Runtime constructor stays idle for fresh credentials", async () => {
  const runtime = createWhatsAppRuntime({
    accountId: "fresh-production",
    backend: memoryBackend(),
  });

  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    expect(client.account.get().link).toEqual({ status: "needs_pairing" });
    expect(client.account.get().connection).toBe(undefined);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

test("an unregistered Client submits a safe pairing-code operation", async () => {
  const backend = memoryBackend();
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "fresh-code", backend },
    {
      async registration() {
        return "unregistered";
      },
      async open() {
        throw new Error("an unregistered pair request must not open a Session");
      },
    },
  );

  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    const operation = await client.account.pair(
      { method: "pairing_code", phoneE164: "+15555550123" },
      { idempotencyKey: "pairing-code" },
    );
    expect(operation.input).toEqual({
      type: "pair",
      method: "pairing_code",
      phoneE164: "+15555550123",
    });
    expect(operation.state).toEqual({ status: "queued" });
    expect((await backend.operations.list("fresh-code")).length).toBe(1);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

test("pair uses one Session and exposes its raw challenge through one destructive handle", async () => {
  const base = memoryBackend();
  let pairExecutionTtl = 0;
  const backend = {
    ...base,
    operations: {
      ...base.operations,
      start(accountId: string, operationId: string, attemptId: string, ttlMs: number) {
        pairExecutionTtl = ttlMs;
        return base.operations.start(accountId, operationId, attemptId, ttlMs);
      },
    },
  };
  await backend.credentials.write({ marker: "durable-before-close" });
  const credentialDigest = async (): Promise<string> =>
    createHash("sha256")
      .update(String(await backend.credentials.read("marker")))
      .digest("hex");
  const digestBeforeClose = await credentialDigest();
  const driver = createTestWhatsAppSession();
  let openCalls = 0;
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "fresh-pair", backend },
    {
      async registration() {
        return "unregistered";
      },
      async open(_credentials, auth) {
        openCalls += 1;
        expect(auth).toEqual({ method: "qr" });
        return driver.session;
      },
    },
  );
  await runtime.start();
  const client = await createWhatsAppClient(runtime);

  const pairing = await client.account.pair(
    { method: "qr" },
    { idempotencyKey: "one-session-pair" },
  );
  await until(() => openCalls === 1);
  expect(pairExecutionTtl >= 300_000).toBe(true);
  await driver.emit({
    type: "connection",
    status: {
      phase: "pairing",
      pairing: {
        step: "challenge_live",
        method: "qr",
        qr: "single-use-secret",
        expiresAt: Date.now() + 10_000,
      },
    },
  });

  const state = client.account.get();
  if (state.link?.status !== "pairing") assert.fail("pairing metadata was absent");
  if (state.connection?.phase !== "pairing" || state.connection.pairing.step !== "challenge_live")
    assert.fail("safe challenge-live status was absent");
  expect(state.link.method).toBe("qr");
  expect(typeof state.link.challengeId).toBe("string");
  expect(state.link.expiresAt).toBe(state.connection.pairing.expiresAt);
  expect("qr" in state.connection.pairing).toBe(false);
  expect(
    JSON.stringify(await client.operations.get(pairing.id)).includes("single-use-secret"),
  ).toBe(false);
  const challenge = await pairing.consumeChallenge();
  expect(challenge?.method).toBe("qr");
  expect(challenge?.value.length).toBe(17);
  expect(challenge?.expiresAt).toBe(state.connection.pairing.expiresAt);
  expect(await pairing.consumeChallenge()).toBe(null);

  await driver.emit({ type: "connection", status: { phase: "online" } });
  await until(async () => (await client.operations.get(pairing.id))?.state.status === "succeeded");
  expect(client.account.get().link).toEqual({ status: "linked" });
  expect(openCalls).toBe(1);

  await client.close();
  expect(await credentialDigest()).toBe(digestBeforeClose);
  const replacement = await createWhatsAppClient(runtime);
  try {
    expect(replacement.account.get().link).toEqual({ status: "linked" });
    expect(replacement.account.get().connection).toBe(undefined);
  } finally {
    await replacement.close();
    await runtime.stop();
  }
});

test("a null consume cannot erase a challenge refreshed while storage is in flight", async () => {
  const base = memoryBackend();
  let entered!: () => void;
  const consuming = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = {
    ...base,
    pairingChallenges: {
      ...base.pairingChallenges,
      async consume(accountId: string, challengeId: string) {
        entered();
        await held;
        return base.pairingChallenges.consume(accountId, challengeId);
      },
    },
  };
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "refresh-during-consume", backend },
    {
      async registration() {
        return "unregistered";
      },
      async open() {
        return driver.session;
      },
    },
  );
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  const pairing = await client.account.pair(
    { method: "qr" },
    { idempotencyKey: "refresh-during-consume" },
  );
  await tick();
  await driver.emit({
    type: "connection",
    status: {
      phase: "pairing",
      pairing: {
        step: "challenge_live",
        method: "qr",
        qr: "old-secret",
        expiresAt: Date.now() + 10_000,
      },
    },
  });

  const staleConsume = pairing.consumeChallenge();
  await consuming;
  await driver.emit({
    type: "connection",
    status: {
      phase: "pairing",
      pairing: {
        step: "challenge_live",
        method: "qr",
        qr: "refreshed-secret",
        expiresAt: Date.now() + 10_000,
      },
    },
  });
  release();

  expect(await staleConsume).toBe(null);
  expect((await pairing.consumeChallenge())?.value).toBe("refreshed-secret");
  expect(await pairing.consumeChallenge()).toBe(null);
  await client.close();
  await runtime.stop();
});

test("a failed pair Session attach rolls back pairing state and closes the partial Session", async () => {
  const backend = memoryBackend();
  const repair = createTestWhatsAppSession();
  let openCalls = 0;
  let partialStops = 0;
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "pair-open-failure", backend },
    {
      async registration() {
        return "unregistered";
      },
      async open() {
        openCalls += 1;
        if (openCalls === 1)
          return {
            ...repair.session,
            subscribe() {
              throw new Error("subscription attach failed");
            },
            async stop() {
              partialStops += 1;
            },
          };
        return repair.session;
      },
    },
  );
  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    const failed = await client.account.pair(
      { method: "qr" },
      { idempotencyKey: "failed-pair-attach" },
    );
    await until(
      async () => (await client.operations.get(failed.id))?.state.status === "outcome_unknown",
    );
    expect(partialStops).toBe(1);
    expect(client.account.get().link).toEqual({ status: "needs_pairing" });

    await client.account.pair({ method: "qr" }, { idempotencyKey: "pair-after-attach-failure" });
    await until(() => openCalls === 2);
    expect(client.account.get().link?.status).toBe("pairing");
  } finally {
    await client.close();
    await runtime.stop();
  }
});

test("unlink uses the operation queue, clears after logout, and leaves the Runtime reusable", async () => {
  const credentials = memoryStore();
  await credentials.write({ creds: "linked-credentials" });
  const order: string[] = [];
  const trackedCredentials = {
    read: (key: string) => credentials.read(key),
    write: (entries: Record<string, string | null>) => credentials.write(entries),
    async clear() {
      order.push("clear");
      await credentials.clear();
    },
  };
  const backend = { ...memoryBackend(), credentials: trackedCredentials };
  const first = createTestWhatsAppSession();
  const repair = createTestWhatsAppSession();
  let finishFirst!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let openCalls = 0;
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "unlink-target", backend },
    {
      async registration() {
        return "registered";
      },
      async open() {
        openCalls += 1;
        if (openCalls === 1)
          return {
            ...first.session,
            start: () => firstRun,
            async unlink() {
              order.push("logout");
              await trackedCredentials.clear();
              finishFirst();
            },
          };
        return repair.session;
      },
    },
  );
  await runtime.start();
  await first.emit({ type: "connection", status: { phase: "online" } });
  const client = await createWhatsAppClient(runtime);

  const unlink = await client.account.unlink({ idempotencyKey: "settings-unlink" });
  await until(async () => (await client.operations.get(unlink.id))?.state.status === "succeeded");
  expect(order).toEqual(["logout", "clear"]);
  expect(await credentials.read("creds")).toBe(null);
  expect(client.account.get().link).toEqual({ status: "needs_pairing" });

  const replay = await client.account.unlink({ idempotencyKey: "settings-unlink" });
  expect(replay.id).toBe(unlink.id);
  expect(order).toEqual(["logout", "clear"]);

  const pairing = await client.account.pair(
    { method: "qr" },
    { idempotencyKey: "repair-after-unlink" },
  );
  await until(() => openCalls === 2);
  expect(pairing.input).toEqual({ type: "pair", method: "qr" });

  await client.close();
  await runtime.stop();
});

test("runtime stop drains an executing unlink before stopping its Session", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let entered!: () => void;
  const unlinkEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sessionStops = 0;
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "stop-during-unlink", backend },
    {
      async registration() {
        return "registered";
      },
      async open() {
        return {
          ...driver.session,
          async unlink() {
            entered();
            await held;
          },
          async stop() {
            sessionStops += 1;
            await driver.session.stop?.();
          },
        };
      },
    },
  );
  await runtime.start();
  await driver.emit({ type: "connection", status: { phase: "online" } });
  const client = await createWhatsAppClient(runtime);
  const operation = await client.account.unlink({ idempotencyKey: "stop-during-unlink" });
  await unlinkEntered;

  const stopping = runtime.stop();
  await tick();
  expect(sessionStops).toBe(0);
  release();
  await stopping;
  expect(sessionStops > 0).toBe(true);
  expect((await backend.operations.get("stop-during-unlink", operation.id))?.state.status).toBe(
    "succeeded",
  );
  await client.close();
});

test("a persisted pair row cannot execute through an already-linked Session", async () => {
  const backend = memoryBackend();
  const submitted = await backend.operations.submit({
    accountId: "linked-queued",
    id: "queued-pair",
    idempotencyKey: "queued-pair",
    operation: { type: "pair", method: "qr" },
  });
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "linked-queued", backend },
    {
      async registration() {
        return "registered";
      },
      async open() {
        return driver.session;
      },
    },
  );

  await runtime.start();
  try {
    await until(
      async () =>
        (await backend.operations.get("linked-queued", submitted.id))?.state.status === "failed",
    );
    const operation = await backend.operations.get("linked-queued", submitted.id);
    expect(operation?.state.status).toBe("failed");
  } finally {
    await runtime.stop();
  }
});

test("an observed live challenge replaces cached registration truth", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "challenged", backend },
    {
      async registration() {
        return "registered";
      },
      async open() {
        return driver.session;
      },
    },
  );

  await runtime.start();
  const client = await createWhatsAppClient(runtime);
  try {
    await driver.emit({
      type: "connection",
      status: {
        phase: "pairing",
        pairing: {
          step: "challenge_live",
          method: "qr",
          qr: "synthetic-challenge",
          expiresAt: 1,
        },
      },
    });
    expect(client.account.get().link).toEqual({ status: "needs_pairing" });
    const operation = await client.account.pair({ method: "qr" });
    expect(operation.state).toEqual({ status: "queued" });
  } finally {
    await client.close();
    await runtime.stop();
  }
});

test("pair rejects before enqueueing or opening another Session when the account is linked", async () => {
  const backend = memoryBackend();
  const driver = createTestWhatsAppSession();
  let openCalls = 0;
  const runtime = createWhatsAppRuntimeForTesting(
    { accountId: "linked", backend },
    {
      async registration() {
        return "registered";
      },
      async open() {
        openCalls += 1;
        return driver.session;
      },
    },
  );

  const client = await createWhatsAppClient(runtime);
  try {
    await assert.rejects(
      client.account.pair({ method: "qr" }),
      (error: unknown) => error instanceof AccountAlreadyLinkedError,
    );
    expect((await backend.operations.list("linked")).length).toBe(0);
    expect(openCalls).toBe(0);

    await runtime.start();
    await driver.emit({ type: "connection", status: { phase: "online" } });
    expect(client.account.get().link).toEqual({ status: "linked" });
    expect(client.account.get().connection?.phase).toBe("online");

    await assert.rejects(
      client.account.pair({ method: "qr" }),
      (error: unknown) => error instanceof AccountAlreadyLinkedError,
    );

    expect((await backend.operations.list("linked")).length).toBe(0);
    expect(openCalls).toBe(1);
    expect(client.account.get().connection?.phase).toBe("online");
  } finally {
    await client.close();
    await runtime.stop();
  }
});
