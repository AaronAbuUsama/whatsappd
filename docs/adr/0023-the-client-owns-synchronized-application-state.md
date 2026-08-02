---
status: accepted
---

> Amended by ADR-0027. The Client now owns the Backend, hidden Runtime, Session,
> lease, and teardown for its WhatsApp Account; the independent-lifetime
> paragraph below records the superseded design.

# The Client owns synchronized application state

The framework-independent WhatsApp Client is the application-facing owner of
snapshot hydration, contiguous patch application, revision-gap replacement,
stored-page reconciliation by message identity, connection freshness,
short-lived presence, opened-conversation state, operation results, and
resource cancellation. Applications consume named domain state and actions;
they do not merge Snapshot Windows, patches, pages, or source batches.

The Client is organized into stable domain namespaces. `chats.open(chatId)`
returns an opened-conversation controller that owns one chat's saved messages,
live upserts, paging state, presence, and message actions until it is closed.
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
- **Namespaced Client with opened conversations**: accepted because it gives
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

`client.close()` releases all Client subscriptions and opened conversations but
does not implicitly stop an application-owned Runtime or close an
application-owned Backend. Each resource is closed by the layer that created
it. Closing an opened conversation cancels its page reads and subscriptions; it
does not delete stored messages or leave the WhatsApp chat.

## Consequences

- React and OpenTUI share WhatsApp behavior without sharing presentation.
- Non-React applications receive the same friendly synchronized state rather
  than a lower-level protocol.
- Browser and OpenTUI verification statuses remain separate because they
  exercise different renderers and platform behavior.
- ADR-0016 is superseded. ADR-0026 governs verification claims.
