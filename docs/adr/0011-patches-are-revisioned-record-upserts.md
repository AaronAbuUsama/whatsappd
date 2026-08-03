---
status: accepted
---

> Amended by ADR-0030: a patch also carries the PN/LID aliases the projection
> computed, and a delete names the native ids it frees. Without them a consumer
> maintaining state from patches cannot keep Address Resolution coherent. The
> `fromRevision`/`revision` pair, exact-base application, and gap-forces-snapshot
> below stand unchanged.

# Patches are revisioned record upserts

A patch carries normalized mirror-record upserts and deletes plus
`fromRevision` and `revision`, both account-scoped monotonic versions stamped by
the data store. A client applies a patch only when `fromRevision` exactly equals
its current revision. A stale patch is ignored; a future base signals a gap and
forces a fresh snapshot.

Projection logic therefore runs once in the runtime, snapshot-first ordering is
mechanical, and a client cannot silently accept revision 12 after missing
revision 11.

## Considered options

- **Apply any patch newer than the snapshot**: rejected because it detects stale
  duplicates but not missing intermediate changes.
- **Retain and replay every client patch initially**: deferred because
  contiguous patches plus snapshot recovery satisfy the current UI consumer.
  The durable accepted-source feed is a separate backend-consumer contract.
- **Event-shaped client patches**: rejected because they duplicate projection
  reducers into every client.
