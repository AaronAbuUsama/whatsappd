import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { subscribeWhatsAppClient } from "@whatsappd/react";
import type {
  ChatRecord,
  ClientAccountState,
  DurableOutbound,
  GroupParticipantAction,
  GroupSetting,
  MessageRecord,
  MessageRef,
  OptimisticMessage,
  WhatsAppClient,
} from "whatsappd";
import { commandWords, runOutboundCommand, runSelectedCommand } from "../../../commands.ts";

export type TerminalSection = "chats" | "contacts" | "groups";

export type TerminalChat = {
  readonly id: string;
  readonly name: string;
  readonly preview: string;
  readonly isGroup: boolean;
  readonly canSend: boolean;
};

export type TerminalDirectoryEntry = {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
};

export type TerminalMessage = {
  readonly id: string;
  readonly ref?: MessageRef;
  readonly operationId?: string;
  readonly fromMe: boolean;
  readonly author: string;
  readonly kind: string;
  readonly body: string;
  readonly metadata: readonly string[];
  readonly status?: string;
  readonly detail?: string;
  readonly reactions: readonly string[];
};

export type TerminalSnapshot = {
  readonly account: string;
  readonly phase: string;
  readonly section: TerminalSection;
  readonly query: string;
  readonly chats: readonly TerminalChat[];
  readonly contacts: readonly TerminalDirectoryEntry[];
  readonly groups: readonly TerminalDirectoryEntry[];
  readonly selectedChatId?: string;
  readonly selectedChatName?: string;
  readonly selectedMessageId?: string;
  readonly messages: readonly TerminalMessage[];
  readonly older: "stored" | "loading" | "exhausted";
  readonly error?: string;
};

export type TerminalMessageAction =
  | { readonly kind: "react"; readonly emoji: string }
  | { readonly kind: "unreact" }
  | { readonly kind: "edit"; readonly text: string }
  | { readonly kind: "revoke" }
  | { readonly kind: "read" }
  | { readonly kind: "history"; readonly count?: number }
  | { readonly kind: "typing"; readonly on: boolean }
  | { readonly kind: "acknowledge" };

export type TerminalGroupAction =
  | { readonly kind: "metadata"; readonly groupId: string }
  | { readonly kind: "create"; readonly subject: string; readonly participants: readonly string[] }
  | { readonly kind: "leave"; readonly groupId: string }
  | { readonly kind: "subject"; readonly groupId: string; readonly subject: string }
  | { readonly kind: "description"; readonly groupId: string; readonly description?: string }
  | {
      readonly kind: "participants";
      readonly groupId: string;
      readonly participants: readonly string[];
      readonly action: GroupParticipantAction;
    }
  | { readonly kind: "setting"; readonly groupId: string; readonly setting: GroupSetting }
  | { readonly kind: "invite"; readonly groupId: string }
  | { readonly kind: "revoke-invite"; readonly groupId: string }
  | { readonly kind: "picture"; readonly groupId: string; readonly path: string }
  | { readonly kind: "remove-picture"; readonly groupId: string };

export interface TerminalApplication {
  getSnapshot(): TerminalSnapshot;
  subscribe(listener: () => void): () => void;
  setSection(section: TerminalSection): void;
  setQuery(query: string): void;
  selectChat(chatId: string): void;
  selectOffset(offset: number): void;
  selectMessageOffset(offset: number): void;
  loadOlder(): string | undefined;
  submit(input: string): Promise<void>;
  messageAction(action: TerminalMessageAction): Promise<void>;
  groupAction(action: TerminalGroupAction): Promise<string | undefined>;
  close(): void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

const compareId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const displayName = (id: string, ...names: readonly (string | undefined)[]): string =>
  names.find(Boolean) ?? id.split("@")[0] ?? id;

const chatName = (client: WhatsAppClient, chat: ChatRecord): string => {
  const contact = client.contacts.resolve(chat.chatId);
  return displayName(
    chat.chatId,
    chat.subject,
    contact?.displayName,
    contact?.profileName,
    contact?.verifiedName,
    contact?.username,
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
      return `${message.name ?? "Location"} (${message.lat}, ${message.lng})${
        message.address ? ` · ${message.address}` : ""
      }`;
    case "contacts":
      return message.contacts.map((contact) => contact.name ?? "Contact").join(", ");
    case "poll":
      return `${message.name} — ${message.options.join(" / ")}${
        message.votes
          ? ` · ${message.votes.length} result${message.votes.length === 1 ? "" : "s"}`
          : ""
      }`;
    case "revoked":
      return "Message deleted";
    case "unsupported":
      return `Unsupported: ${message.rawType}`;
  }
};

const messageMetadata = (message: MessageRecord): string[] => [
  ...(message.context?.quoted ? [`reply:${message.context.quoted.id}`] : []),
  ...(message.context?.mentions?.length ? [`mentions:${message.context.mentions.length}`] : []),
  ...(message.flags?.edited || message.editedAt ? ["edited"] : []),
  ...(message.flags?.viewOnce ? ["view-once"] : []),
  ...(message.flags?.ephemeral ? ["ephemeral"] : []),
  ...(message.receipts.length ? [`receipt:${message.receipts.at(-1)?.status}`] : []),
];

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
    operationId: message.operationId,
    fromMe: true,
    author: "You",
    kind: content.kind,
    body: content.body,
    metadata: ["durable operation"],
    status: state.status,
    ...(state.status === "failed" && { detail: state.error.message }),
    ...(state.status === "outcome_unknown" && { detail: state.reason }),
    reactions: [],
  };
};

