---
"whatsappd": patch
---

Stabilize runtime teardown, lease renewal, session failure precedence, and
credential-file safety. Durable updates now remain in bounded accepted-source
pages, client watches close terminally, memory values are owned by the store,
and WhatsApp-delivered PN/LID equivalence consolidates contacts without deleting
source evidence. Accepted media edits retain restart-safe metadata without their
live download closure, credential clear removes migrated and untouched legacy
files across processes, and terminal-frame wrappers are isolated per observer.
