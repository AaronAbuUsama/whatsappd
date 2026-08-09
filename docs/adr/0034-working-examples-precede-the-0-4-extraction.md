---
status: accepted
---

# Working examples precede the 0.4 extraction

After `whatsappd@0.3.0` ships from the current single-package layout, the
repository becomes a pnpm monorepo. Complete web and OpenTUI applications are
built first under `examples/`; only behavior both real renderers need is then
extracted into `@whatsappd/react`, and renderer-specific components and blocks
are extracted into their registry families.

The examples remain private workspace applications after extraction. They
consume the packed npm family and installed registry source, making them the
permanent compatibility proof rather than disposable scaffolding. A public
interface or registry item that no working example needed is not added.

The workspace root names products and durable documentation only:

```text
apps/docs
packages/{whatsappd,react}
examples/{web,opentui}
registry/{web,opentui}
docs/{adr,architecture,runbooks,.scratch}
```

`apps/docs` owns the public Diataxis MDX documentation and static Fumadocs
site. Root `docs` remains internal maintainer documentation; temporary notes go
only in the ignored `docs/.scratch`. Tests and packed-consumer smoke live with
their package. Repository-only scripts live under `.github/scripts`; generated
evidence is ephemeral and ignored under `.artifacts`. Historical receipts and
one-off proof harnesses are not source artifacts.

## Consequences

The 0.3 release is not delayed by structural work. The monorepo cutover is a
mechanical, behavior-preserving change before source refactoring or new public
surface. Renderer parity is proved before `0.4.0` stabilizes, and structural
scaffolding alone is never published as an alpha.
