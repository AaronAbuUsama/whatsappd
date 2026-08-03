---
"whatsappd": minor
---

Answer any number of reads about one account at a single revision.
`WhatsAppDataStore.read(accountId, fn)` runs `fn` inside one read transaction
and hands it a `MirrorView` — `snapshot()` and `messages()` without the
account, and without the ambiguity about which revision each answered at
(ADR-0030).

Opening a conversation needs both global state and that chat's newest page.
Taken as two separate reads they arrive at two revisions, and the only
reconciliation available above the store is read-both-compare-retry, which
against a live write stream is unbounded and livelock-prone. `read()` exposes
the transaction boundary both the libSQL and in-memory stores already had
internally rather than adding a capability, and `snapshot()` and `messages()`
keep their signatures and behaviour as one-line conveniences over it.
