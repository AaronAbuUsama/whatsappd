---
"whatsappd": minor
---

Add durable, idempotent Client operations for sends, reactions, edits,
revocations, read receipts, and phone-history requests. Persist queued work in
memory or libSQL, stage outbound media durably, resume before-boundary work after
replacement, expose optimistic receipts with wait and acknowledge APIs, and
keep typing as a non-replayed live command.
