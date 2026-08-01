---
status: accepted
---

# A patch carries only upserts until deletion exists

> Amended by ADR-0022: WhatsApp-delivered PN/LID equivalence is now the first
> proven delete producer. It may remove a redundant current contact record;
> accepted source remains append-only. The revocation and authoritative-
> replacement restrictions below still hold.

ADR-0011 specifies that a patch carries "normalized mirror-record upserts and
deletes". Implementing it produced no deletes to carry. This decision amends
that one clause; everything else in ADR-0011 — the `fromRevision`/`revision`
pair, exact-base application, gap-forces-snapshot — stands unchanged.

## The original restriction

`WhatsAppPatch` ships with `upserts` alone. Every projection in this slice adds
or replaces a record: a message arrives, a chat's last-message time moves. The
two things that would remove one are not built:

- **Revocation.** A revoked message is an `update` event, which has no
  projection until the slice that models revoked state. Whether revocation
  deletes the record or marks it revoked is that slice's decision, not this
  one's — a client that renders "this message was deleted" needs the record to
  survive.
- **Scope-bounded replacement.** An authoritative conversation sync would
  replace a chat's contents wholesale, which means deleting what it does not
  list. ADR-0014 already refuses that mode for want of replacement metadata no
  live protocol mapping has proven, and acceptance rejects it outright.

## Why not ship the field empty

An always-empty `deletes: []` is a contract every backend must implement, every
client must apply, and no test can exercise. The first implementation to get it
wrong would not be caught, because nothing produces the input that would catch
it. A field added with its first producer is a field with a test.

Adding it later is a widening of the patch shape: a client that ignores an
absent `deletes` behaves identically to one written before it existed, so the
change is additive for consumers that apply upserts by record identity.

## Original consequences

- A backend implementing `WhatsAppDataStore.accept()` emitted no deletions until
  ADR-0022 supplied an explicit, tested contact-consolidation producer.
- The slice that models revocation owns this decision's reversal, and owns
  proving it: a patch that removes a record, and a client that applies it.
- Prune, retention, and account deletion remain outside the patch contract —
  they are account-scope operations, not record-level mirror changes.
