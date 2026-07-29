---
status: accepted
---

# Headless React owns WhatsApp state, not chat presentation

`@whatsappd/react` owns WhatsApp Client synchronization, snapshot and patch
state, saved paging, explicit history-backfill state, commands, reconciliation,
typing expiry, read batching, selectors, hooks, and render slots. It renders no
DOM or CSS and takes no hard dependency on a component library.

The preferred proof consumer composes those slots with shadcn's general chat
primitives. `@shadcn/react/message-scroller` owns transcript anchoring,
live-edge following, prepend preservation, message jumping, and visibility.
Application-owned `Message`, `Bubble`, `Attachment`, and `Marker` registry
components own presentation.

## Considered options

- **Reimplement scrolling inside whatsappd**: rejected because the existing
  primitive already owns the hard generic interaction behavior without owning
  messages, transport, persistence, or model state.
- **Make shadcn a hard dependency**: rejected because applications may choose
  another renderer and shadcn registry components are application-owned source.
- **Shape WhatsApp as AI SDK messages**: rejected because assistant roles,
  streamed model parts, reasoning, and tool calls are not WhatsApp's domain
  model.

## Consequences

- Stable WhatsApp message identities and paging semantics compose directly with
  transcript-row identities and prepend preservation.
- Browser acceptance tests the integration rather than duplicating shadcn's
  internal scroll suite.
- The same headless React surface must work against PocketBase and Convex by
  changing only the client at the composition root.
