import type {
  ApplicationConnection,
  ApplicationMessage,
  WhatsAppApplicationCommand,
  WhatsAppApplicationView,
} from "@/lib/whatsapp-application";
import type { WhatsAppBrowser, WhatsAppBrowserSnapshot } from "@/lib/whatsapp-browser";

const NOW = 1_700_000_000_000;
const CHAT_ASTER = "chat-aster";
const CHAT_BEACON = "chat-beacon";

export const STATE_LAB_COVERAGE = {
  connectionPhases: [
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
  ],
  messageKinds: [
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
  ],
  mediaStates: ["stored", "missing", "failed"],
  receiptStates: ["pending", "server_ack", "delivered", "read", "played", "error", "participant"],
  pagingStates: ["stored", "loading", "exhausted", "error"],
  operationStates: ["queued", "claimed", "executing", "succeeded", "failed", "outcome_unknown"],
} as const;

const chatAster = {
  key: CHAT_ASTER,
  name: "Aster Garden",
  initials: "AG",
  avatar: "state-lab-shared",
  isGroup: false,
  lastMessageAt: NOW + 2_000,
  preview: "A short invented message",
  previewFromMe: true,
  previewReceipt: "read" as const,
  canSend: true,
};

const chatBeacon = {
  key: CHAT_BEACON,
  name: "Beacon Workshop",
  initials: "BW",
  avatar: "state-lab-broken",
  isGroup: true,
  lastMessageAt: NOW + 1_000,
  preview: "A second invented message",
  canSend: true,
};

export const stateLabDirectory: WhatsAppApplicationView = {
  revision: 1,
  account: { name: "State Lab", connection: { phase: "online" } },
  chats: [
    chatAster,
    chatBeacon,
    {
      key: "chat-long-name",
      name: "Cedar Observatory With An Intentionally Long Invented Name",
      initials: "CO",
      avatar: "state-lab-shared",
      isGroup: false,
      lastMessageAt: NOW,
      preview: "An invented preview that must truncate without widening the list",
      canSend: true,
    },
    {
      key: "chat-room-seven",
      name: "Room 7",
      initials: "R7",
      isGroup: false,
      lastMessageAt: NOW - 1_000,
      preview: "Short numeric-name fixture",
      canSend: false,
      sendDisabledReason: "This invented chat is read-only",
    },
  ],
  contacts: [
    {
      key: "contact-aster",
      name: "Aster Vale",
      initials: "AV",
      names: [
        { label: "Display name", value: "Aster Vale" },
        { label: "Profile name", value: "A. Vale" },
        { label: "Username", value: "aster-garden" },
      ],
      about: "Invented fixture contact",
      canSend: true,
      canCreateGroup: true,
      commonGroups: [{ key: CHAT_BEACON, name: "Beacon Workshop" }],
    },
    {
      key: "contact-celadon",
      name: "Celadon Finch",
      initials: "CF",
      names: [{ label: "Verified name", value: "Celadon Finch Studio" }],
      canSend: false,
      canCreateGroup: false,
    },
  ],
  groups: [
    {
      key: CHAT_BEACON,
      name: "Beacon Workshop",
      initials: "BW",
      participantCount: 3,
      canSend: true,
    },
    {
      key: "group-empty",
      name: "Empty Conservatory",
      initials: "EC",
      participantCount: 0,
      canSend: false,
    },
    {
      key: "group-unknown",
      name: "Unloaded Orchard",
      initials: "UO",
      canSend: false,
    },
  ],
  updates: [],
};

const baseMessage = (
  key: string,
  content: ApplicationMessage["content"],
  extra: Partial<ApplicationMessage> = {},
): ApplicationMessage => ({
  key,
  fromMe: false,
  sender: "Aster Vale",
  timestamp: NOW + 10_000,
  edited: false,
  ephemeral: false,
  viewOnce: false,
  reactions: [],
  mentions: [],
  content,
  ...extra,
});

const receiptMessage = (
  status: "pending" | "server_ack" | "delivered" | "read" | "played" | "error",
): ApplicationMessage =>
  baseMessage(
    `message-receipt-${status}`,
    { kind: "text", text: `Receipt ${status}` },
    {
      fromMe: true,
      sender: undefined,
      receipt: { status, participants: [] },
    },
  );

const operationMessage = (
  status: "queued" | "claimed" | "executing" | "succeeded" | "failed" | "outcome_unknown",
): ApplicationMessage =>
  baseMessage(
    `message-operation-${status}`,
    { kind: "text", text: `Operation ${status}` },
    {
      fromMe: true,
      sender: undefined,
      operation: {
        key: `operation-${status}`,
        status,
        ...(status === "failed" && { detail: "Invented pre-send failure" }),
      },
    },
  );

