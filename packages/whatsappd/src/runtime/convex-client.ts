/**
 * The typed call surface every Convex-backed capability shares, and the
 * lazily opened client behind it.
 *
 * @remarks
 * `convex` is an OPTIONAL peer dependency, imported dynamically so the core
 * package never forces it on a deployment using a different backend — the same
 * arrangement `@libsql/client` has.
 *
 * Calls name a function rather than carrying a `FunctionReference`, because
 * building one needs `convex/server` at runtime and the maps below need to
 * exist before the dependency is known to be installed. The two maps are the
 * contract with `src/convex.ts`: a function whose arguments change there fails
 * to compile here.
 *
 * @packageDocumentation
 */
import type { AccountLease } from "./contracts.ts";

/** A row write the acceptance mutation applies, one per projection mutation. */
export interface ConvexRowWrite {
  readonly kind:
    | "account"
    | "chat"
    | "contact"
    | "contactDelete"
    | "group"
    | "message"
    | "alias"
    | "pendingUpdates";
  readonly id: string;
  readonly messageId?: string;
  readonly timestamp?: number;
  readonly order?: string;
  readonly data?: string;
}

/** One record the projection asks for, by the identity that keys its row. */
export interface ConvexRecordKey {
  readonly kind: "chat" | "contact" | "group" | "alias" | "message" | "pendingUpdates";
  readonly id: string;
  readonly messageId?: string;
}

/** Every read, by name, with the arguments it takes and the answer it gives. */
export interface ConvexQueries {
  credentialRead: { args: { account: string; key: string }; result: string | null };
  begin: {
    args: { accountId: string; keys: readonly ConvexRecordKey[] };
    result: {
      readonly revision: number;
      readonly sourceSeq: number;
      readonly newestFencingToken: number;
      readonly account: string | null;
      readonly records: readonly (string | null)[];
    };
  };
  record: { args: { accountId: string } & ConvexRecordKey; result: string | null };
  snapshot: {
    args: { accountId: string };
    result: {
      readonly revision: number;
      readonly account: string | null;
      readonly chats: readonly string[];
      readonly contacts: readonly string[];
      readonly aliases: readonly { readonly nativeId: string; readonly contactId: string }[];
      readonly groups: readonly string[];
    };
  };
  messages: {
    args: { accountId: string; chatId: string; before?: string; limit: number };
    result: { readonly revision: number; readonly messages: readonly string[] };
  };
  accepted: {
    args: { accountId: string; afterSeq: number; limit: number };
    result: readonly {
      readonly seq: number;
      readonly fromRevision: number;
      readonly revision: number;
      readonly events: string;
      readonly patch: string;
    }[];
  };
  operationGet: {
    args: { accountId: string; operationId: string };
    result: { readonly now: number; readonly operation: string | null };
  };
  operationList: {
    args: { accountId: string };
    result: { readonly now: number; readonly operations: readonly string[] };
  };
}

/** The outcome shared by every write that a newer claim can refuse. */
type Committed = { readonly status: "ok" | "stale" | "conflict"; readonly currentToken: number };

/** Every write, by name, with the arguments it takes and the answer it gives. */
export interface ConvexMutations {
  credentialWrite: {
    args: {
      account: string;
      entries: readonly { readonly key: string; readonly value: string | null }[];
    };
    result: null;
  };
  credentialClear: { args: { account: string }; result: null };
  claimAccount: { args: { accountId: string; fencingToken: number }; result: Committed };
  commit: {
    args: {
      accountId: string;
      expectedSourceSeq: number;
      fencingToken: number;
      seq: number;
      fromRevision: number;
      revision: number;
      events: string;
      patch: string;
      writes: readonly ConvexRowWrite[];
    };
    result: Committed;
  };
  leaseAcquire: {
    args: { accountId: string; holderId: string; ttlMs: number };
    result:
      | { readonly acquired: true; readonly lease: AccountLease }
      | { readonly acquired: false; readonly heldUntil: number };
  };
  leaseRenew: {
    args: { accountId: string; holderId: string; fencingToken: number; ttlMs: number };
    result:
      | { readonly renewed: true; readonly lease: AccountLease }
      | { readonly renewed: false; readonly reason: "lost" | "expired" };
  };
  leaseRelease: {
    args: { accountId: string; holderId: string; fencingToken: number };
    result: boolean;
  };
  operationSubmit: {
    args: {
      accountId: string;
      operationId: string;
      idempotencyKey: string;
      input: string;
      canonicalInput: string;
    };
    result:
      | { readonly status: "created" | "existing"; readonly operation: string }
      | { readonly status: "conflict"; readonly operation: null };
  };
  operationWrite: {
    args: {
      accountId: string;
      writes: readonly {
        readonly operationId: string;
        readonly expectedRevision: number;
        readonly revision: number;
        readonly operation: string;
      }[];
    };
    result: { readonly status: "ok" | "conflict" };
  };
}

