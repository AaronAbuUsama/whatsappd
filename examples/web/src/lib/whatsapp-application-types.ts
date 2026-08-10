import type { MediaStore, Unsubscribe, WhatsAppClient } from "whatsappd";
import type {
  WhatsAppApplicationCommand,
  WhatsAppApplicationCommandResult,
  WhatsAppApplicationView,
} from "@/lib/whatsappd/web-contract";

export type * from "@/lib/whatsappd/web-contract";

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
