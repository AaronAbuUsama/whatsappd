import type {
  MediaStore,
  PresenceKind,
  ReceiptStatus,
  Unsubscribe,
  WhatsAppClient,
  WhatsAppOperation,
} from "whatsappd";

export type ApplicationConnection = {
  readonly phase:
    | "disconnected"
    | "connecting"
    | "pairing"
    | "authenticated"
    | "online"
    | "backing_off"
    | "logged_out"
    | "suspended"
    | "stale"
    | "closed";
  readonly detail?: string;
  readonly progress?: number;
  readonly retryAt?: number;
};

export type ApplicationAccount = {
  readonly name: string;
  readonly connection?: ApplicationConnection;
  readonly lastConnectedAt?: number;
  readonly lastDisconnectedAt?: number;
};

export type ApplicationChat = {
  readonly key: string;
  readonly name: string;
  readonly initials: string;
  readonly avatar?: string;
  readonly isGroup: boolean;
  readonly lastMessageAt: number;
  readonly preview?: string;
  readonly previewFromMe?: boolean;
  readonly previewReceipt?: ReceiptStatus;
  readonly presence?: PresenceKind;
  readonly canSend: boolean;
  readonly sendDisabledReason?: string;
};

export type ApplicationMessageContent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image" | "video" | "audio" | "document" | "sticker";
      readonly state: "stored" | "failed";
      readonly media?: string;
      readonly mimetype?: string;
      readonly fileName?: string;
      readonly byteLength?: number;
      readonly seconds?: number;
      readonly ptt?: boolean;
      readonly text?: string;
      readonly failure?: string;
    }
  | {
      readonly kind: "location";
      readonly lat: number;
      readonly lng: number;
      readonly name?: string;
      readonly address?: string;
    }
  | {
      readonly kind: "contacts";
      readonly contacts: readonly { readonly name?: string; readonly vcard: string }[];
    }
  | {
      readonly kind: "poll";
      readonly name: string;
      readonly options: readonly string[];
      readonly selectableCount: number;
    }
  | { readonly kind: "unsupported"; readonly rawType: string }
  | { readonly kind: "revoked"; readonly revokedAt?: number };

export type ApplicationReceipt = {
  readonly status?: ReceiptStatus;
  readonly participants: readonly { readonly status: ReceiptStatus; readonly count: number }[];
};

export type ApplicationMessage = {
  readonly key: string;
  readonly fromMe: boolean;
  readonly sender?: string;
  readonly timestamp: number;
  readonly edited: boolean;
  readonly ephemeral: boolean;
  readonly viewOnce: boolean;
  readonly receipt?: ApplicationReceipt;
  readonly reactions: readonly { readonly emoji: string; readonly count: number }[];
  readonly quote?: { readonly key?: string; readonly sender?: string; readonly text?: string };
  readonly mentions: readonly string[];
  readonly content: ApplicationMessageContent;
  readonly operation?: {
    readonly key: string;
    readonly status: WhatsAppOperation["state"]["status"];
    readonly detail?: string;
  };
};

export type ApplicationUpdate = {
  readonly key: string;
  readonly sender: string;
  readonly initials: string;
  readonly avatar?: string;
  readonly timestamp: number;
  readonly content: ApplicationMessageContent;
};

export type ApplicationConversation = {
  readonly chat: ApplicationChat;
  readonly messages: readonly ApplicationMessage[];
  readonly paging: "stored" | "loading" | "exhausted" | "error";
  readonly group?: {
    readonly description?: string;
    readonly announcement?: boolean;
    readonly locked?: boolean;
  };
  readonly participants?: readonly {
    readonly key: string;
    readonly name: string;
    readonly role?: string;
  }[];
};

export type WhatsAppApplicationView = {
  readonly revision: number;
  readonly account: ApplicationAccount;
  readonly chats: readonly ApplicationChat[];
  readonly updates: readonly ApplicationUpdate[];
  readonly contacts: readonly {
    readonly key: string;
    readonly name: string;
    readonly initials: string;
    readonly avatar?: string;
    readonly names: readonly {
      readonly label: "Display name" | "Profile name" | "Verified name" | "Username";
      readonly value: string;
    }[];
    readonly about?: string;
    readonly lastSeenAt?: number;
    readonly presence?: PresenceKind;
    readonly canSend: boolean;
    readonly canCreateGroup: boolean;
    readonly groupKey?: string;
    readonly commonGroups?: readonly { readonly key: string; readonly name: string }[];
  }[];
  readonly groups: readonly {
    readonly key: string;
    readonly name: string;
    readonly initials: string;
    readonly avatar?: string;
    readonly participantCount?: number;
    readonly canSend: boolean;
  }[];
  readonly conversation?: ApplicationConversation;
};

