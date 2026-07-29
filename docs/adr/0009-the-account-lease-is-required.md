---
status: accepted
---

# The account lease is required

`WhatsAppBackend` requires an account-scoped lease capability, and the runtime
acquires that lease before opening Baileys. Two workers may run different
accounts concurrently, but a second worker for the same account fails closed
with `AccountAlreadyClaimedError`.

The lease uses backend time, a TTL heartbeat, and a monotonically increasing
fencing token. A lost or expired lease closes the socket and prevents stale
holders from writing durable state. PocketBase must implement acquisition in a
server-side transaction; Convex uses an atomic mutation on the canonical
account document; SQL backends use a conditional upsert. Client-side
read-then-update is not a lease.

## Considered options

- **Optional lease**: rejected because configuration would make the exact
  credential-corruption failure the contract is meant to prevent possible.
- **Process supervisor only**: rejected because it cannot coordinate separate
  deployments, manual starts, or applications sharing one credential store.

## Consequences

- A TTL cannot prove that two network sockets never overlap after a process
  pause; the fencing token protects durable writes, while closing on lease loss
  minimizes the remaining protocol overlap.
- The memory backend supplies an in-process lease for tests and single-process
  composition.
