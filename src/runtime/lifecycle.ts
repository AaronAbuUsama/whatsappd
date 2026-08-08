import { loadAuth } from "../baileys/auth-state.ts";
import { assertE164 } from "../errors.ts";
import type { Status } from "../model/status.ts";
import { pairingAuth, qrAuth, type AuthStrategy, type CredentialStore } from "../ports.ts";
import { createSession } from "../session.ts";
import { submitClientOperation, type ClientOperationOptions } from "./client-operations.ts";
import {
  type WhatsAppOperation,
  type WhatsAppOperationInput,
  type WhatsAppOperationStore,
} from "./operations.ts";
import type { ClientRuntimeSource, RuntimeSession } from "./runtime-source.ts";

export type RuntimeRegistration = "registered" | "unregistered";

/** Safe account-link state. Raw pairing challenges never enter this value. */
export type WhatsAppLinkState =
  | { readonly status: "needs_pairing" }
  | {
      readonly status: "pairing";
      readonly operationId: string;
      readonly method: "qr" | "pairing_code";
      readonly challengeId?: string;
      readonly expiresAt?: number;
    }
  | { readonly status: "linked" };

/** Remove the raw challenge from a pairing status before ordinary publication. */
export function publicConnectionStatus(status: Status): Status {
  if (status.phase !== "pairing" || status.pairing.step !== "challenge_live") return status;
  return {
    phase: "pairing",
    pairing: {
      step: "challenge_live",
      method: status.pairing.method,
      expiresAt: status.pairing.expiresAt,
    },
  };
}

export type ClientPairInput =
  | { readonly method: "qr" }
  | { readonly method: "pairing_code"; readonly phoneE164: string };

export interface ConsumedPairingChallenge {
  readonly method: "qr" | "pairing_code";
  readonly value: string;
  readonly expiresAt: number;
}

export interface PairingOperation extends WhatsAppOperation {
  consumeChallenge(): Promise<ConsumedPairingChallenge | null>;
}

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

/** An unlink request was refused because no linked Session is attached. */
export class AccountNotLinkedError extends Error {
  readonly accountId: string;

  constructor(accountId: string) {
    super(`WhatsApp account "${accountId}" is not linked`);
    this.name = "AccountNotLinkedError";
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
  pairing?: Extract<WhatsAppLinkState, { readonly status: "pairing" }>,
): WhatsAppLinkState | undefined {
  if (pairing) return pairing;
  if (registration === undefined) return undefined;
  return registration === "registered" ? { status: "linked" } : { status: "needs_pairing" };
}

async function submitLifecycleOperation(
  accountId: string,
  store: WhatsAppOperationStore,
  submission: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: Extract<WhatsAppOperationInput, { readonly type: "pair" | "unlink" }>;
  },
  assertEligible: () => void,
): Promise<WhatsAppOperation> {
  const replay = await store.byIdempotency(accountId, submission.idempotencyKey);
  if (!replay) assertEligible();
  return store.submit({ accountId, ...submission });
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
  return submitLifecycleOperation(input.accountId, input.store, input.submission, () => {
    if (input.registration === "registered") throw new AccountAlreadyLinkedError(input.accountId);
  });
}

export async function submitUnlinkOperation(input: {
  readonly accountId: string;
  readonly linked: boolean;
  readonly store: WhatsAppOperationStore;
  readonly submission: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly operation: Extract<WhatsAppOperationInput, { readonly type: "unlink" }>;
  };
}): Promise<WhatsAppOperation> {
  return submitLifecycleOperation(input.accountId, input.store, input.submission, () => {
    if (!input.linked) throw new AccountNotLinkedError(input.accountId);
  });
}

export function createClientPair(source: ClientRuntimeSource) {
  return async (
    input: ClientPairInput,
    options?: ClientOperationOptions,
  ): Promise<PairingOperation> => {
    const operation: Extract<WhatsAppOperationInput, { readonly type: "pair" }> =
      input.method === "qr"
        ? { type: "pair", method: "qr" }
        : {
            type: "pair",
            method: "pairing_code",
            phoneE164: assertE164(input.phoneE164),
          };
    const submitted = await submitClientOperation(operation, options, (submission) =>
      source.submitPair(submission),
    );
    let consumed = false;
    return Object.freeze({
      ...submitted,
      async consumeChallenge(): Promise<ConsumedPairingChallenge | null> {
        if (consumed) return null;
        const challenge = await source.consumePairingChallenge(submitted.id);
        if (challenge) consumed = true;
        return challenge;
      },
    });
  };
}

export function createClientUnlink(source: ClientRuntimeSource) {
  return (options?: ClientOperationOptions): Promise<WhatsAppOperation> =>
    submitClientOperation({ type: "unlink" }, options, (submission) =>
      source.submitUnlink(submission),
    );
}

export const authForPair = (
  input: Extract<WhatsAppOperationInput, { readonly type: "pair" }>,
): AuthStrategy => (input.method === "qr" ? qrAuth() : pairingAuth(input.phoneE164));

export const resumeAuth = qrAuth;
