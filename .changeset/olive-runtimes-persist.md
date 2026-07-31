---
"whatsappd": minor
---

Persist one text message through the core runtime. `createWhatsAppRuntime()`
claims the required account lease before WhatsApp opens, accepts each durable
WhatsApp change into the current mirror and the accepted source log under one
revision, and publishes the resulting patch only after that acceptance commits.
`createInProcessWhatsAppClient()` serves a snapshot followed by consecutively
revisioned patches. Credentials, WhatsApp data, the account lease, and media
bytes are four separate capabilities grouped by `memoryBackend()`. Replay is
idempotent, a storage failure stops processing instead of being skipped, and
durable events without a projection yet reject with
`UnsupportedDurableEventError`.
