---
status: accepted
---

# Backend capabilities remain independent

Credentials, accepted/current data, commands, account leases, protected pairing
challenges, and durable media remain separate capabilities with independent
contracts. A PocketBase, Convex, or SQL backend factory may provide them
together for convenience without merging their lifecycles or requiring every
deployment to use one physical backend for every capability.
