---
"whatsappd": minor
---

Page saved messages and recover revision gaps. A client snapshot is now the
Snapshot Window it was meant to be — account state, chat summaries, contacts,
and groups — and no longer carries a message window for every chat, whose size
grew with chats multiplied by windows while a UI shows one conversation
(ADR-0010). An opened conversation reads `client.messages(chatId, { limit })`
instead, and scrolls with the `nextBefore` cursor each page returns.

The cursor is `(timestamp, messageId)` descending, both parts load-bearing: a
history sync lands many messages on one second, and a timestamp-only boundary
falling inside such a tie would drop or repeat one of them. Reaching the oldest
saved page returns no cursor, which says that nothing older is _stored_ and
deliberately makes no claim that WhatsApp history is complete. Paging reads the
backend alone and issues no WhatsApp history command.

Contacts and groups now project instead of only being recorded: the runtime
subscribes `contact` and `group`, a conversation sync's contacts and its group
chats' subjects and rosters become mirror records, and a contact merges rather
than replaces so a presence observation cannot blank a name. A receipt still
has no projection, and `UnsupportedDurableEventError` still refuses it.

Durable last-seen and account connection timestamps arrive with ADR-0020,
amending ADR-0014: the runtime derives an `ObservedInstant` from an ephemeral
signal and accepts _that_, so `ContactRecord.lastSeenAt` and
`AccountRecord.lastConnectedAt` / `lastDisconnectedAt` survive a restart while
the `online` and `typing` statuses they came from remain unstorable. The
instants advance monotonically, so a replayed or late older observation takes no
revision. Connection Freshness is unchanged — a live connection frame still
expires and is never hydrated as startup truth.