const selectedRef = (snapshot: TerminalSnapshot): MessageRef => {
  const message = snapshot.messages.find((entry) => entry.id === snapshot.selectedMessageId);
  if (!message?.ref) throw new Error("Select an authoritative message first");
  return message.ref;
};
export function createTerminalApplication(
  client: WhatsAppClient,
  options: { readonly canSend?: (chatId: string) => boolean } = {},
): TerminalApplication {
  const canSend = options.canSend ?? (() => false);
  const listeners = new Set<() => void>();
  let section: TerminalSection = "chats";
  let query = "";
  let selectedChatId: string | undefined;
  let selectedMessageId: string | undefined;
  let closed = false;
  let failure: string | undefined;
  let snapshot: TerminalSnapshot;

  const build = (): TerminalSnapshot => {
    const account = client.account.get();
    const needle = query.trim().toLocaleLowerCase();
    const allChats = [...client.chats.list()].sort(
      (a, b) => b.lastMessageAt - a.lastMessageAt || compareId(a.chatId, b.chatId),
    );
    if (!selectedChatId || !allChats.some((chat) => chat.chatId === selectedChatId)) {
      selectedChatId = allChats[0]?.chatId;
    }
    const view = selectedChatId ? client.messages.get(selectedChatId) : undefined;
    const chats = allChats
      .map((chat): TerminalChat => {
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
      })
      .filter(
        (chat) => !needle || `${chat.name} ${chat.preview}`.toLocaleLowerCase().includes(needle),
      );
    const contacts = client.contacts
      .list()
      .map(
        (contact): TerminalDirectoryEntry => ({
          id: contact.contactId,
          name: displayName(
            contact.contactId,
            contact.displayName,
            contact.profileName,
            contact.verifiedName,
            contact.username,
          ),
          detail:
            [
              contact.about,
              contact.imgUrl ? "avatar" : undefined,
              contact.lastSeenAt ? "last seen" : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || "WhatsApp contact",
        }),
      )
      .filter(
        (contact) =>
          !needle || `${contact.name} ${contact.detail}`.toLocaleLowerCase().includes(needle),
      );
    const groups = client.groups
      .list()
      .map(
        (group): TerminalDirectoryEntry => ({
          id: group.groupId,
          name: group.subject ?? group.groupId.split("@")[0] ?? group.groupId,
          detail:
            group.participants === undefined
              ? "roster unknown"
              : `${group.participants.length} participant${group.participants.length === 1 ? "" : "s"}`,
        }),
      )
      .filter(
        (group) => !needle || `${group.name} ${group.detail}`.toLocaleLowerCase().includes(needle),
      );
    const selected =
      chats.find((chat) => chat.id === selectedChatId) ??
      allChats
        .map((chat) => ({ id: chat.chatId, name: chatName(client, chat) }))
        .find((chat) => chat.id === selectedChatId);
    const messages = view
      ? [
          ...[...view.messages]
            .sort((a, b) => a.timestamp - b.timestamp || compareId(a.messageId, b.messageId))
            .map(
              (message): TerminalMessage => ({
                id: message.messageId,
                ref: message.ref,
                fromMe: message.fromMe,
                author: message.fromMe ? "You" : (message.pushName ?? message.sender.id),
                kind: message.kind,
                body: authoritativeBody(message),
                metadata: messageMetadata(message),
                reactions: message.reactions.map((reaction) => reaction.emoji),
              }),
            ),
          ...view.outgoing.map(optimistic),
        ]
      : [];
    if (!selectedMessageId || !messages.some((message) => message.id === selectedMessageId)) {
      selectedMessageId = messages.at(-1)?.id;
    }
    return {
      account: account.accountId,
      phase: accountPhase(account),
      section,
      query,
      chats,
      contacts,
      groups,
      ...(selected && { selectedChatId: selected.id, selectedChatName: selected.name }),
      ...(selectedMessageId && { selectedMessageId }),
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
  const attempt = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      const value = await operation();
      failure = undefined;
      announce();
      return value;
    } catch (error) {
      failure = errorMessage(error);
      announce();
      throw error;
    }
  };
  const requireTarget = (): string => {
    if (!selectedChatId) throw new Error("No chat selected");
    if (!canSend(selectedChatId)) throw new Error("Selected chat is not allowlisted");
    const account = client.account.get();
    if (!acceptsDurableWork(account)) throw new Error(`Account is ${accountPhase(account)}`);
    return selectedChatId;
  };
  const unsubscribeClient = subscribeWhatsAppClient(client, announce);
  snapshot = build();

  const messageAction = async (action: TerminalMessageAction): Promise<void> => {
    const chatId = requireTarget();
    await attempt(async () => {
      if (action.kind === "typing") return client.messages.setTyping(chatId, action.on);
      if (action.kind === "acknowledge") {
        const message = snapshot.messages.find((entry) => entry.id === snapshot.selectedMessageId);
        if (!message?.operationId) throw new Error("Select an optimistic operation first");
        await client.operations.acknowledge(message.operationId);
        return;
      }
      const ref = selectedRef(snapshot);
      if (action.kind === "react") await client.messages.react(ref, action.emoji);
      else if (action.kind === "unreact") await client.messages.unreact(ref);
      else if (action.kind === "edit") await client.messages.edit(ref, action.text);
      else if (action.kind === "revoke") await client.messages.revoke(ref);
      else if (action.kind === "read") await client.messages.markRead([ref]);
      else {
        const current = client.messages
          .get(chatId)
          .messages.find((message) => message.messageId === ref.id);
        if (!current) throw new Error("Selected message is no longer stored");
        await client.messages.requestPhoneHistory(chatId, {
          before: { ref, timestamp: current.timestamp },
          ...(action.count && { count: action.count }),
        });
      }
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSection(next) {
      section = next;
      failure = undefined;
      announce();
    },
    setQuery(next) {
      query = next;
      announce();
    },
    selectChat(chatId) {
      if (!client.chats.list().some((chat) => chat.chatId === chatId)) return;
      selectedChatId = chatId;
      selectedMessageId = undefined;
      section = "chats";
      failure = undefined;
      announce();
    },
    selectOffset(offset) {
      if (snapshot.chats.length === 0) return;
      const index = Math.max(
        0,
        snapshot.chats.findIndex((chat) => chat.id === selectedChatId),
      );
      selectedChatId =
        snapshot.chats[(index + offset + snapshot.chats.length) % snapshot.chats.length]?.id;
      selectedMessageId = undefined;
      failure = undefined;
      announce();
    },
    selectMessageOffset(offset) {
      if (snapshot.messages.length === 0) return;
      const index = Math.max(
        0,
        snapshot.messages.findIndex((message) => message.id === selectedMessageId),
      );
      selectedMessageId =
        snapshot.messages[(index + offset + snapshot.messages.length) % snapshot.messages.length]
          ?.id;
      announce();
    },
    loadOlder() {
      if (!selectedChatId || snapshot.older !== "stored") return undefined;
      const anchor = snapshot.messages[0]?.id;
      client.messages.older(selectedChatId);
      return anchor;
    },
    async submit(input) {
      const raw = input.trim();
      if (!raw) return;
      const chatId = requireTarget();
      if (!raw.startsWith("/")) {
        await attempt(() => client.messages.send.text(chatId, raw).then(() => undefined));
        return;
      }
      const [command, ...args] = commandWords(raw);
      if (command && (await runSelectedCommand(command, args, messageAction))) return;
      await attempt(async () => {
        if (command && (await runOutboundCommand(client, chatId, command, args))) return;
        throw new Error(
          "Unknown command. Try /image, /video, /audio, /voice, /document, /sticker, /location, /contact, /react, /edit, /read, or /history.",
        );
      });
    },
    messageAction,
    async groupAction(action) {
      if (action.kind !== "create" && action.kind !== "metadata" && !canSend(action.groupId)) {
        throw new Error("Group is not allowlisted");
      }
      if (action.kind === "create" && !action.participants.every(canSend)) {
        throw new Error("Every new-group participant must be allowlisted");
      }
      return attempt(async () => {
        if (action.kind === "metadata")
          return JSON.stringify(await client.groups.metadata(action.groupId));
        if (action.kind === "create")
          return (await client.groups.create(action.subject, action.participants)).id;
        if (action.kind === "leave") await client.groups.leave(action.groupId);
        else if (action.kind === "subject")
          await client.groups.updateSubject(action.groupId, action.subject);
        else if (action.kind === "description")
          await client.groups.updateDescription(action.groupId, action.description);
        else if (action.kind === "participants")
          await client.groups.updateParticipants(
            action.groupId,
            action.participants,
            action.action,
          );
        else if (action.kind === "setting")
          await client.groups.updateSetting(action.groupId, action.setting);
        else if (action.kind === "invite") return await client.groups.inviteCode(action.groupId);
        else if (action.kind === "revoke-invite")
          return await client.groups.revokeInvite(action.groupId);
        else if (action.kind === "picture") {
          const path = resolve(action.path);
          const details = await stat(path);
          if (!details.isFile() || details.size > 8 * 1024 * 1024)
            throw new Error("Group picture must be a file no larger than 8 MiB");
          await client.groups.updatePicture(action.groupId, await readFile(path));
        } else await client.groups.removePicture(action.groupId);
        return undefined;
      });
    },
    close() {
      closed = true;
      unsubscribeClient();
      listeners.clear();
    },
  };
}
