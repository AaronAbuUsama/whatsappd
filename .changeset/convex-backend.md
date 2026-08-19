---
"whatsappd": minor
---

Add a Convex backend. `convexBackend({ url, accountId, media })` holds credentials,
the accepted source log and Current Mirror, the Account Lease, and WhatsApp
Operations in one Convex deployment — local or cloud — while durable media stays
with the injected Media Store. The Convex functions and table definitions ship as
`whatsappd/convex`, contributed to the application's own `convex/` directory in two
files. `convex` is an optional peer dependency.

The adapter answers the same data-store, operation-store, and credential-store
conformance suites as libSQL, on a real local Convex deployment, plus a test that
runs one script of WhatsApp events through both backends and requires the same
mirror, the same pages, and the same source log from each.