/** One account-independent way to reach the deployment. */
export interface ConvexCalls {
  query<Name extends keyof ConvexQueries>(
    name: Name,
    args: ConvexQueries[Name]["args"],
  ): Promise<ConvexQueries[Name]["result"]>;
  mutation<Name extends keyof ConvexMutations>(
    name: Name,
    args: ConvexMutations[Name]["args"],
  ): Promise<ConvexMutations[Name]["result"]>;
}

export interface LazyConvexClient extends ConvexCalls {
  /**
   * A call surface whose reads all answer from one moment.
   *
   * @remarks
   * What {@link WhatsAppDataStore.read} needs: a snapshot and a message page
   * taken separately arrive at two revisions, and reconciling that above the
   * store is unbounded (ADR-0030). A Convex client holds one timestamp across
   * every consistent read it makes, so a client created per read answers every
   * question in it from the same moment — including questions asked after a
   * concurrent write committed.
   */
  consistent(): Promise<ConvexCalls>;
  close(): Promise<void>;
}

interface ConvexHttpClientLike {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  consistentQuery(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Convex reads a deployment URL that looks nothing like a cloud one when it is
 * a local backend, so the shape check is off and the URL is the caller's.
 */
const clientOptions = { skipConvexDeploymentUrlCheck: true, logger: false } as const;

export interface ConvexClientOptions {
  readonly url: string;
  /** The Convex module the functions were re-exported from. */
  readonly module: string;
}

async function connect(url: string): Promise<ConvexHttpClientLike> {
  let ConvexHttpClient: new (address: string, options: typeof clientOptions) => unknown;
  try {
    ({ ConvexHttpClient } = (await import("convex/browser")) as unknown as {
      ConvexHttpClient: new (address: string, options: typeof clientOptions) => unknown;
    });
  } catch {
    throw new Error(
      "Convex requires the optional peer dependency 'convex'. Install it: npm i convex",
    );
  }
  return new ConvexHttpClient(url, clientOptions) as ConvexHttpClientLike;
}

export function lazyConvexClient(options: ConvexClientOptions): LazyConvexClient {
  const path = (name: string): string => `${options.module}:${name}`;
  let ready: Promise<ConvexHttpClientLike> | undefined;
  let closed = false;
  /** Calls still in flight, which `close` has to outlive. */
  const pending = new Set<Promise<unknown>>();

  const run = async <T>(work: (client: ConvexHttpClientLike) => Promise<unknown>): Promise<T> => {
    if (closed) throw new Error("the Convex backend is closed");
    const client = await (ready ??= connect(options.url));
    const call = work(client);
    pending.add(call);
    try {
      return (await call) as T;
    } finally {
      pending.delete(call);
    }
  };

  const surface = (pick: (client: ConvexHttpClientLike) => ConvexHttpClientLike): ConvexCalls => ({
    query: (name, args) => run((client) => pick(client).query(path(name), { ...args })),
    mutation: (name, args) => run((client) => pick(client).mutation(path(name), { ...args })),
  });

  const shared = surface((client) => client);

  return {
    ...shared,

    async consistent() {
      const pinned = await connect(options.url);
      return {
        query: (name, args) => run(() => pinned.consistentQuery(path(name), { ...args })),
        mutation: (name, args) => run(() => pinned.mutation(path(name), { ...args })),
      };
    },

    async close() {
      closed = true;
      // A close that resolved while a call was still landing would let a test
      // -- or a worker shutting down -- observe a write after teardown.
      await Promise.allSettled(pending);
    },
  };
}
