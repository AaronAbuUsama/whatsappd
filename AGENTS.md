## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. Pull requests are not a triage request
surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant decisions
under `docs/adr/` when present. See `docs/agents/domain.md`.

### Unattended frontier execution

When asked to execute the issue DAG autonomously, follow
`docs/agents/frontier-execution.md`. The durable GitHub graph, independent
review loop, seven-pass ceiling, proof gate, and merge-frontier receipt are
mandatory.
