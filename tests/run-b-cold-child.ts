/**
 * Issue #112 Run B — the cold-process leg, in a genuinely distinct process.
 *
 * `D-unlink-preserves-durable-chats-and-media` says *a new process* reports
 * `needs_pairing` with an identical durable digest. A fresh Runtime inside the
 * process that just performed the unlink is not that: it shares the module
 * registry, the credential cache and every in-memory latch the unlink touched.
 * So this runs as a child, prints one JSON observation on stdout, and exits.
 *
 * It opens the throwaway slot only. The durable `android` and `ios` profiles
 * are outside its filesystem allowlist, exactly as the parent's are.
 */
import path from "node:path";
import { openThrowawayProfile, sleep } from "./run-b-proof.ts";

const [accountId, directory] = process.argv.slice(2);
if (!accountId || !directory) throw new Error("account id and directory are required");
if (!/^run-b-throwaway-\d{14}$/.test(accountId))
  throw new Error("the cold child refuses anything but a throwaway account");
if (!path.basename(directory).startsWith("throwaway-"))
  throw new Error("the cold child refuses a non-throwaway directory");

const profile = await openThrowawayProfile({ accountId, directory });
try {
  await sleep(1_000);
  const operations = await profile.backend.operations.list(accountId);
  const outstanding = operations.filter(
    (operation) =>
      (operation.input.type === "pair" || operation.input.type === "unlink") &&
      operation.state.status !== "succeeded" &&
      operation.state.status !== "failed" &&
      operation.state.status !== "outcome_unknown",
  ).length;
  process.stdout.write(
    `${JSON.stringify({
      pid: process.pid,
      link: profile.client.account.get().link?.status ?? "none",
      closed: profile.client.account.get().closed,
      sessionFactoryOpenCalls: profile.sessionFactoryOpenCalls(),
      credentialsCleared: (await profile.backend.credentials.read("creds")) === null,
      outstandingLifecycleOperations: outstanding,
      chats: profile.client.chats.list().map(({ chatId }) => chatId),
      contacts: profile.client.contacts.list().map(({ contactId }) => contactId),
      groups: profile.client.groups.list().map(({ groupId }) => groupId),
    })}\n`,
  );
} finally {
  await profile.close().catch(() => {});
}
