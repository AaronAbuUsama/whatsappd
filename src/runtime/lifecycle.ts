import { loadAuth } from "../baileys/auth-state.ts";
import { assertE164 } from "../errors.ts";
import { qrAuth, type AuthStrategy, type CredentialStore } from "../ports.ts";
import { createSession } from "../session.ts";
import { submitClientOperation, type ClientOperationOptions } from "./client-operations.ts";
import {
  type WhatsAppOperation,
  type WhatsAppOperationInput,
  type WhatsAppOperationStore,
} from "./operations.ts";
import type { ClientRuntimeSource, RuntimeSession } from "./runtime.ts";

export type RuntimeRegistration = "registered" | "unregistered";

/** Safe account-link state. Raw pairing challenges never enter this value. */
export type WhatsAppLinkState =
  | { readonly status: "needs_pairing" }
  | { readonly status: "linked" };

export type ClientPairInput =
  | { readonly method: "qr" }
  | { readonly method: "pairing_code"; readonly phoneE164: string };

/**
 * The one internal seam between account lifecycle and the live Session.
 *
 * @remarks
 * Runtime owns when a Session may exist. The factory owns the protocol-specific
 * questions of whether opaque credentials are registered and how a Session is
 * created for one authentication strategy.
 */
export interface RuntimeSessionFactory {
  registration(credentials: CredentialStore): Promise<RuntimeRegistration>;
  open(credentials: CredentialStore, auth: AuthStrategy): Promise<RuntimeSession>;
}

/** A pair request was refused because this account already has usable credentials. */
export class AccountAlreadyLinkedError extends Error {
  readonly accountId: string;

  constructor(accountId: string) {
    super(`WhatsApp account "${accountId}" is already linked`);
    this.name = "AccountAlreadyLinkedError";
    this.accountId = accountId;
  }
}

/** The production adapter. Baileys credential shapes do not cross this Module. */
export const productionSessionFactory: RuntimeSessionFactory = {
  async registration(credentials) {
    const auth = await loadAuth(credentials);
    return auth.registered || auth.initialSyncComplete ? "registered" : "unregistered";
  },
  async open(credentials, auth) {
    return createSession({ store: credentials, auth });
  },
};

export function linkStateOf(
  registration: RuntimeRegistration | undefined,
): WhatsAppLinkState | undefined {
  if (registration === undefined) return undefined;
  return registration === "registered" ? { status: "linked" } : { status: "needs_pairing" };
}

export async function submitPairOperation(input: {
  readonly accountId: string;
  readonly registration: RuntimeRegistration;
  readonly store: WhatsAppOperationStore;
  readonly submission: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: Extract<WhatsAppOperationInput, { readonly type: "pair" }>;
  };
}): Promise<WhatsAppOperation> {
  if (input.registration === "registered") throw new AccountAlreadyLinkedError(input.accountId);
  return input.store.submit({
    accountId: input.accountId,
    ...input.submission,
  });
}

export function createClientPair(source: ClientRuntimeSource) {
  return (input: ClientPairInput, options?: ClientOperationOptions): Promise<WhatsAppOperation> => {
    const operation: Extract<WhatsAppOperationInput, { readonly type: "pair" }> =
      input.method === "qr"
        ? { type: "pair", method: "qr" }
        : {
            type: "pair",
            method: "pairing_code",
            phoneE164: assertE164(input.phoneE164),
          };
    return submitClientOperation(operation, options, (submission) => source.submitPair(submission));
  };
}

export const resumeAuth = qrAuth;
