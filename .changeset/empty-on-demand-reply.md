---
"whatsappd": minor
---

Deliver an empty on-demand history reply instead of dropping it. A payload that
names your `requestHistory` request, or that WhatsApp typed `ON_DEMAND`, now
emits a `conversationSync` batch even with no rows — the only signal that can
ever distinguish "there is nothing older" from "the phone never replied". Empty
payloads that answer nothing stay silent, and an empty batch takes no revision.
