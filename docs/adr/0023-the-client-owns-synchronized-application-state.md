---
status: accepted
---

> Amended by #106's design decision of 2026-08-03: the opened-conversation
> controller returned by `chats.open(chatId)` is retired unbuilt. Four
> independent designs were produced for it; three concluded the handle was what
> made `docs/issue-71-postmortem.md` §2's retired per-`open()` state _typeable_,
> and the fourth — briefed to defend it — agreed. Message state is now a fifth
> namespace read by chat id, with no handle, no `open()` and no per-chat
> `close()`. Everything else below stands: the Client still owns hydration,
> patch application, gap replacement, page reconciliation by message identity,
> connection freshness and short-lived presence.
>
> Extended by ADR-0028 and ADR-0029, which specify the mechanism this decision
> only assigns: live state is derived rather than committed, and the Client
> commits every affected value through one non-`async` boundary and notifies once
> from committed state. The independent-lifetime model below stands — the
> application still owns Backend, Runtime and Client. A Client that owns its own
> account lifecycle is a separate, additive decision and is not yet accepted.

# The Client owns synchronized application state

The framework-independent WhatsApp Client is the application-facing owner of
snapshot hydration, contiguous patch application, revision-gap replacement,
stored-page reconciliation by message identity, connection freshness,
short-lived presence, ~~opened-conversation state~~ retained messages per chat, operation results, and
resource cancellation. Applications consume named domain state and actions;
they do not merge Snapshot Windows, patches, pages, or source batches.

The Client is organized into stable domain namespaces, one of which owns a
chat's saved messages, its live upserts and its paging state. That namespace is
read by chat id and extended backwards by chat id; it hands out no per-chat
controller and has no per-chat lifetime to close.
The raw snapshot, patch, accepted-source, lease, credential, and transport
surfaces remain lower-level runtime and backend contracts.

`@whatsappd/react` binds this Client to React. It owns provider lifetime,
subscriptions, selectors, hooks, and behavior-only render-slot Modules that are
genuinely shared by React consumers. It does not implement a second WhatsApp
state store. The same package serves browser React and OpenTUI React; each
renderer owns its presentation, scrolling primitive, accessibility integration,
and platform effects.

## Considered options

- **Flat methods on one Client**: rejected because unrelated account, chat,
  group, community, channel, business, and operation capabilities become an
  unsearchable collection and collisions accumulate as coverage grows.
- **One universal command executor**: rejected as the public surface because
  string command names and generic payloads erase discoverability and useful
  TypeScript results. A universal envelope may remain internal to durable
  command storage.
- **Namespaced Client with ~~opened conversations~~ a retained-messages namespace**: accepted because it gives
  callers domain-shaped discovery while concentrating message paging and live
  reconciliation in the one object that needs it.
- **Let every UI binding reconcile runtime frames**: rejected because React,
  OpenTUI, and non-React consumers would reproduce one correctness-critical
  state machine.

## Operation and lifetime semantics

Reads return current domain values. Subscriptions return one cleanup function
and also accept an `AbortSignal`. Durable side effects accept an optional
application idempotency key and return an account-scoped operation receipt.
Receipts distinguish queued, claimed, executing, succeeded, failed, and
`outcome_unknown`; execution that may have reached WhatsApp is never retried
under the same operation identity.

When the key is omitted the Client generates one and returns it on the receipt;
separate keyless calls remain separate operations. Reusing a key with the same
canonical input returns the existing receipt, while different input is a
conflict. Operation inputs carry an explicit version. New payload shapes extend
an existing version only when old executors can still interpret them; new
execution semantics require a new version and an explicit executor case.

`wait()` and its `AbortSignal` control only the caller's wait after submission;
they never cancel durable work. Terminal receipts remain until acknowledged.
Typing is excluded from durable operations because replaying stale presence
after restart is incorrect; it remains an awaited live Session command.

`client.close()` releases all Client subscriptions ~~and opened conversations~~ but
does not implicitly stop an application-owned Runtime or close an
application-owned Backend. Each resource is closed by the layer that created
it. ~~Closing an opened conversation cancels its page reads and subscriptions; it
does not delete stored messages or leave the WhatsApp chat.~~ There is nothing
per-chat to close: retained messages are released when a revision gap replaces
durable state (`client.ts:939`).

Closing the Client ends every page read still in flight, without applying its
rows, and releases its subscriptions (`client.ts:1214-1229`). It does not empty
what is already held: a closed Client is finished rather than emptied, and
`messages.get(chatId)` still answers from the rows it had. `messages.older()` is
already a no-op once closed and does not even allocate an entry
(`client.ts:1142-1147`).

> Amended 2026-08-04. This paragraph previously said retained messages are
> released "when durable state is replaced **or the Client closes**". The second
> half was never implemented — `retained.clear()` runs only in the revision-gap
> path — and no test asserted either behaviour. Whether a closed Client _should_
> drop what it holds is a retention question, not a decision this ADR settled;
> it belongs to #121 and is filed there.

## Consequences

- React and OpenTUI share WhatsApp behavior without sharing presentation.
- Non-React applications receive the same friendly synchronized state rather
  than a lower-level protocol.
- Browser and OpenTUI verification statuses remain separate because they
  exercise different renderers and platform behavior.
- ADR-0016 is superseded. ADR-0026 governs verification claims.
