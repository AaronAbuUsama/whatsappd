import assert from "node:assert/strict";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { WhatsAppTui } from "../src/app.tsx";
import type { TerminalApplication, TerminalSnapshot } from "../src/application.ts";

const snapshot: TerminalSnapshot = {
  account: "fixture-account",
  phase: "online",
  chats: [
    { id: "tst", name: "TST", preview: "queued proof", isGroup: true, canSend: true },
    {
      id: "readonly",
      name: "Read only",
      preview: "saved mirror",
      isGroup: false,
      canSend: false,
    },
  ],
  selectedChatId: "tst",
  selectedChatName: "TST",
  messages: [
    {
      id: "stored",
      fromMe: false,
      author: "Android",
      kind: "audio",
      body: "Voice message · 2048 bytes",
      reactions: ["👍"],
    },
    {
      id: "queued",
      fromMe: true,
      author: "You",
      kind: "text",
      body: "durable hello",
      status: "queued",
      reactions: [],
    },
    {
      id: "unknown",
      fromMe: true,
      author: "You",
      kind: "image",
      body: "proof image",
      status: "outcome_unknown",
      detail: "delivery unconfirmed",
      reactions: [],
    },
    {
      id: "failed",
      fromMe: true,
      author: "You",
      kind: "text",
      body: "retry me",
      status: "failed",
      detail: "network rejected",
      reactions: [],
    },
  ],
  older: "stored",
};

const sent: string[] = [];
let olderLoads = 0;
const application: TerminalApplication = {
  getSnapshot: () => snapshot,
  subscribe: () => () => undefined,
  selectChat: () => undefined,
  selectOffset: () => undefined,
  loadOlder: () => ((olderLoads += 1), "stored"),
  sendText: async (text) => void sent.push(text),
  close: () => undefined,
};

async function desktopProof(): Promise<void> {
  const view = await testRender(<WhatsAppTui application={application} />, {
    width: 110,
    height: 30,
  });
  try {
    await view.flush();
    const frame = view.captureCharFrame();
    assert.match(frame, /TST/);
    assert.match(frame, /Voice message · 2048 bytes/);
    assert.match(frame, /queued/);
    assert.match(frame, /outcome_unknown · delivery unconfirmed/);
    assert.match(frame, /failed · network rejected/);
  } finally {
    await act(async () => view.renderer.destroy());
  }
}

async function compactProof(): Promise<void> {
  const view = await testRender(<WhatsAppTui application={application} />, {
    width: 60,
    height: 20,
  });
  try {
    await view.flush();
    const frame = view.captureCharFrame();
    assert.match(frame, /TST/);
    assert.match(frame, /Read only · read-only/);
    assert.doesNotMatch(frame, /durable hello/);
  } finally {
    await act(async () => view.renderer.destroy());
  }
}

async function keyboardProof(): Promise<void> {
  const view = await testRender(<WhatsAppTui application={application} />, {
    width: 110,
    height: 30,
  });
  try {
    await view.flush();
    await act(async () => {
      view.mockInput.pressTab();
      await view.flush();
    });
    await act(async () => {
      view.mockInput.pressKey("o");
      await view.flush();
    });
    assert.equal(olderLoads, 1);

    await act(async () => {
      view.mockInput.pressKey("i");
      await view.flush();
    });
    await act(async () => {
      await view.mockInput.typeText("terminal hello");
      view.mockInput.pressEnter();
    });
    await view.waitFor(() => sent.length === 1);
    assert.deepEqual(sent, ["terminal hello"]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
}

await desktopProof();
await compactProof();
await keyboardProof();
console.log("OpenTUI proof: desktop, compact, paging, composer, and operation states passed");
