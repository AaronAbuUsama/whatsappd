---
status: accepted
---

# Account lifecycle rides the command queue

Pair and unlink are WhatsApp commands carried on the durable command queue,
not worker-local-only APIs: the runtime executes them and publishes pairing
challenges into runtime state, where a browser watches them like any other
mirror record. This gives linking — the most privileged account operation —
the same application-authorization surface as every other command instead of
per-application glue into the worker. Unlink performs a Baileys logout,
clears only that account’s credentials, and leaves the mirror intact. The
worker-local `runtime.pair()` remains for bootstrap composition.
