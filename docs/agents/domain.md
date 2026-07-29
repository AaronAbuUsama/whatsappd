# Domain docs

This is a single-context repository. Engineering skills use the following
domain documentation when exploring or changing the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root, when it exists.
- Relevant architectural decisions under `docs/adr/`, when they exist.

If either location is absent, proceed silently. `/domain-modeling`, normally
reached through `/grill-with-docs` or
`/improve-codebase-architecture`, creates files lazily when terminology or a
decision is actually resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-example-decision.md
│       └── 0002-another-decision.md
└── src/
```

Do not introduce `CONTEXT-MAP.md` or context-scoped ADR directories unless the
repository actually grows into multiple independently modeled contexts.

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, design, test, or code
change—use the term defined in `CONTEXT.md`. Do not drift to synonyms the
glossary explicitly avoids.

If a required concept is absent, first decide whether the new language is
unnecessary. If it represents a real domain gap, resolve it through
`/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly
instead of silently overriding it:

> Contradicts ADR-0007 (event-sourced orders), but is worth reopening
> because...
