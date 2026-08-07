import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import {
  AccountAlreadyLinkedError,
  createWhatsAppClient,
  createWhatsAppRuntime,
  memoryBackend,
} from "../src/index.ts";
import { createTestWhatsAppSession, createWhatsAppRuntimeForTesting } from "../src/testing.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(done: () => boolean | Promise<boolean>, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await done()) return;
    await tick();
  }
  assert.fail(`condition did not hold within ${turns} event-loop turns`);
}

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
