import assert from "node:assert/strict";
import { humanUiContext } from "agentic-tui-kit";
import { driveHeadlessTui } from "agentic-tui-kit/testing";
import { createWhatsAppTuiHarness } from "../src/app.tsx";
import { createFixtureApplication } from "../src/fixture.ts";

async function desktopJourney(): Promise<void> {
  const fixture = createFixtureApplication();
  const app = createWhatsAppTuiHarness(fixture.application);
  const journey = await driveHeadlessTui(app.definition, {
    viewport: { width: 120, height: 38 },
    name: "whatsappd desktop state lab",
  });
  try {
    await journey.expect.text("TST");
    await journey.expect.text("outcome_unknown");
    await journey.expect.text("Message or /command");

    assert.equal(
      (await journey.invoke(app.actions.setSection, { section: "groups" }, humanUiContext)).ok,
      true,
    );
    await journey.expect.text("Unknown roster");
    assert.equal(
      (await journey.invoke(app.actions.setSection, { section: "contacts" }, humanUiContext)).ok,
      true,
    );
    await journey.expect.text("avatar");
    assert.equal(
      (await journey.invoke(app.actions.search, { query: "Terminal" }, humanUiContext)).ok,
      true,
    );
    await journey.expect.absent("Android · avatar");
    await journey.invoke(app.actions.search, { query: "" }, humanUiContext);
    await journey.invoke(app.actions.setSection, { section: "chats" }, humanUiContext);

    const submits = [
      "durable hello",
      "/image proof.png",
      "/video proof.mp4",
      "/audio proof.ogg audio/ogg",
      "/voice proof.ogg 1",
      "/document proof.txt text/plain proof.txt",
      "/sticker proof.webp",
      "/location 0 0 Null-Island",
      "/contact Tester BEGIN:VCARD",
    ];
    for (const input of submits) {
      assert.equal((await journey.invoke(app.actions.submit, { input }, humanUiContext)).ok, true);
    }
    const messageActions = [
      { kind: "react" as const, emoji: "👍" },
      { kind: "unreact" as const },
      { kind: "edit" as const, text: "corrected" },
      { kind: "revoke" as const },
      { kind: "read" as const },
      { kind: "history" as const, count: 50 },
      { kind: "typing" as const, on: true },
      { kind: "acknowledge" as const },
    ];
    for (const input of messageActions) {
      assert.equal(
        (await journey.invoke(app.actions.messageAction, input, humanUiContext)).ok,
        true,
      );
    }
    const groupActions = [
      { kind: "metadata" as const, groupId: "fixture-group" },
      { kind: "create" as const, subject: "New", participants: ["fixture-contact"] },
      { kind: "leave" as const, groupId: "fixture-group" },
      { kind: "subject" as const, groupId: "fixture-group", subject: "Renamed" },
      {
        kind: "description" as const,
        groupId: "fixture-group",
        description: "Proof",
      },
      {
        kind: "participants" as const,
        groupId: "fixture-group",
        participants: ["fixture-contact"],
        action: "add" as const,
      },
      {
        kind: "setting" as const,
        groupId: "fixture-group",
        setting: "announcement" as const,
      },
      { kind: "invite" as const, groupId: "fixture-group" },
      { kind: "revoke-invite" as const, groupId: "fixture-group" },
      { kind: "picture" as const, groupId: "fixture-group", path: "proof.png" },
      { kind: "remove-picture" as const, groupId: "fixture-group" },
    ];
    for (const input of groupActions) {
      assert.equal((await journey.invoke(app.actions.groupAction, input, humanUiContext)).ok, true);
    }
    const committed = journey.runtime.actions
      .invocations()
      .filter(({ actionId }) =>
        ["whatsapp.message.submit", "whatsapp.message.action", "whatsapp.group.action"].includes(
          actionId,
        ),
      );
    assert.equal(committed.length, submits.length + messageActions.length + groupActions.length);
    assert.equal(
      committed.every(({ outcome }) => outcome === "success"),
      true,
    );
  } finally {
    await journey.finish();
  }
}

async function narrowKeyboardJourney(): Promise<void> {
  const fixture = createFixtureApplication();
  const app = createWhatsAppTuiHarness(fixture.application);
  const journey = await driveHeadlessTui(app.definition, {
    viewport: { width: 58, height: 24 },
    name: "whatsappd narrow keyboard",
  });
  try {
    await journey.expect.text("TST");
    await journey.expect.absent("WhatsApp state lab");
    await journey.pointer({ kind: "hover", button: "left", x: 10, y: 11 });
    await journey.click({ x: 10, y: 11 });
    assert.equal(fixture.application.getSnapshot().selectedChatId, "fixture-direct");
    await journey.expect.text("Android");
    await journey.key("enter");
    await journey.expect.text("WhatsApp state lab");
    await journey.key("escape");
    await journey.expect.absent("WhatsApp state lab");
    assert.equal(
      journey.record().events.filter((event) => event.kind === "pointer").length >= 3,
      true,
    );
  } finally {
    await journey.finish();
  }
}

await desktopJourney();
await narrowKeyboardJourney();
console.log("Agentic TUI proof: actions, desktop, narrow, keyboard, and pointer passed");
