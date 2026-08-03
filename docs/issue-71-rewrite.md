## Parent

#68, #15

## Blocked by

- #70
- #96 — revision-pinned joint read on `WhatsAppDataStore`
- #97 — split live and durable frame channels, and fix `publish()`
- #98 — carry the alias delta and freed native ids on the patch

Each substrate ticket lands on `master` before this issue's first implementation
slice opens. Each removes a mechanism this Client would otherwise have to grow.

## Plain-English outcome

An application can start a Runtime, create one Client, list chats/contacts/groups,
open a conversation, subscribe to understandable state, and load older saved
messages. It never handles snapshots, patches, revisions, paging cursors, or
duplicate live/page messages itself.

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

Client creation is asynchronous on purpose: when the Promise resolves, the
initial durable snapshot has been applied. There is no separate `ready()` state
and no "empty until hydration happens" ambiguity.

## Why this issue exists

The current exported `WhatsAppClient` is a low-level feed with `watch()` and
`messages()`. Applications must:

- apply snapshot and patch records;
- detect revision gaps;
- replace state after a gap;
- merge live message upserts with stored pages;
- deduplicate by message identity;
- expire connection and presence observations;
- cancel page reads and subscriptions.

That is shared SDK behavior, not application behavior. ADR-0023 assigns it to
the framework-independent Client once, below React and OpenTUI.

## History, and what changed

