---
status: accepted
---

# Headless React is packaged; renderers are source registry items

`whatsappd` and `@whatsappd/react` are the published npm package family and
release in a fixed Changesets group. `@whatsappd/react` owns the Provider,
hooks, subscription lifetime and renderer-neutral component primitives. It
does not render DOM elements or OpenTUI nodes.

Web React and OpenTUI React components are distributed as editable source
through one shadcn-compatible registry, not as npm component packages. The web
items compose shadcn's chat primitives; the OpenTUI items render terminal-native
nodes. Both families include individual components and complete blocks, depend
on the same `@whatsappd/react` contract, and share the package family's release
version.

The root source registry is canonical. A static build of the same source is
served by the documentation site as the `@whatsappd` namespace, while a tagged
GitHub address remains the transparent, reproducible fallback. This supersedes
ADR-0016's assumption that every presentation registry item is application-
authored, while retaining its rule that presentation stays out of the headless
package.

## Consequences

Correctness-sensitive WhatsApp state and lifecycle behavior remain centrally
versioned. Applications own and may edit renderer source after installation.
There is no `@whatsappd/react-web` or `@whatsappd/opentui` npm package, and the
registry does not track `main`: package tarballs, registry items and docs are
released from the same version tag.
