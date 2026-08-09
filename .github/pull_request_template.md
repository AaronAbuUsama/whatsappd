<!--
Pull requests are implementation and review surfaces, never work intake
(`docs/runbooks/development/issue-tracker.md`). If this PR is the first place a problem is
described, file the issue first.
-->

## What this changes

<!-- The behavior that is different afterwards, not a list of edited files. -->

Closes #

## Why this boundary

<!--
Why this diff can be understood, tested, reverted, and merged on its own. For a
stack, name this PR's position, its exact base, and what merges before it.
-->

## Proof

<!--
The commands you ran and what they printed — not the commands a reader could
run. A claim with no output behind it is the failure mode `proof-env` exists to
prevent.
-->

- [ ] `pnpm check`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:pack`
- [ ] Task-specific live-account check (only if this touches the wire; say so if skipped)

Exact head proven: <!-- full SHA the above ran against -->

## Changeset

- [ ] A changeset is included, or this PR changes no published behavior
