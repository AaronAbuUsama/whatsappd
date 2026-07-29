---
status: accepted
---

# Snapshots are windowed with paged history

A client snapshot is the account, chats, contacts, groups, and each chat’s
most recent messages — never the full mirror, which on a real multi-year
account is tens of megabytes per watch. Older history is read on demand
through `messages()` pages, which the React `loadOlder` slot calls. This is a
public contract shape, so it is decided before the first adapter exists rather
than retrofitted across every adapter and client later.
