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

Acceptance carries its own cursor and claim (ADR-0018): a source consumer
follows `seq`, which advances for every batch, while `revision` advances only
when current state actually changed; and a write from a superseded fencing
token is rejected at the acceptance boundary rather than reaching the mirror.

A storage failure stops processing with the original failure instead of being
skipped. This slice projects text messages and the chats they belong to; a
store rejects unknown durable event kinds with `UnsupportedDurableEventError`
rather than dropping them. Modeled updates without a current projection remain
accepted source evidence and advance `seq` without advancing the mirror
revision. What the runtime observes is accepted whole: a conversation sync's
contacts are retained alongside the batch's other normalized events. A watch
ends with a `closed` frame when the runtime stops — carrying the failure when
the session died rather than being stopped — so a consumer is never left
waiting on an account nothing is consuming.

`AccountNotHeldError` reports a runtime acting on an account whose claim it
never took, has let lapse, or gave back to a stop; the store's
`StaleAccountClaimError` remains the boundary that can see a newer claim.
`createTestWhatsAppSession()` now offers `start()` and `stop()`, so a
deterministic session ends on a handler failure exactly as a live one does.
