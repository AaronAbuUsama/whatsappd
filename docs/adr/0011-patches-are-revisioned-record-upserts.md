---
status: accepted
---

# Patches are revisioned record upserts

A patch carries normalized mirror-record upserts and deletes plus a
per-account monotonic revision stamped by the data store; snapshots report the
revision they include, and a client applies a patch only when its revision
exceeds the snapshot’s. Projection logic therefore runs once in the runtime,
and snapshot-first ordering is a mechanical comparison instead of a buffering
heuristic that leaves the subscribe-during-read race open. Event-shaped
patches were rejected because they duplicate the projection reducer into every
client.
