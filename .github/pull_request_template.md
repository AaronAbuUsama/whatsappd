<!--
Pull requests are implementation and review surfaces, never work intake
(`docs/agents/issue-tracker.md`). If this PR is the first place a problem is
described, file the issue first.
-->

## What this changes

<!-- The behavior that is different afterwards, not a list of edited files. -->

Closes #

## Why this boundary

<!--
Why this diff can be understood, tested, reverted, and merged on its own. For a
stack, name this PR's position, its exact base, and what merges before it.
`docs/agents/frontier-execution.md` — "The reviewable unit is coherent before
the PR opens".
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
- [ ] `pnpm proof:pack`
- [ ] Live `pnpm proof` run (only if this touches the wire; say so if skipped)

Exact head proven: <!-- full SHA the above ran against -->

## Review rounds

<!--
Round number, and for a repeated defect class the entry it maps to in
`docs/client-stack-defect-ledger.md`. The four-round ceiling forces a replan,
not another patch.
-->

## Changeset

- [ ] A changeset is included, or this PR changes no published behavior
