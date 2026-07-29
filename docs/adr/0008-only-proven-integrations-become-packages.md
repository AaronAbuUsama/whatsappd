---
status: accepted
---

# Only proven integrations become packages

The initial family is `whatsappd`, `@whatsappd/react`, and
`@whatsappd/pocketbase`; `@whatsappd/convex` is added with its working vertical
slice. Other backend and testing packages are published only when their
complete adapters have concrete consumers, avoiding both core dependency
pollution and empty package scaffolding.
