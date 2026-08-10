import assert from "node:assert/strict";
import test from "node:test";
import { STATE_LAB_COVERAGE, STATE_LAB_VIEWS } from "../src/components/whatsapp-state-lab.ts";
import { assertNoPrivateMaterial, stateLabFixtureSources } from "./privacy-check.ts";

void test("WC-01 state lab covers every contracted public state", () => {
  assert.deepEqual(STATE_LAB_COVERAGE.connectionPhases, [
    "disconnected",
    "connecting",
    "pairing",
    "authenticated",
    "online",
    "backing_off",
    "logged_out",
    "suspended",
    "stale",
    "closed",
  ]);
  assert.deepEqual(STATE_LAB_COVERAGE.messageKinds, [
    "text",
    "image",
    "video",
    "audio",
    "document",
    "sticker",
    "location",
    "contacts",
    "poll",
    "revoked",
    "unsupported",
  ]);
  assert.deepEqual(STATE_LAB_COVERAGE.mediaStates, ["stored", "missing", "failed"]);
  assert.deepEqual(STATE_LAB_COVERAGE.receiptStates, [
    "pending",
    "server_ack",
    "delivered",
    "read",
    "played",
    "error",
    "participant",
  ]);
  assert.deepEqual(STATE_LAB_COVERAGE.pagingStates, ["stored", "loading", "exhausted", "error"]);
  assert.deepEqual(STATE_LAB_COVERAGE.operationStates, [
    "queued",
    "claimed",
    "executing",
    "succeeded",
    "failed",
    "outcome_unknown",
  ]);
});

void test("WC-01 exported views realize every declared state", () => {
  const messages = STATE_LAB_VIEWS.conversation.conversation?.messages ?? [];
  assert.deepEqual(
    [...new Set(messages.map(({ content }) => content.kind))].sort(),
    [...STATE_LAB_COVERAGE.messageKinds].sort(),
  );
  assert.deepEqual(
    [...new Set(messages.flatMap(({ receipt }) => receipt?.status ?? []))].sort(),
    STATE_LAB_COVERAGE.receiptStates.filter((status) => status !== "participant").sort(),
  );
  assert.ok(messages.some(({ receipt }) => receipt?.participants.length));
  assert.deepEqual(
    [...new Set(messages.flatMap(({ operation }) => operation?.status ?? []))].sort(),
    [...STATE_LAB_COVERAGE.operationStates].sort(),
  );
  assert.deepEqual(
    [
      ...new Set(
        messages.flatMap(({ content }) =>
          "state" in content
            ? [content.state === "failed" ? "failed" : content.media ? "stored" : "missing"]
            : [],
        ),
      ),
    ].sort(),
    [...STATE_LAB_COVERAGE.mediaStates].sort(),
  );
  assert.deepEqual(Object.keys(STATE_LAB_VIEWS.connections), [
    ...STATE_LAB_COVERAGE.connectionPhases,
  ]);
  assert.deepEqual(Object.keys(STATE_LAB_VIEWS.paging), [...STATE_LAB_COVERAGE.pagingStates]);
  assert.ok(STATE_LAB_VIEWS.directory.chats.some(({ isGroup }) => isGroup));
  assert.ok(STATE_LAB_VIEWS.directory.chats.some(({ isGroup }) => !isGroup));
  assert.ok(STATE_LAB_VIEWS.directory.chats.some(({ name }) => name.length > 40));
  assert.ok(STATE_LAB_VIEWS.directory.chats.some(({ name }) => /\d/.test(name)));
});

void test("WC-01 state lab contains only invented opaque fixture material", () => {
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(STATE_LAB_VIEWS);
  const serialized = strings.join("\n");
  assert.doesNotMatch(serialized, /@(s\.whatsapp\.net|g\.us|lid|broadcast)\b/i);
  assert.doesNotMatch(serialized, /(?:\+?\d[\s().-]*){7,}/);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i);
  assert.doesNotMatch(serialized, /(?:qr|pairing)[_-]?(?:code|secret|token|value)/i);
});

void test("WC-01 repository fixtures contain no linked-account material", () => {
  const { files, source } = stateLabFixtureSources(new URL("../", import.meta.url));
  assert.ok(files.length > 0);
  assertNoPrivateMaterial(source, "state-lab repository fixtures");
});
