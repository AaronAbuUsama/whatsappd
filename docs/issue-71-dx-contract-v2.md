## Parent

#68, #15

## Plain-English outcome

An application can start a Runtime, create one Client, list chats/contacts/groups, open a conversation, subscribe to understandable state, and load older saved messages. It never handles snapshots, patches, revisions, paging cursors, or duplicate live/page messages itself.

Expected use:

```ts
await runtime.start();
const client = await createWhatsAppClient(runtime);

const conversation = await client.chats.open(chatId);
const unsubscribe = conversation.subscribe((state) => render(state));

await conversation.loadOlder();

unsubscribe();
conversation.close();
await client.close();
await runtime.stop();
await backend.close();
```

Client creation is asynchronous on purpose: when the Promise resolves, the initial durable snapshot has been applied. There is no separate `ready()` state and no “empty until hydration happens” ambiguity.

## Why this issue exists

The current exported `WhatsAppClient` is a low-level feed with `watch()` and `messages()`. Applications must:

- apply snapshot and patch records;
- detect revision gaps;
- replace state after a gap;
- merge live message upserts with stored pages;
- deduplicate by message identity;
- expire connection and presence observations;
- cancel page reads and subscriptions.

That is shared SDK behavior, not application behavior. ADR-0023 assigns it to the framework-independent Client once, below React and OpenTUI.

## Release target

Required for 0.3.

## Blocked by

- #70

## Architecture already decided

### Public surface

`WhatsAppClient` becomes the friendly interface below. `createInProcessWhatsAppClient`, `WhatsAppClientFrame`, raw `watch()`, raw `messages()`, patches, accepted-source records, and Runtime `onFrame()` are not exported as 0.3 application interfaces.

The implementation may retain an internal Runtime-to-Client source, but it must be module-private. `createWhatsAppClient(runtime)` is the only root factory for application state.

The public target is equivalent to:

```ts
export interface SubscriptionOptions {
  readonly signal?: AbortSignal;
}

export interface WhatsAppAccountState {
  readonly record: AccountRecord;
  readonly connection?: WhatsAppClientConnectionState;
  readonly identity?: WaIdentity;
  readonly closed?: { readonly error?: unknown };
}

export interface WhatsAppConversationState {
  readonly chatId: string;
  readonly chat?: ChatRecord;
  readonly messages: readonly MessageRecord[]; // newest first
  readonly presence: readonly PresenceUpdate[];
  readonly loadingOlder: boolean;
  readonly hasOlderSaved: boolean;
  readonly error?: unknown;
}

export interface WhatsAppConversation {
  readonly chatId: string;
  get(): WhatsAppConversationState;
  subscribe(
    listener: (state: WhatsAppConversationState) => void,
    options?: SubscriptionOptions,
  ): Unsubscribe;
  loadOlder(): Promise<void>;
  close(): void;
}

export interface WhatsAppClient {
  readonly account: {
    get(): WhatsAppAccountState;
    subscribe(
      listener: (state: WhatsAppAccountState) => void,
      options?: SubscriptionOptions,
    ): Unsubscribe;
  };

  readonly chats: {
    list(): readonly ChatRecord[];
    get(chatId: string): ChatRecord | undefined;
    subscribe(
      listener: (chats: readonly ChatRecord[]) => void,
      options?: SubscriptionOptions,
    ): Unsubscribe;
    open(chatId: string, options?: { readonly pageSize?: number }): Promise<WhatsAppConversation>;
  };

  readonly contacts: {
    list(): readonly ContactRecord[];
    get(contactId: string): ContactRecord | undefined;
    resolve(nativeId: string): ContactRecord | undefined;
    subscribe(
      listener: (contacts: readonly ContactRecord[]) => void,
      options?: SubscriptionOptions,
    ): Unsubscribe;
  };

  readonly groups: {
    list(): readonly GroupRecord[];
    get(groupId: string): GroupRecord | undefined;
    subscribe(
      listener: (groups: readonly GroupRecord[]) => void,
      options?: SubscriptionOptions,
    ): Unsubscribe;
  };

  close(): Promise<void>;
}

export function createWhatsAppClient(runtime: WhatsAppRuntime): Promise<WhatsAppClient>;
```

Names may change only to match existing domain vocabulary or TypeScript conflicts; do not alter the behavior or add a generic selector/query interface.

Subscriptions call the listener only after a value changes. The caller reads the initial value with `get()`/`list()` after the awaited factory/open call. Every subscription returns one idempotent cleanup function and accepts an `AbortSignal`.

### Ownership and lifetimes

- The application creates and closes Backend, Runtime, and Client independently.
- `client.close()` aborts the internal feed, every namespace subscription, every page read, and every opened conversation.
- Client close never stops Runtime, closes Backend, clears credentials, unlinks, or deletes messages.
- `conversation.close()` cancels that conversation only and is idempotent.
- Methods on a closed Client/conversation fail with one exported typed closed-resource error; do not silently reopen.
- Listener failures are application failures and must not corrupt Client state or stop the Runtime. Notify remaining listeners and surface the thrown value asynchronously rather than routing it into durable acceptance.

### State rules

The Client owns Maps keyed by existing record identity:

- chat: `chatId`;
- contact: `contactId`, plus the snapshot’s PN/LID alias map;
- group: `groupId`;
- opened conversation message: `(chatId, messageId)`.

Published list ordering is deterministic:

- chats: `lastMessageAt DESC, chatId ASC`;
- contacts: `contactId ASC`;
- groups: `groupId ASC`;
- conversation messages: `timestamp DESC, messageId DESC`.

Apply a patch only when `patch.fromRevision` equals the current revision. Ignore a patch whose `revision` is already applied. A future/mismatched base triggers one fresh Runtime snapshot; replace account/chat/contact/group/alias state rather than layering it over stale state.

