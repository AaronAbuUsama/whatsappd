---
status: accepted
---

# Acceptance has its own cursor, identity, and claim

ADR-0014 established that one transaction appends the source batch, projects
the current mirror, and stamps the account revision. Implementing it revealed
that the batch was carrying one number and one identity too few. This decision
amends that contract in three places; everything else in ADR-0014 stands.

## The source cursor and the mirror revision are separate numbers

Every accepted batch appends and advances a per-account `seq`. The mirror
`revision` (ADR-0011) advances only when the projection actually changed a
record, so a batch may commit with `revision === fromRevision`. Source
consumers follow `seq`; clients apply patches by `revision`.

ADR-0014 previously implied one number in both roles: each batch takes the next
revision, and consumers resume from a revision cursor. That forces a choice
between two defects, because whether an observation is _new_ and whether it
_changed current state_ are different facts:

- keep one number and skip no-delta batches — distinct observations vanish from
  the source log, which is the loss ADR-0014 exists to prevent;
- keep one number and stamp every batch — every duplicate delivery publishes a
  client patch that changes nothing, and a returning session that re-sends
  known history walks the revision forward for no reason.

## An observation is identified by its caller, not by its payload

Each `WhatsAppDataEvent` carries a caller-assigned `eventId`. Re-offering
accepted events returns their original batch instead of appending a second
copy.

Without it a store cannot tell a retry after an ambiguous backend result from
WhatsApp genuinely delivering the same thing twice: an identical payload at an
identical millisecond is evidence of neither. Payload equality answers a
different question — whether the mirror needs changing — and answering both
with it loses one of them.

The event carries no account of its own. The account named in the `accept()`
call is the only scope, so an event cannot disagree with the batch it arrives
in and no implementation has a second identifier to prefer by mistake.

## Durable acceptance carries the writer's fencing token

`accept()` takes the writer's current `AccountLease` fencing token, and a store
rejects a token below one it has already accepted for that account.

ADR-0009 requires the fencing token to prevent stale holders from writing
durable state, but a lease the acceptance boundary never sees cannot do that: a
worker that pauses past its TTL, loses the account, and resumes holding a
buffered event would still write. The token is therefore a number rather than
an opaque id — a store deciding whether a writer has been superseded has to
compare tokens, and string order ranks claim 10 below claim 9.

## Consequences

- Backends implement two monotonic counters per account. SQL gets a source-log
  primary key and a mirror version column rather than one shared sequence.
- A source consumer's committed cursor is a `seq`, not a revision. A consumer
  written against the earlier wording resumes at the wrong place.
- Idempotent ingestion becomes the caller's `eventId` contract, so a runtime
  that regenerates ids per attempt loses retry safety. Retries must re-offer
  the identifiers of the attempt they are retrying.
- The lease store must issue ordered numeric tokens, which a backend-side
  counter or sequence provides.
