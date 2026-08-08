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

### Real WhatsApp accounts are linked on this machine

Two of them, resumable with no human, holding real conversations with real
people. Before writing anything that sends, reads their databases, or logs
anything derived from them, read
[`docs/runbooks/real-account-testing.md`](docs/runbooks/real-account-testing.md).
Sends are restricted to an allowlist; a message to the wrong chat id reaches a
stranger from the owner's own number and cannot be recalled.

### Unattended frontier execution

When asked to execute the issue DAG autonomously, follow
`docs/agents/frontier-execution.md`. The durable GitHub graph, independent
review loop, four-round ceiling, proof gate, and merge-frontier receipt are
mandatory.

### A harness must not manufacture the condition it claims to observe

`tests/teardown-proof.ts` injected its own `conversation_sync` batch on every
`online` event — with empty `chats`, `contacts` and `messages` — and then
counted the resulting in-flight work as a qualifying stop. It reported 10 of 10.
Native iOS managed 2 in 20. The number was real; it just measured the harness.

When a proof needs a rare condition, the injected version is a regression
control and must be labelled one. It never counts toward a floor stated in terms
of native observation. If the native floor turns out to be unreachable, report
the achieved count against the attempt budget and get the floor re-adjudicated.
Do not quietly substitute the synthetic count, and do not retry until green.

### The default logger is not a privacy boundary

The default logger is an ordinary, unredacted `pino` logger writing to stderr.
Real-account harnesses must either supply a logger configured for their artifact
policy or keep raw output under `.proof-private/`. Committed receipts remain
schema-sanitized and carry counts, booleans and verdicts rather than log output.

### A tolerance in the loss direction is not a tolerance

Strict digest equality across a process replacement is unsound on a live
account: inbound traffic legitimately adds a chat, reorders one, or updates a
contact name between the two snapshots. The fix was a floor — accept the later
count at 90% of the earlier one. That accepts losing a tenth of the mirror.

Live drift only ever adds or mutates. It never deletes a durable row. So the
comparison is asymmetric: the earlier id set must be a subset of the later one,
losses fail outright, and additions are reported rather than tolerated in
silence. When a comparison has to absorb noise, work out which direction the
noise actually moves before widening it in both.
