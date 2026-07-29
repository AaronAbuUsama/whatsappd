---
status: accepted
---

# Connection readiness is separate from history bootstrap

The runtime models sendable connection state separately from history-bootstrap
state because reconnects may become online without emitting history batches.
Neither an absent batch nor a timeout may silently redefine connection
readiness or erase a previously durable mirror.
