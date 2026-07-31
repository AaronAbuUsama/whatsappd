---
"whatsappd": minor
---

Persist one text message through the core runtime. `createWhatsAppRuntime()`
claims the required account lease before WhatsApp opens, records each durable
WhatsApp change in the accepted source log, projects it into the current
mirror, and publishes the resulting patch to clients only after that commits.
`createInProcessWhatsAppClient()` serves a snapshot followed by contiguous
revisioned patches, replacing state with a fresh snapshot when a revision gap
appears. Credentials, WhatsApp data, the account lease, and media bytes are
four separate capabilities grouped by `memoryBackend()`.

Acceptance carries its own cursor, identity, and claim (ADR-0018): a source
consumer follows `seq`, which advances for every batch, while `revision`
advances only when current state actually changed; each observation carries a
caller-assigned `eventId`, so a retry returns its original batch instead of
appending a duplicate; and a write from a superseded fencing token is rejected
at the acceptance boundary rather than reaching the mirror.

A storage failure stops processing with the original failure instead of being
skipped, and durable events with no projection yet reject with
`UnsupportedDurableEventError`.
