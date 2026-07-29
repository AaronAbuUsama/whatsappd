---
status: accepted
---

# Message sender is an actual WhatsApp address

Messages expose `sender: WhatsAppAddress`, where `sender` always identifies the
actual author and the address carries its known equivalent native IDs. Own
messages derive their sender from the linked account rather than the peer or
group chat, and `ConversationSyncBatch.self` is not an identity source. This
replaces the ambiguous `from` field because persisting a value that sometimes
means author and sometimes means conversation counterpart would corrupt
history, attribution, and backend identity joins.
