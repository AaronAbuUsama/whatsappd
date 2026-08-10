import type {
  ChatRecord,
  ClientAccountState,
  DurableOutbound,
  MessageRecord,
  OptimisticMessage,
  WhatsAppClient,
} from "whatsappd";

export type TerminalChat = {
  readonly id: string;
  readonly name: string;
  readonly preview: string;
  readonly isGroup: boolean;
  readonly canSend: boolean;
};

export type TerminalMessage = {
  readonly id: string;
  readonly fromMe: boolean;
  readonly author: string;
  readonly kind: string;
  readonly body: string;
  readonly status?: string;
  readonly detail?: string;
  readonly reactions: readonly string[];
};

export type TerminalSnapshot = {
  readonly account: string;
  readonly phase: string;
  readonly chats: readonly TerminalChat[];
  readonly selectedChatId?: string;
  readonly selectedChatName?: string;
  readonly messages: readonly TerminalMessage[];
  readonly older: "stored" | "loading" | "exhausted";
  readonly error?: string;
};

export interface TerminalApplication {
  getSnapshot(): TerminalSnapshot;
  subscribe(listener: () => void): () => void;
  selectChat(chatId: string): void;
  selectOffset(offset: number): void;
  loadOlder(): string | undefined;
  sendText(text: string): Promise<void>;
  close(): void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

const compareId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const chatName = (client: WhatsAppClient, chat: ChatRecord): string => {
  if (chat.subject) return chat.subject;
  const contact = client.contacts.resolve(chat.chatId);
  return (
    contact?.displayName ??
    contact?.profileName ??
    contact?.verifiedName ??
    contact?.username ??
    chat.chatId.split("@")[0] ??
    chat.chatId
  );
};

export const accountPhase = (account: ClientAccountState): string => {
  if (account.closed) return "closed";
  const connection = account.connection;
  if (!connection) return "saved mirror";
  return connection.phase === "pairing" ? `pairing · ${connection.pairing.step}` : connection.phase;
};

const acceptsDurableWork = (account: ClientAccountState): boolean =>
  !account.closed &&
  account.connection?.phase !== "logged_out" &&
  account.connection?.phase !== "suspended";

const authoritativeBody = (message: MessageRecord): string => {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return `${message.media.ptt ? "Voice message" : message.kind}${
        message.media.state === "stored"
          ? ` · ${message.media.byteLength} bytes`
          : ` · unavailable (${message.media.reason})`
      }${message.text ? ` — ${message.text}` : ""}`;
    case "location":
      return `${message.name ?? "Location"} (${message.lat}, ${message.lng})`;
    case "contacts":
      return message.contacts.map((contact) => contact.name ?? "Contact").join(", ");
    case "poll":
      return `${message.name} — ${message.options.join(" / ")}`;
    case "revoked":
      return "Message deleted";
    case "unsupported":
      return `Unsupported: ${message.rawType}`;
  }
};

const outboundBody = (content: DurableOutbound): { kind: string; body: string } => {
  if ("text" in content) return { kind: "text", body: content.text };
  if ("image" in content) return { kind: "image", body: content.caption ?? "Image" };
  if ("video" in content) return { kind: "video", body: content.caption ?? "Video" };
  if ("audio" in content) return { kind: "audio", body: content.ptt ? "Voice message" : "Audio" };
  if ("document" in content) return { kind: "document", body: content.fileName };
  if ("sticker" in content) return { kind: "sticker", body: "Sticker" };
  if ("location" in content) return { kind: "location", body: content.location.name ?? "Location" };
  if ("contacts" in content)
    return { kind: "contacts", body: content.contacts.displayName ?? "Contact card" };
  if ("react" in content) return { kind: "reaction", body: content.react.emoji };
  if ("edit" in content) return { kind: "edit", body: content.edit.text };
  return { kind: "revoked", body: "Message deleted" };
};

const optimistic = (message: OptimisticMessage): TerminalMessage => {
  const content = outboundBody(message.content);
  const state = message.state;
  return {
    id: message.operationId,
    fromMe: true,
    author: "You",
    kind: content.kind,
    body: content.body,
    status: state.status,
    ...(state.status === "failed" && { detail: state.error.message }),
    ...(state.status === "outcome_unknown" && { detail: state.reason }),
    reactions: [],
  };
};