Two implementations of this issue failed: PR #93 (closed unmerged) and PR #94
(closed unmerged, largest PR in this repository's recent history). They were not
two attempts — PR #94's first implementation commit is byte-identical to PR #93's
head, because a previous version of this issue instructed the implementer to
carry the retired unit forward. Eight review rounds produced 28 findings, 19 of
which were the same defect class recurring at a new site.

`docs/issue-71-postmortem.md` is the full investigation. Four of its conclusions
change this issue:

1. **The domain behaviour was never the problem.** Merging, ordering, paging and
   dedupe worked in the first commit and never regressed. `client.ts` grew
   549 → 859 lines across eight rounds while adding zero features; every added
   line was coordination.
2. **A previous version of this issue asserted a root cause that is falsified.**
   It blamed "no single lifecycle and transition authority". PR #94 built that
   authority and round 4 still filed two commit-boundary P1s. That claim is
   deleted rather than carried forward.
3. **Fixes that install a primitive generalise; fixes that impose an ordering do
   not.** One ordering rule ("commit before notify") was re-cut in four
   consecutive rounds across 17 notification sites. One primitive (`compareId`)
   fixed its whole class in round 1 and never recurred. This issue specifies
   primitives, not orderings.
4. **Some of the complexity is not fixable in the Client.** Three substrate
   properties are handled in their own tickets ahead of this one, and each
   removes a mechanism this Client would otherwise have to grow.

A previous version of this issue also deleted its own public contract and
replaced it with prose, then accumulated six acceptance criteria that were
review findings promoted to requirements. Those are gone. The contract below is
normative and frozen: it existed before any implementation, and it is
essentially what shipped and worked.

## Public contract

`WhatsAppClient` becomes the interface below. `createInProcessWhatsAppClient`,
`WhatsAppClientFrame`, raw `watch()`, raw `messages()`, patches, accepted-source
records, and Runtime `onFrame()` are not exported as 0.3 application interfaces.

The implementation may retain an internal Runtime-to-Client source, but it must
be module-private. `createWhatsAppClient(runtime)` is the only root factory for
application state.

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

Names may change only to match existing domain vocabulary or resolve TypeScript
conflicts. Do not alter the behavior and do not add a generic selector or query
interface.

Subscriptions call the listener only after a value changes. The caller reads the
initial value with `get()`/`list()` after the awaited factory or `open()` call.
Every subscription returns one idempotent cleanup function and accepts an
`AbortSignal`.

## Semantics

### The update loop is pull, with one publication point

The Client consumes `WhatsAppRuntime`'s existing durable frame stream as an
async iterable, one iteration per frame. It does not subscribe to the raw
listener primitive and re-derive subscribe-before-snapshot, revision cursors,
gap detection, awaitable cancellation, or terminal close — those already exist
and are already tested.

All state affected by one iteration is committed through a single
non-`async` commit function:

```ts
function commit(mutate: (tx: Tx) => void): void; // cannot await ⇒ cannot yield
```

Because it cannot yield to the event loop, no application code, no timer and no
concurrent `open()` can interleave inside a transition. "Everything is committed
before anyone is notified" is a property of the type signature, not a rule
re-established at each call site. There is exactly one notification point per
iteration.

ADR-0029 records this decision.

### Live state is a function of `(observation, now)`

Connection and presence are live only: retained until the supplied `expiresAt`,
never reconstructed from `AccountRecord.lastConnectedAt` or `lastSeenAt`,
replaced by a newer observation for the same subject, and removed immediately by
an `unavailable` presence.

Their current value is **derived at read time from the stored observation and
the current instant**. Live state is never committed as a separate transition,
and no timer is required for correctness — a timer that fires late, early, or
not at all can delay a notification but can never make a read wrong.

One instant is sampled per delivery and used for every listener in that
delivery, so a deadline falling mid-fanout cannot give two listeners different
views of one transition.

ADR-0028 records this decision and supersedes the previous requirement that
expiry be revalidated per listener against a re-read clock.

### An opened conversation is a handle onto one shared window

All handles for one `chatId` share one message window, one paging cursor, one
in-flight page read and one presence view. `chats.open()` returns a distinct
handle object each call; the handle owns its own listeners and its own
`close()`, which is idempotent and does not affect other handles. The window is
released when the last handle closes.

Consequently the Client finds the affected window by key rather than by scanning
open conversations, and a shared `loadOlder()` failure is visible to every
handle on that chat.

ADR-0029 records this decision.

### What a listener may do

1. Listeners are called **after** the transition is fully committed. A listener
   may read any Client state and observes the completed transition.
2. Listener membership is **snapshotted before delivery**. Subscribing during a
   delivery takes effect on the next transition.
3. Unsubscribing during a delivery takes effect **immediately**: a listener
   unsubscribed mid-fanout is not called.
4. A throwing listener is rethrown asynchronously, **remains subscribed**, and
   does not affect other listeners or Client state.
5. Every listener in one delivery observes the **same instant** for live state.

Rules 2, 3 and 5 are implemented as primitives — a membership copy, a membership
check, and one sampled instant — not as ordering rules to remember.

### Ownership and lifetimes

- The application creates and closes Backend, Runtime, and Client independently.
- `client.close()` aborts the internal feed, every namespace subscription, every
  page read, and every opened conversation.
- Client close never stops the Runtime, closes the Backend, clears credentials,
  unlinks, or deletes messages.
- `conversation.close()` releases that handle only and is idempotent.
- Methods on a closed Client or handle fail with one exported typed
  closed-resource error; they do not silently reopen.
- Runtime Closure is observable as account state.

A Client that owns its own Backend, Runtime, Session and lease behind one
factory is a real improvement and is **out of scope here** — it is #99, blocked
on this issue. Once the Client owns nothing, that factory is a thin additive
wrapper.

### State rules

The Client owns Maps keyed by existing record identity: chat by `chatId`;
contact by `contactId` plus the PN/LID alias map; group by `groupId`; opened
conversation message by `(chatId, messageId)`.

Published list ordering is deterministic and every sort site routes through one
comparison primitive:

- chats: `lastMessageAt DESC, chatId ASC`;
- contacts: `contactId ASC`;
- groups: `groupId ASC`;
- conversation messages: `timestamp DESC, messageId DESC`.

Ordering must agree with the stores' binary ordering; `localeCompare` is not
used for identifiers.

Apply a patch only when `patch.fromRevision` equals the current revision. Ignore
a patch whose `revision` is already applied. A future or mismatched base
triggers one fresh snapshot; replace account/chat/contact/group/alias state
rather than layering it over stale state.

Expose the connected account identity from the underlying Session only while
known. Add an optional `identity(): WaIdentity | undefined` to the internal
`RuntimeSession` interface and sample it through the module-private Runtime
source; applications do not reach into Session.

### Opened-conversation algorithm

`chats.open(chatId, { pageSize = 25 })`:

1. validate `pageSize` as a positive integer;
2. if a window for `chatId` exists, return a new handle onto it;
3. otherwise register the window with the Client before starting the page read,
   so live upserts cannot be missed;
4. read the newest stored page **at the same revision as the Client's committed
   state**, using the substrate's joint read;
5. merge the page and any buffered live message upserts by `messageId`;
6. order using `timestamp DESC, messageId DESC`;
7. expose `hasOlderSaved` from the returned `nextBefore`;
8. resolve only after this coherent state exists.

`loadOlder()`:

- performs at most one page request at a time per window; concurrent calls from
  any handle join the same Promise;
- no-ops when `hasOlderSaved` is false;
- reads using the current saved cursor;
- merges, never appends blindly;
- reconciles a message that appeared live and in the page into one record;
- keeps a live backdated insertion in its correct order;
- on failure leaves the previous messages and cursor intact, records `error`,
  and permits an explicit later retry;
- never contacts WhatsApp. #22 adds the separate manual phone-history operation.

When the Client detects a revision gap, each open window re-reads from newest
storage before publishing replacement state. Request
`max(pageSize, currentlyLoadedCount)` records, replace the saved/live collection
by identity, and retain no stale message the fresh read no longer returns. This
is the message-window equivalent of snapshot replacement.

Message upserts route only to the matching open window. A revocation tombstone
from #70 replaces the visible message. Contact deletes update aliases and lists;
no other delete kind is invented here.

## Acceptance criteria

Each is a property of the finished system, checkable against the contract above.
None names a specific past defect.

- [ ] Awaited Client creation returns hydrated account/chat/contact/group state;
      there is no `ready()` and no window in which the Client is observably empty.
- [ ] Applications never handle frames, snapshots, patches, revisions, or
      stored-page cursors — verified against the declared surface and the packed
      declarations.
- [ ] Every listener in one delivery observes the same committed state and the
      same instant.
- [ ] Listener membership is snapshotted before delivery; subscribing during a
      delivery takes effect next transition; unsubscribing during a delivery
      takes effect immediately; a throwing listener stays subscribed and does not
      affect other listeners.
- [ ] Live state is unavailable at its expiry on every read, whether or not a
      timer has fired. No timer is required for correctness.
- [ ] All handles for one `chatId` share one window, one cursor and one in-flight
      page read; each handle's `close()` is independent and idempotent; the
      window is released when the last handle closes.
- [ ] Saved/live collisions and backdated insertions produce one correctly
      ordered message per identity.
- [ ] Paging is stored-only, single-flight, retryable after failure, and
      cursor-free for applications; "no older saved" never asserts "no more
      WhatsApp history".
- [ ] A revision gap replaces global state and every open window from fresh
      reads, retaining no stale record.
- [ ] PN/LID Address Resolution is transparent through `contacts.resolve()`.
- [ ] `close()` and `AbortSignal` release subscriptions, page reads and
      conversations without stopping the application-owned Runtime or Backend.
- [ ] A genuinely new libSQL process reconstructs identical durable state and no
      live connection or presence — proven by a positive artifact naming two
      distinct process ids, not by the absence of an error.
- [ ] Root and packed declarations expose the friendly Client and no raw-frame
      Client interface.

## Implementation slices

Each slice is a separate PR that merges on its own. **No slice exceeds 400
changed lines.** A slice over budget is split, not reviewed. There is no
requirement that any particular slice carry forward earlier code, and no
implementation may import the retired PR #93/#94 `client.ts`.

| #   | Slice                              | Contains                                                                                                                                             | Budget |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| c1  | Publication primitive + namespaces | non-`async` `commit()`, the pull loop, one notification point, the five listener rules, `account`/`chats`/`contacts`/`groups`. **No conversations.** | ~250   |
| c2  | Opened conversations               | shared window, handles, joint read at one revision, live upsert merge, ordering                                                                      | ~150   |
| c3  | Paging                             | `loadOlder()`, single-flight join, cursor exhaustion, failure and explicit retry                                                                     | ~100   |
| c4  | Revision gaps                      | global replacement, per-window re-read, no stale retention                                                                                           | ~80    |
| c5  | Lifetimes                          | `close()`, `AbortSignal`, use-after-close typed errors, handle refcounting                                                                           | ~60    |
| c6  | Hard cut                           | root and packed export surface, documentation                                                                                                        | ~40    |

c1's shape must survive c2–c5; that is the one integration risk and it is why c1
is reviewed alone before conversations exist.

## Testing decisions

- The public test seam is `createWhatsAppClient(runtime)` and its namespaces and
  handles. SQL cross-checks are permitted only after public assertions.
- **The test matrix is written before the implementation of each slice**, from
  this issue's properties. Tests added in response to a review finding are
  recorded as such; a slice whose tests are majority-reactive has not been
  designed.
- Cells that must exist and did not previously: `unsubscribe()` from inside a
  listener; `subscribe()` during fanout; unsubscribing a _different_ listener
  during fanout; two handles on one chat; `chats.open()` from inside a listener;
  presence expiry observed by two handles; a deadline crossing mid-fanout.
- Deterministic Runtime and Backend adapters are permitted only at their real
  external seams.
- Cancellation tests use stalled promises and late results, not
  immediately-resolving fakes.

## Proof

- P1 deterministic Client behaviour through a real Runtime.
- P2 real libSQL process replacement, paging collisions, resource release.
- **Every proof asserts a positive artifact produced by the behaviour under
  test.** "The command did not throw" is not evidence. The process-replacement
  proof has each child write a receipt; the parent asserts two distinct process
  ids, neither equal to its own, and equal reconstructed state. A child that
  skips execution produces no receipt and the proof fails red.
- Child processes are launched with an explicit environment allowlist, never a
  spread of the parent's environment.
- Independence is counted, not assumed: one local run plus two CI Node versions
  is **one** confirmation of behaviour, not three.

## Required validation

`pnpm test`, `pnpm check`, `pnpm build`, `pnpm proof:pack`, `pnpm audit --prod`,
`git diff --check`, Node 22 and Node 24 CI.

## Non-goals

React, OpenTUI, commands or sending, phone-history requests, durable side
effects, background media jobs, pairing secrets, application authentication,
HTTP transport, automatic history scheduling, backend shutdown ownership,
styling, a Client-owned account lifecycle (#99), and any general application
state framework.

Do not introduce Redux, Zustand, RxJS, EventEmitter, a generic cache, a generic
normalized-store framework, or a second projection reducer (ADR-0013, ADR-0023).
No new runtime dependency is needed for any mechanism above; `AbortSignal.any`
is available on both supported Node versions and replaces hand-rolled
`Promise.race` triples.

Note for implementers: `AsyncDisposableStack` and `await using` are unavailable
on Node 22.12.0 and no flag enables them, and `--experimental-strip-types` erases
types without transforming syntax. Take the resource-stack _shape_ — LIFO async
closures, aggregated errors, idempotent dispose — not the syntax.