const messages: readonly ApplicationMessage[] = [
  baseMessage(
    "message-text-incoming",
    { kind: "text", text: "Invented incoming message" },
    {
      quote: { sender: "Beacon Guide", text: "Invented quoted message" },
      mentions: ["participant-celadon"],
      reactions: [{ emoji: "👍", count: 2 }],
    },
  ),
  baseMessage(
    "message-text-outgoing",
    { kind: "text", text: "Invented outgoing message" },
    {
      fromMe: true,
      sender: undefined,
      edited: true,
      ephemeral: true,
      viewOnce: true,
    },
  ),
  baseMessage("message-image-stored", {
    kind: "image",
    state: "stored",
    media: "prototype-attachment.svg",
    mimetype: "image/svg+xml",
    fileName: "invented-image.svg",
    byteLength: 128,
    text: "Invented image caption",
  }),
  baseMessage("message-video-missing", {
    kind: "video",
    state: "stored",
    mimetype: "video/webm",
    fileName: "invented-video.webm",
    byteLength: 256,
  }),
  baseMessage("message-audio-stored", {
    kind: "audio",
    state: "stored",
    media: "prototype-attachment.svg",
    mimetype: "audio/ogg",
    fileName: "invented-audio.ogg",
    byteLength: 128,
    seconds: 4,
    ptt: true,
  }),
  baseMessage("message-document-stored", {
    kind: "document",
    state: "stored",
    media: "prototype-attachment.svg",
    mimetype: "text/plain",
    fileName: "invented-note.txt",
    byteLength: 128,
  }),
  baseMessage("message-sticker-stored", {
    kind: "sticker",
    state: "stored",
    media: "prototype-attachment.svg",
    mimetype: "image/svg+xml",
    byteLength: 128,
  }),
  baseMessage("message-image-failed", {
    kind: "image",
    state: "failed",
    failure: "Invented media capture failure",
  }),
  baseMessage("message-location", {
    kind: "location",
    lat: 0.25,
    lng: -0.5,
    name: "Invented Meadow",
    address: "Fixture Lane",
  }),
  baseMessage("message-contacts", {
    kind: "contacts",
    contacts: [{ name: "Celadon Finch", vcard: "BEGIN:VCARD\nFN:Celadon Finch\nEND:VCARD" }],
  }),
  baseMessage("message-poll", {
    kind: "poll",
    name: "Choose an invented garden",
    options: ["Aster", "Beacon", "Celadon"],
    selectableCount: 1,
  }),
  baseMessage("message-revoked", { kind: "revoked" }),
  baseMessage("message-unsupported", { kind: "unsupported", rawType: "inventedEnvelope" }),
  ...STATE_LAB_COVERAGE.receiptStates
    .filter((status) => status !== "participant")
    .map(receiptMessage),
  baseMessage(
    "message-receipt-participant",
    { kind: "text", text: "Participant receipts" },
    {
      fromMe: true,
      sender: undefined,
      receipt: {
        participants: [
          { status: "delivered", count: 2 },
          { status: "read", count: 1 },
        ],
      },
    },
  ),
  ...STATE_LAB_COVERAGE.operationStates.map(operationMessage),
];

const conversation = {
  chat: chatBeacon,
  messages,
  paging: "stored" as const,
  group: { description: "Invented group fixture", announcement: false, locked: false },
  participants: [
    { key: "participant-aster", name: "Aster Vale", role: "admin" },
    { key: "participant-celadon", name: "Celadon Finch" },
    { key: "participant-dawn", name: "Dawn Harbor" },
  ],
};

export const stateLabConversation: WhatsAppApplicationView = {
  ...stateLabDirectory,
  revision: 2,
  conversation,
};

const connectionViews = Object.fromEntries(
  STATE_LAB_COVERAGE.connectionPhases.map((phase) => [
    phase,
    {
      ...stateLabConversation,
      account: {
        name: "State Lab",
        connection: {
          phase,
          ...(phase === "authenticated" && { progress: 60 }),
          ...(phase === "backing_off" && { retryAt: NOW + 30_000 }),
          ...(phase !== "online" && { detail: `Invented ${phase.replaceAll("_", " ")} state` }),
        } satisfies ApplicationConnection,
      },
    } satisfies WhatsAppApplicationView,
  ]),
) as Record<(typeof STATE_LAB_COVERAGE.connectionPhases)[number], WhatsAppApplicationView>;

const pagingView = (
  paging: (typeof STATE_LAB_COVERAGE.pagingStates)[number],
): WhatsAppApplicationView => ({
  ...stateLabConversation,
  conversation: { ...conversation, paging },
});
const pagingViews = {
  stored: pagingView("stored"),
  loading: pagingView("loading"),
  exhausted: pagingView("exhausted"),
  error: pagingView("error"),
} satisfies Record<(typeof STATE_LAB_COVERAGE.pagingStates)[number], WhatsAppApplicationView>;

export const STATE_LAB_VIEWS = {
  directory: stateLabDirectory,
  conversation: stateLabConversation,
  connections: connectionViews,
  paging: pagingViews,
} as const;

const STATE_LAB_SCENARIOS: Readonly<Record<string, WhatsAppApplicationView>> = {
  directory: stateLabDirectory,
  conversation: stateLabConversation,
  ...Object.fromEntries(
    Object.entries(connectionViews).map(([phase, view]) => [
      `connection-${phase.replaceAll("_", "-")}`,
      view,
    ]),
  ),
};

export function stateLabView(scenario: string | undefined): WhatsAppApplicationView | undefined {
  return scenario ? STATE_LAB_SCENARIOS[scenario] : undefined;
}

export function createStateLabBrowser(
  view: WhatsAppApplicationView,
  commands: WhatsAppApplicationCommand[] = [],
): WhatsAppBrowser {
  const listeners = new Set<() => void>();
  let snapshot: WhatsAppBrowserSnapshot = {
    view,
    pending: 0,
    ...(view.conversation && { selected: view.conversation.chat.key }),
  };
  const directory = view.conversation ? stateLabDirectory : view;
  const announce = (): void => listeners.forEach((listener) => listener());
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    async select(selected) {
      snapshot = {
        ...snapshot,
        view: selected === CHAT_BEACON ? stateLabConversation : directory,
        selected,
      };
      announce();
    },
    async command(command) {
      commands.push(command);
      return { type: "accepted" };
    },
    async sendMedia() {
      return { type: "accepted" };
    },
    async refresh() {},
  };
}
