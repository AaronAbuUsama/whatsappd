---
"whatsappd": minor
---

Add durable, idempotent Client operations for sends, reactions, edits,
revocations, read receipts, and phone-history requests. Persist queued work in
memory or libSQL, stage outbound media durably, resume before-boundary work after
replacement, expose optimistic receipts with wait and acknowledge APIs, and
keep typing as a non-replayed live command.

Media adapters now implement streaming `write`/`open` methods instead of
whole-object `put`/`read`. Buffer sends take one caller-isolating snapshot and
publish it in bounded chunks; URL and async-iterable sends stream incrementally
before operation submission. Ambiguous submit responses recover the
deterministic committed row without deleting its media. Voice notes accept
already-compatible Ogg Opus mono input and do not transcode.