type MessageOptions = { readonly quote?: string; readonly mentions?: readonly string[] };
type MediaCommand = MessageOptions & {
  readonly chat: string;
  readonly source: Uint8Array | AsyncIterable<Uint8Array>;
};

export type WhatsAppApplicationCommand =
  | ({ readonly type: "send_text"; readonly chat: string; readonly text: string } & MessageOptions)
  | ({ readonly type: "send_image"; readonly caption?: string } & MediaCommand)
  | ({
      readonly type: "send_video";
      readonly caption?: string;
      readonly gifPlayback?: boolean;
    } & MediaCommand)
  | ({
      readonly type: "send_audio";
      readonly ptt?: boolean;
      readonly seconds?: number;
      readonly mimetype?: string;
    } & MediaCommand)
  | ({
      readonly type: "send_document";
      readonly fileName: string;
      readonly mimetype: string;
      readonly caption?: string;
    } & MediaCommand)
  | ({ readonly type: "send_sticker" } & MediaCommand)
  | ({
      readonly type: "send_location";
      readonly chat: string;
      readonly location: {
        readonly lat: number;
        readonly lng: number;
        readonly name?: string;
        readonly address?: string;
      };
    } & MessageOptions)
  | ({
      readonly type: "send_contacts";
      readonly chat: string;
      readonly contacts: { readonly displayName?: string; readonly vcards: readonly string[] };
    } & MessageOptions)
  | { readonly type: "react"; readonly message: string; readonly emoji: string }
  | { readonly type: "unreact"; readonly message: string }
  | { readonly type: "edit"; readonly message: string; readonly text: string }
  | { readonly type: "revoke"; readonly message: string }
  | { readonly type: "mark_read"; readonly messages: readonly string[] }
  | { readonly type: "typing"; readonly chat: string; readonly on: boolean }
  | { readonly type: "load_older"; readonly chat: string }
  | { readonly type: "request_phone_history"; readonly chat: string; readonly count?: number }
  | { readonly type: "acknowledge"; readonly operation: string }
  | { readonly type: "group_create"; readonly subject: string; readonly participants: string[] }
  | { readonly type: "group_subject"; readonly chat: string; readonly subject: string }
  | { readonly type: "group_description"; readonly chat: string; readonly description?: string }
  | {
      readonly type: "group_participants";
      readonly chat: string;
      readonly participants: readonly string[];
      readonly action: "add" | "remove" | "promote" | "demote";
    }
  | {
      readonly type: "group_setting";
      readonly chat: string;
      readonly setting: "announcement" | "not_announcement" | "locked" | "unlocked";
    }
  | { readonly type: "group_invite"; readonly chat: string }
  | { readonly type: "group_revoke_invite"; readonly chat: string }
  | {
      readonly type: "group_picture";
      readonly chat: string;
      readonly source: Uint8Array | AsyncIterable<Uint8Array>;
    }
  | { readonly type: "group_remove_picture"; readonly chat: string }
  | { readonly type: "group_leave"; readonly chat: string };

export type WhatsAppApplicationCommandResult =
  | { readonly type: "accepted" }
  | {
      readonly type: "operation";
      readonly key: string;
      readonly status: WhatsAppOperation["state"]["status"];
    }
  | { readonly type: "group"; readonly key: string }
  | { readonly type: "invite"; readonly code?: string };

export type WhatsAppApplication = {
  state(chat?: string): Promise<WhatsAppApplicationView>;
  subscribe(listener: () => void): Unsubscribe;
  command(command: WhatsAppApplicationCommand): Promise<WhatsAppApplicationCommandResult>;
  media(token: string): Promise<
    | {
        readonly source: AsyncIterable<Uint8Array>;
        readonly byteLength: number;
        readonly mimetype: string;
        readonly fileName?: string;
      }
    | undefined
  >;
  avatar(token: string): Promise<string | undefined>;
  close(): Promise<void>;
};

export type WhatsAppApplicationOptions = {
  readonly accountId: string;
  readonly client: WhatsAppClient;
  readonly media: MediaStore;
  readonly canSend?: (chatId: string) => boolean;
  readonly canCreateGroupWith?: (participantId: string) => boolean;
  readonly onGroupCreated?: (chatId: string) => void;
  readonly resolveAvatar?: (nativeId: string) => Promise<string | null | undefined>;
};
