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

### Execution state

Run `pnpm state`. It derives the frontier, the blocked nodes, and the open pull
requests from the `## Blocked by` edges GitHub already holds. No document
records which node is next; the one that used to disagreed with the graph
within a day. Standing decisions that do not change when an issue closes live
in `docs/standing-decisions.md`.

### Operational runbooks

Production procedures live in `docs/runbooks/`: session faults, a stuck account
lease, libSQL recovery, credential rotation, and releasing. Read the fault
disposition table in `docs/runbooks/README.md` before acting on any incident —
acting against the disposition is how a 30-second reconnect becomes a QR scan.

### Unattended frontier execution

When asked to execute the issue DAG autonomously, follow
`docs/agents/frontier-execution.md`. The durable GitHub graph, independent
review loop, four-round ceiling, proof gate, and merge-frontier receipt are
mandatory.
