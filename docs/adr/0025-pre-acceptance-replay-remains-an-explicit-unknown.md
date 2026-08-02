---
status: accepted
---

# Pre-acceptance replay remains an explicit unknown

whatsappd's durability guarantee begins at the Backend acceptance transaction.
After that transaction commits, accepted source, Current Mirror state, and its
revision survive process replacement; before it begins, a process can die after
WhatsApp or Baileys delivered an event without recording that event locally.

Protocol replay across that boundary has not been proven. The product therefore
makes no lossless-delivery, at-least-once, exactly-once, or automatic-recovery
claim for a pre-acceptance process death. In-process acceptance failures still
fail closed, publish no Client update, and stop the Runtime. Replayed events that
do arrive remain idempotent at the durable acceptance boundary.

This records the owner's 2026-07-31 decision that closed #19 `wontfix`: the live
pre-acceptance crash experiment and its proof harness do not block the Runtime
or 0.3 release. A future product that requires a stronger guarantee must first
establish the real WhatsApp/Baileys replay behavior with P4 evidence and accept a
new ADR; it cannot infer replay from deterministic tests or database absence.

## Consequences

- ADR-0014's transaction and fail-closed rules remain unchanged.
- ADR-0014's former mandatory live fault-injection consequence is superseded.
- Release notes and consumer documentation must name the pre-transaction loss
  window until a later accepted decision proves and implements something
  stronger.
- #19 stays closed and no replacement proof-harness issue is created.
