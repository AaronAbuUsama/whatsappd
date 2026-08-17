---
"whatsappd": minor
---

Ask WhatsApp for a full history sync at Pairing, and add `syncFullHistory` to
the session config to decline it. The request rides in the registration node,
which the protocol sends only while a credential is unpaired, so it was gated on
`creds.registered` — a field that is never set at that moment, by either Pairing
method. No account has ever sent it. It now defaults to `true`, matching Baileys'
own default and the desktop companion identity whatsappd already advertises.
