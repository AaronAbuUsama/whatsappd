import assert from "node:assert/strict";
import { test } from "node:test";
import * as root from "../src/index.ts";
import type { WhatsAppClient, WhatsAppRuntime } from "../src/index.ts";

/**
 * Compile-time proof of the friendly Client's direct surface.
 *
 * @remarks
 * The packed declaration proof checks the emitted interface independently.
 * This source-level check makes the root type fail immediately if the retired
 * watch contract is rebound to the friendly name.
 */
const acceptsFriendlyClient = (client: WhatsAppClient): void => {
  void client.account;
  void client.chats;
  void client.contacts;
  void client.groups;
  void client.messages;
  void client.close;
  // @ts-expect-error The friendly Client does not expose the raw frame watch.
  void client.watch;
};
void acceptsFriendlyClient;

/** Compile-time proof that raw replication stays behind the Runtime seam. */
const acceptsFriendlyRuntime = (runtime: WhatsAppRuntime): void => {
  void runtime.accountId;
  void runtime.start;
  void runtime.stop;
  // @ts-expect-error Raw mirror reads are not part of the package-root Runtime.
  void runtime.snapshot;
  // @ts-expect-error Raw stored-page reads belong behind the friendly Client.
  void runtime.messages;
  // @ts-expect-error Raw durable frames are internal.
  void runtime.onFrame;
  // @ts-expect-error Raw live frames are internal.
  void runtime.onLive;
};
void acceptsFriendlyRuntime;

void test("the package root exposes only the friendly Client factory", () => {
  assert.equal(typeof root.createWhatsAppClient, "function");
  assert.equal("createInProcessWhatsAppClient" in root, false);
});
