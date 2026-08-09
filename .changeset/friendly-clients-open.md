---
"whatsappd": minor
---

Make the awaited, hydrated WhatsApp Client the package-root experience. Export
`createWhatsAppClient` and its account, chat, contact, group, retained-message,
and subscription types; rename the friendly interface to `WhatsAppClient`; and
remove the old frame-oriented Client factory and replication types from the
root entry point.

The Client owns reconciliation between live changes and saved pages. Applications
read named namespaces and close Client, Runtime, and Backend independently.
