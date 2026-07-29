---
status: accepted
---

# The account lease is required

`WhatsAppBackend` requires the lease capability, and the runtime acquires the
account lease before opening Baileys. Two live sockets on one account diverge
Signal ratchet state and can corrupt credentials, so a double-start must fail
closed with `AccountAlreadyClaimedError` rather than race; an opt-out would
invite exactly that accident, and a compare-and-swap row with a TTL heartbeat
is cheap in every supported backend. The memory backend provides an in-process
lease for tests and single-process composition.
