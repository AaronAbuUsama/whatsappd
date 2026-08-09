import type { WaIdentity } from "../model/status.ts";
import type {
  MessageRecord,
  StoredMessageCursor,
  StoredMessagePage,
  WhatsAppDurableFrame,
  WhatsAppLiveFrame,
  WhatsAppPatch,
  WhatsAppSnapshot,
} from "./contracts.ts";
import type { ClientChatMessages } from "./client.ts";
import type { WhatsAppOperation } from "./operations.ts";
import type { ClientClaim } from "./runtime.ts";

export const NAMESPACES = ["account", "chats", "contacts", "groups", "messages"] as const;
export type Namespace = (typeof NAMESPACES)[number];

export interface Observation<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly claim: ClientClaim;
}

export interface Derivation {
  readonly at: number;
  readonly claim: ClientClaim | undefined;
  readonly identity: WaIdentity | undefined;
  readonly following: boolean;
}

export interface Retained {
  readonly chatId: string;
  readonly byId: Map<string, MessageRecord>;
  before?: StoredMessageCursor;
  older: "stored" | "loading" | "exhausted";
  failure?: { readonly error: unknown };
  view?: ClientChatMessages;
}

export type Registration =
  | { readonly kind: "namespace"; readonly namespace: Namespace; readonly notify: () => void }
  | { readonly kind: "operation"; readonly operationId: string; readonly notify: () => void };

export type PageLanding =
  | { readonly started: true; readonly ended?: undefined }
  | { readonly ended: true; readonly started?: undefined }
  | { readonly page: StoredMessagePage; readonly started?: undefined; readonly ended?: undefined }
  | { readonly error: unknown; readonly started?: undefined; readonly ended?: undefined };

export const STARTED: PageLanding = Object.freeze({ started: true });
export const ENDED: PageLanding = Object.freeze({ ended: true });

export interface Tx {
  replace(snapshot: WhatsAppSnapshot): void;
  apply(patch: WhatsAppPatch): void;
  observe(frame: WhatsAppLiveFrame, claim: ClientClaim): void;
  operation(operation: WhatsAppOperation): void;
  page(entry: Retained, landing: PageLanding): void;
  stopped(): void;
  close(frame: Extract<WhatsAppDurableFrame, { type: "closed" }>): void;
}
