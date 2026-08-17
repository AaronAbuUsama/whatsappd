---
"whatsappd": minor
---

Reject a failed `media.download()` with a `MediaDownloadError` carrying
`reason`, `statusCode`, and `retryable`, so a caller can tell 404-expired from
429-throttled and retry only what is worth retrying. Previously the upstream
`Boom` propagated unchanged: the status was reachable only by knowing it was a
Baileys error, and its message embedded the signed CDN url.
