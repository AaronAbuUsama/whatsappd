---
status: accepted
---

# Summary snapshots, stored paging, and WhatsApp backfill are separate

A client snapshot contains the account, chat summaries, contacts, and groups;
it does not contain a message window for every chat. Opening a conversation
loads its first stored page, and scrolling reads further pages from the
durable mirror with a stable database cursor.

Stored paging never contacts WhatsApp. When the oldest stored page is exhausted,
an application may separately submit an on-demand, per-chat history request
against the oldest known WhatsApp message key and timestamp. `count: 50` is the
Baileys request maximum, not a database-page guarantee or evidence that more
messages exist.

## Considered options

- **Recent messages for every chat in each snapshot**: rejected because first
  frame size grows with chats multiplied by message windows even though the UI
  displays one active conversation.
- **Hide remote backfill behind `loadOlder()`**: rejected because a deterministic
  database read would acquire phone, network, and storage side effects, and an
  empty result could not state whether the local mirror or WhatsApp was
  exhausted.

## Consequences

- The UI may say that no older messages are currently stored and that it can
  ask the linked phone for more. It may not claim that all WhatsApp history is
  loaded or exhausted until live protocol proof establishes that signal.
- Request correlation, completion, empty-result behavior, and phone-offline
  behavior remain prototype gates for the on-demand backfill command.
