---
status: accepted
---

# Only proven integrations become packages

The initial family is `whatsappd`, `@whatsappd/react`, and
`@whatsappd/pocketbase`; `@whatsappd/convex` is added with its working vertical
slice. Other backend and testing packages are published only when their
complete adapters have concrete consumers, avoiding both core dependency
pollution and empty package scaffolding.

## Amendment: the Convex adapter shipped inside `whatsappd`

`convexBackend` is exported from `whatsappd`, and its Convex functions from
`whatsappd/convex`, rather than from a separate `@whatsappd/convex`. A backend
adapter is not built only from the public contracts: it needs
`projectCurrentMirror` to compute the Current Mirror and the operation
validators to refuse an illegal receipt before it is stored. Both are internal,
and both are shared with the libSQL adapter, which lives inside the package for
the same reason. Publishing a separate package first would have meant
publishing that projection seam as public API — a larger and less reversible
decision than the adapter itself, made to satisfy a packaging choice rather than
a consumer.

The rest of this decision stands: `convex` is an optional peer dependency, so a
deployment on another backend never installs it, and the extraction stays
available as a file move once a consumer needs the packages separated.