export function createTerminalApplication(
  client: WhatsAppClient,
  options: { readonly canSend?: (chatId: string) => boolean } = {},
): TerminalApplication {
  const canSend = options.canSend ?? (() => false);
  const listeners = new Set<() => void>();
  let selectedChatId: string | undefined;
  let closed = false;
  let failure: string | undefined;
  let snapshot: TerminalSnapshot;

  const build = (): TerminalSnapshot => {
    const account = client.account.get();
    const records = [...client.chats.list()].sort(
      (a, b) => b.lastMessageAt - a.lastMessageAt || compareId(a.chatId, b.chatId),
    );
    if (!selectedChatId || !records.some((chat) => chat.chatId === selectedChatId)) {
      selectedChatId = records[0]?.chatId;
    }
    const view = selectedChatId ? client.messages.get(selectedChatId) : undefined;
    const chats = records.map((chat): TerminalChat => {
      const latest = chat.chatId === selectedChatId ? view?.messages[0] : undefined;
      return {
        id: chat.chatId,
        name: chatName(client, chat),
        preview: latest
          ? authoritativeBody(latest)
          : chat.lastMessageAt > 0
            ? "Saved activity"
            : "No saved messages",
        isGroup: chat.isGroup,
        canSend: canSend(chat.chatId) && acceptsDurableWork(account),
      };
    });
    const selected = chats.find((chat) => chat.id === selectedChatId);
    const messages = view
      ? [
          ...[...view.messages]
            .sort((a, b) => a.timestamp - b.timestamp || compareId(a.messageId, b.messageId))
            .map(
              (message): TerminalMessage => ({
                id: message.messageId,
                fromMe: message.fromMe,
                author: message.fromMe ? "You" : (message.pushName ?? message.sender.id),
                kind: message.kind,
                body: authoritativeBody(message),
                reactions: message.reactions.map((reaction) => reaction.emoji),
              }),
            ),
          ...view.outgoing.map(optimistic),
        ]
      : [];
    return {
      account: account.accountId,
      phase: accountPhase(account),
      chats,
      ...(selected && { selectedChatId: selected.id, selectedChatName: selected.name }),
      messages,
      older: view?.older ?? "exhausted",
      ...(failure && { error: failure }),
    };
  };

  const announce = (): void => {
    if (closed) return;
    snapshot = build();
    listeners.forEach((listener) => listener());
  };
  const unsubscribe = [
    client.account,
    client.chats,
    client.contacts,
    client.groups,
    client.messages,
  ].map((namespace) => namespace.subscribe(announce));
  snapshot = build();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectChat(chatId) {
      if (!snapshot.chats.some((chat) => chat.id === chatId)) return;
      selectedChatId = chatId;
      failure = undefined;
      announce();
    },
    selectOffset(offset) {
      if (snapshot.chats.length === 0) return;
      const index = Math.max(
        0,
        snapshot.chats.findIndex((chat) => chat.id === selectedChatId),
      );
      const next = (index + offset + snapshot.chats.length) % snapshot.chats.length;
      selectedChatId = snapshot.chats[next]?.id;
      failure = undefined;
      announce();
    },
    loadOlder() {
      if (!selectedChatId || snapshot.older !== "stored") return undefined;
      const anchor = snapshot.messages[0]?.id;
      client.messages.older(selectedChatId);
      return anchor;
    },
    async sendText(text) {
      const value = text.trim();
      if (!selectedChatId) throw new Error("No chat selected");
      if (!canSend(selectedChatId)) throw new Error("Selected chat is not allowlisted");
      const account = client.account.get();
      if (!acceptsDurableWork(account)) throw new Error(`Account is ${accountPhase(account)}`);
      if (!value) return;
      try {
        await client.messages.send.text(selectedChatId, value);
        failure = undefined;
        announce();
      } catch (error) {
        failure = errorMessage(error);
        announce();
        throw error;
      }
    },
    close() {
      closed = true;
      unsubscribe.forEach((stop) => stop());
      listeners.clear();
    },
  };
}
