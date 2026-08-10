import type {
  ChatRecord,
  ClientAccountState,
  ContactRecord,
  DurableOutbound,
  MessageRecord,
  OptimisticMessage,
  ReceiptStatus,
  WhatsAppClient,
} from "whatsappd";
import type {
  ApplicationConnection,
  ApplicationMessageContent,
  ApplicationReceipt,
} from "./whatsapp-application-types.ts";

export const firstName = (contact?: ContactRecord): string | undefined =>
  contact?.displayName ?? contact?.profileName ?? contact?.verifiedName ?? contact?.username;

export const initials = (name: string): string => {
  const words = name.trim().split(/\s+/u);
  return `${Array.from(words[0] ?? "?")[0] ?? "?"}${Array.from(words[1] ?? "")[0] ?? ""}`.toUpperCase();
};

export const avatarUrl = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

export const directName = (client: WhatsAppClient, nativeId: string): string =>
  firstName(client.contacts.resolve(nativeId)) ?? nativeId.split("@")[0] ?? "Unknown chat";

export const chatName = (client: WhatsAppClient, chat: ChatRecord): string =>
  chat.subject ?? directName(client, chat.chatId);

export function previewOf(message?: MessageRecord): string | undefined {
  if (!message) return undefined;
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return message.text ?? (message.media.ptt ? "Voice message" : message.kind);
    case "location":
      return message.name ?? "Location";
    case "contacts":
      return message.contacts[0]?.name ?? "Contact card";
    case "poll":
      return message.name;
    case "revoked":
      return "Message deleted";
    case "unsupported":
      return "Unsupported message";
  }
}

const receiptRank: Record<ReceiptStatus, number> = {
  pending: 0,
  server_ack: 1,
  delivered: 2,
  read: 3,
  played: 4,
  error: 5,
};

export function receiptOf(message: MessageRecord): ApplicationReceipt | undefined {
  const aggregate = message.receipts.find((receipt) => receipt.subject === "aggregate")?.status;
  const counts = new Map<ReceiptStatus, number>();
  for (const receipt of message.receipts) {
    if (receipt.subject === "aggregate") continue;
    counts.set(receipt.status, (counts.get(receipt.status) ?? 0) + 1);
  }
  const participants = [...counts]
    .sort(([left], [right]) => receiptRank[left] - receiptRank[right])
    .map(([status, count]) => ({ status, count }));
  return aggregate || participants.length
    ? { ...(aggregate && { status: aggregate }), participants }
    : undefined;
}

export function reactionsOf(
  message: MessageRecord,
): readonly { readonly emoji: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const reaction of message.reactions)
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  return [...counts].map(([emoji, count]) => ({ emoji, count }));
}

export function connectionOf(account: ClientAccountState): ApplicationConnection | undefined {
  if (account.closed)
    return {
      phase: "closed",
      ...(account.error !== undefined && { detail: errorMessage(account.error) }),
    };
  const status = account.connection;
  if (!status)
    return account.lastConnectedAt || account.lastDisconnectedAt ? { phase: "stale" } : undefined;
  switch (status.phase) {
    case "authenticated":
      return {
        phase: status.phase,
        detail: status.sync.step === "draining" ? "Preparing messages" : "Syncing history",
        ...(status.sync.step === "syncing" &&
          status.sync.progress !== undefined && { progress: status.sync.progress }),
      };
    case "pairing":
      return { phase: status.phase, detail: status.pairing.step.replaceAll("_", " ") };
    case "connecting":
      return {
        phase: status.phase,
        ...(status.retryAttempt !== undefined && { detail: `Attempt ${status.retryAttempt}` }),
      };
    case "backing_off":
      return { phase: status.phase, detail: status.reason, retryAt: status.nextRetryAt };
    case "logged_out":
    case "suspended":
      return { phase: status.phase, detail: status.reason };
    default:
      return { phase: status.phase };
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function operationDetail(operation: OptimisticMessage): string | undefined {
  if (operation.state.status === "failed") return operation.state.error.message;
  if (operation.state.status === "outcome_unknown") return operation.state.reason;
  return undefined;
}

export function optimisticContent(content: DurableOutbound): ApplicationMessageContent {
  if ("text" in content) return { kind: "text", text: content.text };
  if ("image" in content) return { kind: "image", state: "stored", text: content.caption };
  if ("video" in content) return { kind: "video", state: "stored", text: content.caption };
  if ("audio" in content)
    return {
      kind: "audio",
      state: "stored",
      ptt: content.ptt,
      seconds: content.seconds,
      mimetype: content.mimetype,
    };
  if ("document" in content)
    return {
      kind: "document",
      state: "stored",
      fileName: content.fileName,
      mimetype: content.mimetype,
      text: content.caption,
    };
  if ("sticker" in content) return { kind: "sticker", state: "stored" };
  if ("location" in content) return { kind: "location", ...content.location };
  if ("contacts" in content)
    return {
      kind: "contacts",
      contacts: content.contacts.vcards.map((vcard) => ({
        name: content.contacts.displayName,
        vcard,
      })),
    };
  return { kind: "unsupported", rawType: "operation" };
}
