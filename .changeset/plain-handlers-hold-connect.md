---
"whatsappd": patch
---

Document that subscriber handlers run on the session's own event pipeline, so a
handler that never returns holds the connection at `authenticated`/`draining`
instead of merely delaying events. No behavior changes; the serialization is the
ordering guarantee.
