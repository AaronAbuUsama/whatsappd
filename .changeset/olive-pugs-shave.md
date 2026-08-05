---
"whatsappd": patch
---

Censor message content, addresses, and credentials in the default logger.
Errors raised by Baileys or the socket can carry the outbound payload or
request headers, so logging them wrote message bodies, phone numbers, and auth
tokens in full. Sessions given an explicit `logger` are unaffected and still
configure their own redaction.
