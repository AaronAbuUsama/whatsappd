---
status: accepted
---

# The unified event surface replaces per-category streams

`session.events` becomes the session’s only event surface at slice 6: the
seven per-category streams and the callback trio are removed together with
the agent-era exports in the same major version. Parallel independent queues
cannot express the cross-category ordering the durable mirror requires, and
keeping them public would preserve the exact ordering trap the unified
surface was created to close. Their only direct consumer, the Ambient Agent
v3 spike, migrates onto the runtime in slice 2.
