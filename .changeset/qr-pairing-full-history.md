---
"whatsappd": patch
---

Request a full history sync for QR-paired accounts. The gate read
`creds.registered`, which upstream sets only in the pairing-code companion
finish handler, so a QR-paired credential held `false` for its whole life and
silently received the short sync — against Baileys' own `syncFullHistory: true`
default. Pairing completion is now proven per method: `creds.registered` for
pairing-code, `creds.me` for QR.
