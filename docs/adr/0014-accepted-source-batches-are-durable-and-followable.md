---
status: accepted
---

# Accepted source batches are durable and followable

> Amended by ADR-0018: a batch's cursor and the mirror revision are separate
> numbers, and acceptance takes the writer's fencing token. Amended by ADR-0020:
> the _instant_ an ephemeral signal was observed at is durable, while the status
> it carried is still not. Everything below still holds.

The data store durably appends each normalized, non-ephemeral source batch,
projects that batch into the current mirror, and stamps its next account
revision in one backend transaction. Only then may the runtime publish the
resulting client patch. A failed acceptance is retried or fails closed; it is
never logged and skipped.

Backend consumers may follow accepted source batches from a consumer-owned
revision cursor. This is the Ambient Brain boundary: messages, edits,
reactions, receipts, and revocations remain distinct source observations even
though the client mirror projects their current state.

The reader is bounded: callers supply the last consumed `seq` and an optional
positive page size (default 100). A source-only observation advances `seq` even
when it takes no mirror revision, so catch-up never depends on patch production.

## Considered options

- **Memory-only pause and retry**: rejected as a lossless guarantee because the
  current channel buffer disappears on process crash and can grow without
  bound.
- **Brain consumes live session callbacks**: rejected because a disconnected
  Brain cannot recover missed observations.
- **Brain reconstructs events from mirror patches**: rejected because edits and
  revocations overwrite current state and cannot reproduce source history.

## Consequences

- The accepted-source log and current mirror are two projections with different
  retention and read semantics; they are committed at one acceptance boundary.
- Durable acceptance begins at the backend transaction. A process can still die
  after the protocol delivers an event but before any local transaction begins;
  live fault-injection must define the remaining protocol replay boundary.
- Presence and connection state are not appended because replaying stale
  typing, availability, `online`, or pairing status would manufacture current
  state. Connection state is live and expiry-aware; durable account lifecycle
  facts remain in runtime state.
- A media edit retains normalized message metadata, not its live `download()`
  closure. The closure cannot survive serialization or a restart; ADR-0015 and
  #21 own durable byte capture while the handle is still usable.
