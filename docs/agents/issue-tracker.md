# Issue tracker: GitHub

Issues and PRDs for this repository live in
[`AaronAbuUsama/whatsappd`](https://github.com/AaronAbuUsama/whatsappd/issues).
Use the `gh` CLI for all operations.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body-file <file>`.
- **Read an issue:** `gh issue view <number> --comments`.
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments`.
- **Comment on an issue:** `gh issue comment <number> --body-file <file>`.
- **Apply or remove labels:** `gh issue edit <number> --add-label "..."` or
  `gh issue edit <number> --remove-label "..."`.
- **Close an issue:** `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically when
run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests remain implementation and review surfaces. `/triage` processes
incoming issues, not external pull requests.

GitHub shares one number space across issues and pull requests. If a bare
`#42` is ambiguous, resolve it with `gh pr view 42` and then
`gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

`/wayfinder` uses one issue as a map and child issues as decision tickets:

- **Map:** label one issue `wayfinder:map` and maintain its notes, decisions,
  and remaining fog in the issue body.
- **Child:** link each investigation as a GitHub sub-issue. If sub-issues are
  unavailable, put `Part of #<map>` at the top of the child and list it in the
  map's task list.
- **Type:** label children `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking:** use GitHub's native issue dependencies. If they are
  unavailable, put `Blocked by: #<n>, #<n>` at the top of the child.
- **Frontier:** choose the first open, unassigned child whose blockers are
  closed.
- **Claim:** `gh issue edit <number> --add-assignee @me`.
- **Resolve:** record the decision in a comment, close the child, and link the
  result from the map's decisions section.

Native sub-issues and dependencies are canonical whenever GitHub supports them.
