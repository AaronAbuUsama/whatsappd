import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OperationIdempotencyConflictError,
  type WhatsAppOperationInput,
  type WhatsAppOperationStore,
} from "../src/runtime/operations.ts";

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
      const request = {
        accountId: "personal",
        id: "operation-1",
        idempotencyKey: "key-1",
        input: input("hello"),
      } as const;
      const first = await fixture.store.submit(request);
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
}
