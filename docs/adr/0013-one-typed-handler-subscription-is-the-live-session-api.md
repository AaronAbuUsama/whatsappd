---
status: accepted
---

# One typed handler subscription is the live session API

`session.subscribe({ ...handlers })` is the session’s only live event-consumption
surface. A consumer supplies any subset of typed handlers in one registration,
receives one unsubscribe handle, and may use an `AbortSignal`. Matching
asynchronous handlers across all subscriptions are awaited before the session
accepts the next normalized event; rejection fails the processing pipeline
rather than being logged and skipped.

The seven per-category streams, seven `onX` methods, and bound
`IncomingMessage.reply` shape are removed without compatibility wrappers. A
message handler receives pure `InboundMessage` plus a session-local reply action
in callback context.

The ordered `WhatsAppEvent` union remains an internal normalization and durable
source-record type. It is not a second public live-consumption API.

## Considered options

- **Retain seven `onX` methods**: rejected because a complete consumer owns
  seven registrations and cleanups, while the API conceals their shared order.
- **`on("message", handler)`**: rejected because EventEmitter convention implies
  fire-and-forget delivery, whereas this contract deliberately awaits
  backpressure.
- **Public async iterable union**: rejected as the primary DX because ordinary
  consumers must switch over infrastructure variants and coordinate iterator
  startup, fan-out, and cancellation.

## Consequences

- Slow handlers deliberately backpressure live ingestion; persistence and media
  capture dominate the negligible dispatcher cost.
- `whatsappd/testing` supplies a deterministic session driver whose `emit()`
  resolves only after matching handlers complete, records outbound commands,
  and requires neither WhatsApp nor sleeps nor application-built session fakes.
- Old applications may remain pinned to an old whatsappd version. Upgrading is
  a hard migration to the new API.
