import assert from "node:assert/strict";
import test from "node:test";
import type { WhatsAppClient } from "whatsappd";
import { subscribeWhatsAppClient } from "../src/index.ts";

void test("subscribes to every Client namespace and releases each one once", () => {
  let subscribed = 0;
  let released = 0;
  const controller = new AbortController();
  const namespace = {
    subscribe(_listener: () => void, options?: { readonly signal?: AbortSignal }) {
      subscribed += 1;
      let active = true;
      const release = () => {
        if (!active) return;
        active = false;
        released += 1;
      };
      assert.equal(options?.signal, controller.signal);
      options?.signal?.addEventListener("abort", release, { once: true });
      return release;
    },
  };
  const client = {
    account: namespace,
    chats: namespace,
    contacts: namespace,
    groups: namespace,
    messages: namespace,
  } as unknown as WhatsAppClient;

  const unsubscribe = subscribeWhatsAppClient(client, () => undefined, {
    signal: controller.signal,
  });
  assert.equal(subscribed, 5);
  controller.abort();
  assert.equal(released, 5);
  unsubscribe();
  unsubscribe();
  assert.equal(released, 5);
});
