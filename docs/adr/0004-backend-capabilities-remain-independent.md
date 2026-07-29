---
status: accepted
---

# Backend capabilities remain independent

Credentials, current data, commands, and account leases remain separate
capabilities with independent contracts. A PocketBase, Convex, or SQL backend
factory may provide them together for convenience without making them one
lifecycle or requiring every deployment to use the same backend for all four.
