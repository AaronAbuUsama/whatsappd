---
"whatsappd": minor
---

Capture inbound image, video, audio and voice-note, document, and sticker bytes
before accepting their messages. Durable source, mirror records, pages, and
client patches now expose an immutable stored-media reference or a typed capture
failure. Add the root `fileMediaStore({ directory })` adapter for private,
restart-safe local attachment bytes while libSQL retains only structured media
state.
