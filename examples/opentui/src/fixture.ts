import type {
  TerminalApplication,
  TerminalGroupAction,
  TerminalMessageAction,
  TerminalSection,
  TerminalSnapshot,
} from "./components/whatsappd-tui/lib/whatsapp-terminal.ts";

const base: TerminalSnapshot = {
  account: "fixture-account",
  phase: "online",
  section: "chats",
  query: "",
  chats: [
    {
      id: "fixture-group",
      name: "TST",
      preview: "durable state lab",
      isGroup: true,
      canSend: true,
    },
    { id: "fixture-direct", name: "Android", preview: "voice note", isGroup: false, canSend: true },
    {
      id: "fixture-readonly",
      name: "Saved mirror",
      preview: "read only",
      isGroup: false,
      canSend: false,
    },
  ],
  contacts: [
    { id: "fixture-contact", name: "Android", detail: "avatar · last seen" },
    { id: "fixture-contact-2", name: "Terminal tester", detail: "WhatsApp contact" },
  ],
  groups: [
    { id: "fixture-group", name: "TST", detail: "2 participants" },
    { id: "fixture-unknown-group", name: "Unknown roster", detail: "roster unknown" },
  ],
  selectedChatId: "fixture-group",
  selectedChatName: "TST",
  selectedMessageId: "operation-unknown",
  older: "stored",
  messages: [
    {
      id: "text",
      ref: { chatId: "fixture-group", id: "text", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "text",
      body: "WhatsApp state lab",
      metadata: ["reply:quoted", "mentions:1"],
      reactions: ["👍"],
    },
    {
      id: "image",
      ref: { chatId: "fixture-group", id: "image", fromMe: true },
      fromMe: true,
      author: "You",
      kind: "image",
      body: "image · 4096 bytes — proof image",
      metadata: ["receipt:delivered"],
      reactions: [],
    },
    {
      id: "video",
      ref: { chatId: "fixture-group", id: "video", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "video",
      body: "video · 8192 bytes",
      metadata: ["view-once"],
      reactions: [],
    },
    {
      id: "audio",
      ref: { chatId: "fixture-group", id: "audio", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "audio",
      body: "Voice message · 2048 bytes",
      metadata: ["receipt:played"],
      reactions: ["😂"],
    },
    {
      id: "document",
      ref: { chatId: "fixture-group", id: "document", fromMe: true },
      fromMe: true,
      author: "You",
      kind: "document",
      body: "document · 512 bytes",
      metadata: [],
      reactions: [],
    },
    {
      id: "sticker",
      ref: { chatId: "fixture-group", id: "sticker", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "sticker",
      body: "sticker · 1024 bytes",
      metadata: [],
      reactions: [],
    },
    {
      id: "location",
      ref: { chatId: "fixture-group", id: "location", fromMe: true },
      fromMe: true,
      author: "You",
      kind: "location",
      body: "Null Island (0, 0)",
      metadata: [],
      reactions: [],
    },
    {
      id: "contacts",
      ref: { chatId: "fixture-group", id: "contacts", fromMe: true },
      fromMe: true,
      author: "You",
      kind: "contacts",
      body: "Terminal tester",
      metadata: [],
      reactions: [],
    },
    {
      id: "poll",
      ref: { chatId: "fixture-group", id: "poll", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "poll",
      body: "Ship it? — Yes / Later · 1 result",
      metadata: [],
      reactions: [],
    },
    {
      id: "revoked",
      ref: { chatId: "fixture-group", id: "revoked", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "revoked",
      body: "Message deleted",
      metadata: [],
      reactions: [],
    },
    {
      id: "unsupported",
      ref: { chatId: "fixture-group", id: "unsupported", fromMe: false },
      fromMe: false,
      author: "Android",
      kind: "unsupported",
      body: "Unsupported: futureMessage",
      metadata: [],
      reactions: [],
    },
    {
      id: "operation-queued",
      operationId: "operation-queued",
      fromMe: true,
      author: "You",
      kind: "text",
      body: "queued durable send",
      metadata: ["durable operation"],
      status: "queued",
      reactions: [],
    },
    {
      id: "operation-failed",
      operationId: "operation-failed",
      fromMe: true,
      author: "You",
      kind: "image",
      body: "failed image",
      metadata: ["durable operation"],
      status: "failed",
      detail: "network rejected",
      reactions: [],
    },
    {
      id: "operation-unknown",
      operationId: "operation-unknown",
      fromMe: true,
      author: "You",
      kind: "audio",
      body: "voice note",
      metadata: ["durable operation"],
      status: "outcome_unknown",
      detail: "delivery unconfirmed",
      reactions: [],
    },
  ],
};

export function createFixtureApplication(): {
  readonly application: TerminalApplication;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let closed = false;
  let snapshot = base;
  const publish = (next: TerminalSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const setSection = (section: TerminalSection): void => publish({ ...snapshot, section });

  return {
    calls,
    application: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setSection,
      setQuery(query) {
        const needle = query.trim().toLocaleLowerCase();
        publish({
          ...snapshot,
          query,
          chats: base.chats.filter(
            (entry) =>
              !needle || `${entry.name} ${entry.preview}`.toLocaleLowerCase().includes(needle),
          ),
          contacts: base.contacts.filter(
            (entry) =>
              !needle || `${entry.name} ${entry.detail}`.toLocaleLowerCase().includes(needle),
          ),
          groups: base.groups.filter(
            (entry) =>
              !needle || `${entry.name} ${entry.detail}`.toLocaleLowerCase().includes(needle),
          ),
        });
      },
      selectChat(chatId) {
        const chat = snapshot.chats.find((entry) => entry.id === chatId);
        if (chat) publish({ ...snapshot, selectedChatId: chat.id, selectedChatName: chat.name });
      },
      selectOffset(offset) {
        const index = Math.max(
          0,
          snapshot.chats.findIndex((entry) => entry.id === snapshot.selectedChatId),
        );
        const chat =
          snapshot.chats[(index + offset + snapshot.chats.length) % snapshot.chats.length];
        if (chat) publish({ ...snapshot, selectedChatId: chat.id, selectedChatName: chat.name });
      },
      selectMessageOffset(offset) {
        const index = Math.max(
          0,
          snapshot.messages.findIndex((entry) => entry.id === snapshot.selectedMessageId),
        );
        const message =
          snapshot.messages[(index + offset + snapshot.messages.length) % snapshot.messages.length];
        if (message) publish({ ...snapshot, selectedMessageId: message.id });
      },
      loadOlder: () => (calls.push("older"), snapshot.messages[0]?.id),
      async submit(input) {
        calls.push(`submit:${input}`);
      },
      async messageAction(action: TerminalMessageAction) {
        calls.push(`message:${JSON.stringify(action)}`);
      },
      async groupAction(action: TerminalGroupAction) {
        calls.push(`group:${JSON.stringify(action)}`);
        return action.kind === "invite" ? "fixture-invite" : undefined;
      },
      close() {
        if (closed) return;
        closed = true;
        listeners.clear();
      },
    },
  };
}
