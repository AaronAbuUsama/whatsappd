---
status: accepted
---

# Proof claims climb an explicit ladder

> ADR-0024 clarifies the catalogue boundary: P0-P6 still govern implementation
> acceptance claims, but the capability inventory uses plain environment
> statuses rather than assigning every capability a proof rung.

Every implementation ticket declares an agreed public seam, first failing
behavior, minimum end-to-end green behavior, required proof rung, retained
evidence, and Database Oracle boundary.

The proof ladder is:

1. P0 — mechanical types, formatting, build, exports, and package graph;
2. P1 — deterministic behavior through the public seam;
3. P2 — real database, restart, rollback, fault injection, and durability;
4. P3 — native backend transactions, authorization, rules, and realtime;
5. P4 — actual linked WhatsApp account, phone, history, media, and verdict;
6. P5 — AI-driven browser semantics, interactions, health, and screenshots;
7. P6 — packed clean consumer or installed published release.

A lower rung never establishes a higher claim. Screenshot-only acceptance is
not P5: browser proof combines semantic and interaction assertions, console and
network health, and privacy-safe screenshots.

A Database Oracle is supporting evidence, not the component or client test
seam. Public behavior is asserted first, then independently cross-checked
against read-only stable identities, timestamps, revisions, counts, and hashes.
Personal content, native addresses, media, credentials, and pairing secrets do
not enter published evidence.

## Consequences

- Mechanically green work cannot be described as durable, live, visual, or
  released without the corresponding rung.
- The private live-account harness keeps one canonical database-backed
  credential store and never clones credentials with disposable corpus data.
- React tickets require deterministic behavior through their claimed renderer.
  A browser claim additionally requires P5 real-browser proof; an OpenTUI proof
  establishes terminal React behavior only. Backend tickets additionally
  require the native and durability rungs they claim.
