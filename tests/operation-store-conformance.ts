import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OperationIdempotencyConflictError,
  type WhatsAppOperationInput,
  type WhatsAppOperationStore,
} from "../packages/whatsappd/src/runtime/operations.ts";

interface StoreFixture {
  readonly store: WhatsAppOperationStore;
  close(): Promise<void>;
}

const input = (text: string): WhatsAppOperationInput => ({
  version: 1,
  type: "send",
  chatId: "store-test@s.whatsapp.net",
  content: { text },
});

export function operationStoreConformance(name: string, create: () => Promise<StoreFixture>): void {
  void test(`[${name}] idempotency is account-scoped and store values are owned`, async () => {
    const fixture = await create();
    try {
      const changes: string[] = [];
      const offThrowing = fixture.store.subscribe("personal", () => {
        throw new Error("operation listener failed");
      });
      const offRecording = fixture.store.subscribe("personal", (operation) => {
        changes.push(operation.id);
      });
      const request = {
        accountId: "personal",
        id: "operation-1",
        idempotencyKey: "key-1",
        input: input("hello"),
      } as const;
      const first = await fixture.store.submit(request);
      offThrowing();
      offRecording();
      assert.deepEqual(changes, [first.id]);
      const repeat = await fixture.store.submit(request);
      assert.deepEqual(repeat, first);
      await assert.rejects(
        fixture.store.submit({ ...request, input: input("different") }),
        OperationIdempotencyConflictError,
      );
      await fixture.store.submit({ ...request, accountId: "work" });
      (first.input as { chatId: string }).chatId = "mutated";
      const stored = await fixture.store.get("personal", first.id);
      assert.ok(stored?.input.type === "send");
      assert.equal(stored.input.chatId, "store-test@s.whatsapp.net");
    } finally {
      await fixture.close();
    }
  });

  void test(`[${name}] claims are ordered and stale attempts are fenced`, async () => {
    const fixture = await create();
    try {
      await fixture.store.submit({
        accountId: "personal",
        id: "a",
        idempotencyKey: "a",
        input: input("first"),
      });
      await fixture.store.submit({
        accountId: "personal",
        id: "b",
        idempotencyKey: "b",
        input: input("second"),
      });
      const first = await fixture.store.claim("personal", "attempt-1", 0);
      assert.equal(first?.id, "a");
      assert.equal(await fixture.store.start("personal", "a", "attempt-1", 1_000), undefined);
      const reclaimed = await fixture.store.claim("personal", "attempt-2", 1_000);
      assert.equal(reclaimed?.id, "a");
      assert.equal(await fixture.store.start("personal", "a", "attempt-1", 1_000), undefined);
      assert.equal(
        (await fixture.store.start("personal", "a", "attempt-2", 1_000))?.state.status,
        "executing",
      );
      assert.equal(
        await fixture.store.succeed("personal", "a", "attempt-1", {
          id: "wrong",
          chatId: "store-test@s.whatsapp.net",
          fromMe: true,
        }),
        undefined,
      );
      assert.equal(
        (
          await fixture.store.succeed("personal", "a", "attempt-2", {
            id: "sent",
            chatId: "store-test@s.whatsapp.net",
            fromMe: true,
          })
        )?.state.status,
        "succeeded",
      );
      assert.equal((await fixture.store.claim("personal", "attempt-b", 1_000))?.id, "b");
      assert.equal(await fixture.store.release("personal", "b", "stale-attempt"), undefined);
      assert.equal(
        (await fixture.store.release("personal", "b", "attempt-b"))?.state.status,
        "queued",
      );
      assert.equal((await fixture.store.claim("personal", "attempt-b2", 1_000))?.id, "b");
    } finally {
      await fixture.close();
    }
  });

  void test(`[${name}] subscriptions preserve registrations and defer additions`, async () => {
    const fixture = await create();
    const seen: string[] = [];
    const same = () => seen.push("same");
    let registered = false;
    let offLate = (): void => {};
    const offFirst = fixture.store.subscribe("personal", same);
    const offSecond = fixture.store.subscribe("personal", same);
    const offRegistering = fixture.store.subscribe("personal", () => {
      seen.push("registering");
      if (!registered) {
        registered = true;
        offLate = fixture.store.subscribe("personal", () => seen.push("late"));
      }
    });
    try {
      await fixture.store.submit({
        accountId: "personal",
        id: "first",
        idempotencyKey: "first",
        input: input("first"),
      });
      assert.deepEqual(seen, ["same", "same", "registering"]);
      offFirst();
      await fixture.store.submit({
        accountId: "personal",
        id: "second",
        idempotencyKey: "second",
        input: input("second"),
      });
      assert.deepEqual(seen, ["same", "same", "registering", "same", "registering", "late"]);
    } finally {
      offFirst();
      offSecond();
      offRegistering();
      offLate();
      await fixture.close();
    }
  });

  void test(`[${name}] unknown input versions never enter durable storage`, async () => {
    const fixture = await create();
    try {
      await assert.rejects(
        async () =>
          fixture.store.submit({
            accountId: "personal",
            id: "future",
            idempotencyKey: "future",
            input: { ...input("future"), version: 2 } as unknown as WhatsAppOperationInput,
          }),
        TypeError,
      );
      await assert.rejects(
        async () =>
          fixture.store.submit({
            accountId: "personal",
            id: "secret",
            idempotencyKey: "secret",
            input: {
              version: 1,
              type: "send",
              chatId: "store-test@s.whatsapp.net",
              content: { text: "safe", secretBytes: Buffer.from("SECRET") },
            } as unknown as WhatsAppOperationInput,
          }),
        TypeError,
      );
      await assert.rejects(
        async () =>
          fixture.store.submit({
            accountId: "personal",
            id: "malformed",
            idempotencyKey: "malformed",
            input: {
              version: 1,
              type: "phone_history",
              anchor: null,
              count: "many",
            } as unknown as WhatsAppOperationInput,
          }),
        TypeError,
      );
      assert.deepEqual(await fixture.store.list("personal"), []);
    } finally {
      await fixture.close();
    }
  });

  void test(`[${name}] claim publication exposes only final committed receipts`, async () => {
    const fixture = await create();
    try {
      const submitted = await fixture.store.submit({
        accountId: "personal",
        id: "recovered",
        idempotencyKey: "recovered",
        input: input("recover"),
      });
      await fixture.store.claim("personal", "expired", 0);
      const seen: string[] = [];
      let offLate = (): void => {};
      const offEarly = fixture.store.subscribe("personal", (operation) => {
        seen.push(`early:${operation.state.status}`);
        offLate = fixture.store.subscribe("personal", (late) => {
          seen.push(`late:${late.state.status}`);
        });
      });
      await fixture.store.claim("personal", "replacement", 1_000);
      offEarly();
      offLate();
      assert.deepEqual(seen, ["early:claimed"]);
      assert.equal((await fixture.store.get("personal", submitted.id))?.state.status, "claimed");
    } finally {
      await fixture.close();
    }
  });

  void test(`[${name}] sequence, not wall-clock/hash order, owns the queue`, async () => {
    const fixture = await create();
    try {
      const first = await fixture.store.submit({
        accountId: "personal",
        id: "z-last-by-id",
        idempotencyKey: "first",
        input: input("first"),
      });
      const second = await fixture.store.submit({
        accountId: "personal",
        id: "a-first-by-id",
        idempotencyKey: "second",
        input: input("second"),
      });
      assert.equal(second.sequence, first.sequence + 1);
      assert.equal((await fixture.store.claim("personal", "ordered", 1_000))?.id, first.id);
    } finally {
      await fixture.close();
    }
  });

  void test(`[${name}] an expired executing attempt is terminal and acknowledgeable`, async () => {
    const fixture = await create();
    try {
      await fixture.store.submit({
        accountId: "personal",
        id: "unknown",
        idempotencyKey: "unknown",
        input: input("maybe sent"),
      });
      await fixture.store.claim("personal", "attempt", 1_000);
      await fixture.store.start("personal", "unknown", "attempt", 0);
      assert.equal(await fixture.store.claim("personal", "other", 1_000), undefined);
      const unknown = await fixture.store.get("personal", "unknown");
      assert.equal(unknown?.state.status, "outcome_unknown");
      const acknowledged = await fixture.store.acknowledge("personal", "unknown");
      assert.equal(typeof acknowledged?.acknowledgedAt, "number");
      assert.equal(
        (await fixture.store.acknowledge("personal", "unknown"))?.acknowledgedAt,
        acknowledged?.acknowledgedAt,
      );
    } finally {
      await fixture.close();
    }
  });

  void test(`[${name}] transition arguments are validated before persistence`, async () => {
    const fixture = await create();
    try {
      await fixture.store.submit({
        accountId: "personal",
        id: "unsafe-failure",
        idempotencyKey: "unsafe-failure",
        input: input("fail safely"),
      });
      await fixture.store.claim("personal", "failure-attempt", 1_000);
      await assert.rejects(
        fixture.store.fail("personal", "unsafe-failure", "failure-attempt", {
          name: "Error",
          message: "boom",
          stack: "SECRET_STACK",
        } as never),
        TypeError,
      );
      assert.equal(
        (await fixture.store.get("personal", "unsafe-failure"))?.state.status,
        "claimed",
      );

      await fixture.store.release("personal", "unsafe-failure", "failure-attempt");
      await fixture.store.claim("personal", "unknown-attempt", 1_000);
      await fixture.store.start("personal", "unsafe-failure", "unknown-attempt", 1_000);
      await assert.rejects(
        fixture.store.unknown("personal", "unsafe-failure", "unknown-attempt", 42 as never),
        TypeError,
      );
      assert.equal(
        (await fixture.store.get("personal", "unsafe-failure"))?.state.status,
        "executing",
      );
    } finally {
      await fixture.close();
    }
  });
}
