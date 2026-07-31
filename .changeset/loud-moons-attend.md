---
"whatsappd": minor
---

Name the actual author of every message. `InboundMessage.from` and
`addressing` are replaced by `sender: WhatsAppAddress`, which carries the
author's native address, its identity scheme, and the known equivalent form.
Own-sent messages now name the linked account instead of the chat peer or
group, across live messages, synchronized history, and edits.
`ConversationSyncBatch.self` is removed — it was never populated and is not an
identity source.