Connection and presence are live only:

- retain the latest observation until its supplied `expiresAt`;
- remove it at expiry and notify affected subscribers;
- never reconstruct it from `AccountRecord.lastConnectedAt` or `lastSeenAt`;
- a new connection/presence observation replaces the timer for the same subject;
- an `unavailable` presence removes that subject immediately.

Expose the connected account identity from the underlying Session only while known. Add optional `identity(): WaIdentity | undefined` to the internal `RuntimeSession` interface and sample it through the module-private Runtime source; do not make applications reach into Session.

### Opened-conversation algorithm

`chats.open(chatId, { pageSize = 25 })`:

1. validate `pageSize` as a positive integer;
2. register the conversation with the Client before starting the page read, so live upserts cannot be missed;
3. read the newest stored page;
4. merge the page and any buffered live message upserts by `messageId`;
5. order using `timestamp DESC, messageId DESC`;
6. expose `hasOlderSaved` from the returned `nextBefore`;
7. resolve only after this coherent state exists.

`loadOlder()`:

- performs at most one page request at a time; concurrent calls join the same Promise;
- no-ops when `hasOlderSaved` is false;
- reads using the current saved cursor;
- merges, never appends blindly;
- reconciles a message that appeared live and in the page into one record;
- keeps a live backdated insertion in its correct order;
- on failure leaves the previous messages/cursor intact, records `error`, and permits an explicit later retry;
- never contacts WhatsApp. #108 adds the separate manual phone-history operation.

When the Client detects a revision gap, each open conversation re-reads its loaded window from newest storage before publishing replacement state. Request `max(pageSize, currentlyLoadedCount)` records, replace the saved/live collection by identity, and retain no stale message that the fresh read no longer returns. This is the message-window equivalent of snapshot replacement.

Message upserts route only to the matching open conversation. A revocation tombstone from #70 replaces the visible message. Contact deletes update aliases and lists; no other delete kind is invented here.

## Exact implementation surface

Expected product files:

- new `src/runtime/client.ts`: friendly Client state and opened-conversation implementation;
- `src/runtime/contracts.ts`: friendly public interfaces; raw feed types become internal or move out;
- `src/runtime/runtime.ts`: register a module-private Client source for Runtime instances and expose Session identity internally;
- `src/index.ts`: export `createWhatsAppClient` and friendly types; remove raw Client/frame exports and `createInProcessWhatsAppClient`;
- `src/testing.ts`: only the minimum deterministic driver additions needed to emit identities/gaps through a real Runtime.

Expected tests:

- new `tests/client.test.ts` for public Client behavior;
- existing `tests/runtime.test.ts` only for lower-level Runtime regressions that remain Runtime-owned;
- `tests/libsql-backend.test.ts` for genuinely replaced Client/Runtime/backend reconstruction;
- `tests/packed-imports.ts` for the hard-cut public surface.

Do not introduce Redux, Zustand, RxJS, EventEmitter, a generic cache, a generic normalized-store framework, or a second projection reducer.

## TDD execution order

1. **First tracer:** start a real deterministic Runtime containing two chats, await `createWhatsAppClient`, and prove `chats.list/get/subscribe` without reading a frame.
2. Add contacts, PN/LID `resolve()`, groups, and account durable state.
3. Open one chat: newest stored page plus one live message, merged once and correctly ordered.
4. Add a page/live identity collision and a backdated live insertion.
5. Add `loadOlder()`, cursor exhaustion, concurrent-call joining, and failure/retry without state loss.
6. Add contiguous patch application, stale-patch ignore, and a deliberately gapped Runtime acceptance that forces snapshot replacement.
7. Keep a conversation open across that gap and prove its loaded window is re-read rather than layered.
8. Add connection expiry, presence expiry/replacement/unavailable, and prove restart does not hydrate either as current.
9. Add conversation close, Client close, AbortSignal cancellation, in-flight page cancellation, and typed use-after-close failures.
10. Close every first instance; create a genuinely new libSQL backend, Runtime, and Client; assert the same durable account/chat/contact/group/conversation state and no reconstructed live presence/connection.
11. Update packed-export assertions last.

Each slice is one red public behavior followed by the minimum green implementation.

## Acceptance criteria

- [ ] Awaited Client creation returns hydrated account/chat/contact/group state.
- [ ] Applications never handle frames, snapshots, patches, revisions, or stored-page cursors directly.
- [ ] `chats.open()` produces one coherent saved/live message collection.
- [ ] Page/live collisions and backdated insertions produce one correctly ordered message per identity.
- [ ] Revision gaps replace global state and every open conversation window from fresh Runtime reads.
- [ ] Connection and presence expire and never hydrate as current truth.
- [ ] PN/LID alias consolidation is transparent through `contacts.resolve()`.
- [ ] Close and AbortSignal semantics release subscriptions/page reads without stopping application-owned Runtime/backend.
- [ ] A genuinely new libSQL backend/Runtime/Client reconstructs identical durable state.
- [ ] Root and packed declarations expose the friendly Client and no raw-frame Client interface.

## Public test seam and proof

- Public seam: `createWhatsAppClient(runtime)` and its namespaces/controllers.
- P1 deterministic Client behavior through a real Runtime.
- P2 real libSQL replacement, paging collisions, and resource ownership.
- SQL may cross-check identities/revisions only after Client assertions.

## Required validation

`pnpm test`, `pnpm check`, `pnpm build`, `pnpm proof:pack`, `pnpm audit --prod`, and `git diff --check`.

## Non-goals

React, durable side effects, pairing secrets, application authentication, HTTP transport, automatic history scheduling, background media jobs, backend shutdown ownership, styling, or a general application state framework.
