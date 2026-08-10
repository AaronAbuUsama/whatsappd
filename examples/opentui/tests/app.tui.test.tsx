import assert from "node:assert/strict";
import { testRender } from "@opentui/react/test-utils";
import { useKeyboard } from "@opentui/react";
import { act, useState } from "react";
import { createWhatsAppBindings, type WhatsAppStore } from "@whatsappd/react";
import { WhatsAppTui } from "../src/app.tsx";
import type {
  TerminalApplication,
  TerminalSnapshot,
} from "../src/components/whatsappd-tui/lib/whatsapp-terminal.ts";

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
let activeSubscriptions = 0;
const application: TerminalApplication = {
  getSnapshot: () => snapshot,
  subscribe: () => {
    activeSubscriptions += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeSubscriptions -= 1;
    };
  },
  selectChat: () => undefined,
  selectOffset: () => undefined,
  loadOlder: () => ((olderLoads += 1), "stored"),
  sendText: async (text) => void sent.push(text),
  close: () => undefined,
};

type CountingStore = WhatsAppStore<string> & { readonly active: () => number };

const { WhatsAppProvider, useWhatsAppSnapshot } = createWhatsAppBindings<string, CountingStore>();

const countingStore = (value: string): CountingStore => {
  let subscriptions = 0;
  return {
    active: () => subscriptions,
    getSnapshot: () => value,
    subscribe: () => {
      subscriptions += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscriptions -= 1;
      };
    },
  };
};

function SnapshotProbe() {
  return <text>{useWhatsAppSnapshot()}</text>;
}

function ReplacementProbe({ first, second }: { first: CountingStore; second: CountingStore }) {
  const [store, setStore] = useState<CountingStore>(first);
  useKeyboard((key) => {
    if (key.name === "r") setStore(second);
  });
  return (
    <WhatsAppProvider store={store}>
      <SnapshotProbe />
    </WhatsAppProvider>
  );
}

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
    assert.equal(activeSubscriptions, 0);
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
    assert.equal(activeSubscriptions, 0);
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
    assert.equal(activeSubscriptions, 0);
  }
}

async function replacementProof(): Promise<void> {
  const first = countingStore("first");
  const second = countingStore("second");
  const view = await testRender(<ReplacementProbe first={first} second={second} />, {
    width: 30,
    height: 4,
  });
  try {
    await view.flush();
    assert.equal(first.active(), 1);
    assert.equal(second.active(), 0);
    await act(async () => {
      view.mockInput.pressKey("r");
      await view.flush();
    });
    assert.equal(first.active(), 0);
    assert.equal(second.active(), 1);
    await view.waitFor(() => view.captureCharFrame().includes("second"));
  } finally {
    await act(async () => view.renderer.destroy());
    assert.equal(first.active(), 0);
    assert.equal(second.active(), 0);
  }
}

await desktopProof();
await compactProof();
await keyboardProof();
await replacementProof();
console.log(
  "OpenTUI proof: desktop, compact, paging, composer, operations, and Provider lifetime passed",
);
