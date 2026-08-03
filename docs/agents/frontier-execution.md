# Unattended frontier execution

This policy governs an explicitly authorized unattended run of the GitHub issue
DAG.

## Source of truth

- GitHub Issues owns node state and dependency edges.
- A node is fully specified when it has the appropriate `ready-for-agent` or
  `ready-for-human` label. Labels describe who can execute the issue; blockers
  still govern when it may begin and merge.
- An ordinary node is executable only when it is open, labelled
  `ready-for-agent`, unclaimed by another active lane, and every issue named
  under `Blocked by` is closed.
- A declared stack child may begin before its direct predecessor issue closes
  only after that predecessor PR has a clean exact-head review, green required
  checks, and its acceptance, proof, and handoff receipt. The child branches
  from that exact reviewed head and targets the predecessor PR. All other
  blockers must be closed, and the child may not merge before its predecessor.
- Pull requests are implementation and review surfaces, never new work intake.
- After every stack handoff and merge, the orchestrator reads GitHub again,
  prints the whole DAG with merged, in-flight, frontier, and blocked nodes, and
  dispatches only the newly executable frontier.

## Lane shape

An executable node declares either one branch/PR or an ordered PR stack. The
issue body must name every stack position, exact base, merge order and proof
boundary before editing begins.

1. The orchestrator creates the first worktree from the issue's declared base.
   A stack child branches from the exact reviewed head of its predecessor and
   targets that predecessor while it remains open.
2. The implementing agent reads `CONTEXT.md`, relevant ADRs, the complete issue,
   its proof contract, predecessor receipts and the real code path before
   editing.
3. It uses the issue's named repository skills in order. Behavior changes
   normally begin with architecture confirmation and `tdd`.
4. It changes only the declared node/stack responsibility, satisfies its
   acceptance criteria and records its required proof.
5. Stacked PRs merge bottom-up. After a predecessor merges, its child is
   rebased/retargeted to the new base and revalidated; no child merges first and
   no merge commit duplicates predecessor content.

### The reviewable unit is coherent before the PR opens

There is no numeric changed-line limit. Correctness and an end-to-end working
mechanism take precedence over diff size. A PR is split only when it combines
independently reviewable responsibilities, proof boundaries or rollback units.
It is not split through the middle of one transaction, state machine or public
vertical behavior merely to satisfy a number.

The issue explains why each PR boundary can be understood, tested, reverted and
merged on its own. If implementation discovers that the proposed boundary
requires duplicating a mechanism or compensating above the layer that causes a
defect, stop and re-plan before opening the PR.

## GitHub review loop

The implementing agent must not grade its own work and must not create a
reviewer task or thread. Once its PR is ready, the same implementing agent
triggers the GitHub Codex review bot and babysits the PR until the bot posts its
verdict.

The implementing agent follows the issue's reviewer brief and:

- asks the GitHub Codex review bot to review the current immutable PR head
  against the complete issue, architecture invariants, proof contract, full
  diff, tests, and affected callers;
- waits for the bot's complete verdict on the PR;
- investigates every finding against the code, issue and prior ledger before
  deciding whether it is valid, duplicate, non-blocking or evidence that the
  plan is wrong;
- records each actionable finding's violated property, causal chain, predicted
  siblings, fix locus and proof before editing;
- fixes the root cause, pushes the new head, and triggers the bot again;
- repeats until the bot posts a clean verdict for the exact merge candidate.

A review pass means one complete GitHub Codex bot verdict over the current PR
head, not one comment or one finding.

The hard ceiling is four complete review rounds per PR. Each PR starts its own
numeric round counter at 1. A stack keeps one persistent defect-class ledger,
so opening the next PR resets the number but not the history, dispositions, or
root-cause evidence for recurring defect classes.

- round 1 adjudicates findings before any edit;
- a repeated defect class or any fix requiring a new mechanism triggers
  root-cause diagnosis immediately;
- round 2 compares both rounds and re-plans every repeated class before edits;
- round 3 with actionable findings freezes patching and performs a deep reset
  against the issue, architecture and all prior findings;
- round 4 with any actionable finding stops for owner guidance. There is no
  fifth patch or review round.

Reviewers prioritize correctness, acceptance criteria, integrity, ownership and
proof. Personal style, naming preference, speculative abstraction and unrelated
refactors are not blocking. A blocking finding names a reproducible scenario,
violated property, concrete location and material impact. Non-blocking residuals
become separate GitHub issues rather than expanding the PR.

### What diagnosis must produce

The diagnosis trigger works — it is why #93 and #94 stopped at four passes each
rather than running to twenty-one. What failed afterwards is what diagnosis was
allowed to conclude.

A lane retired after diagnosis **may not be restarted against the same
artifact.** PR #94's first implementation commit was byte-identical to PR #93's
head — same blob SHA for both the implementation and its tests — because the
re-chartered issue instructed the agent to carry the retired unit forward. That
is one review loop relabelled as two attempts, and the ledger reset hid it.

A restart is valid only when at least one of these is true, and it says which:

- the reviewable unit is smaller than the retired one;
- a defect class was moved to the layer that causes it, rather than compensated
  for at the layer that observes it;
- a specification contradiction was resolved by choosing, rather than by adding
  a requirement.

Carrying forward a retired implementation is not a restart. Neither is a new
plan over the same artifact.

### The specification does not move during a lane

An issue body is not edited in response to a review finding. Nine revisions of
issue #71 included five that landed minutes after a specific finding and
generalised it into a requirement, one written a single minute before the commit
it described. Six of its sixteen acceptance criteria were findings promoted to
requirements — each naming its originating defect rather than the property
behind it, which is how thirteen of sixteen were graded satisfied on a PR nobody
trusted, and how one criterion was marked satisfied on the exact head where two
violations of it were filed.

A finding that suggests the specification is wrong stops the lane and reopens
the specification deliberately, with the orchestrator. It does not edit the
issue mid-flight.

The required GitHub Codex bot review is not a delegated task. The implementing
agent may not create reviewer tasks or additional workers, and may not claim
work outside the issue or ordered stack it was assigned.

## Merge gate

A PR may merge only when all of these are true:

- every acceptance criterion is met;
- the required proof rung has current evidence for the PR head;
- **the proof's evidence is an artifact the behaviour produced**, not the
  absence of an error. A command exiting zero, a suite reporting green, or a
  process not rejecting are all satisfiable by a proof that executed nothing.
  Assert a value the behaviour under test wrote, and state what makes the proof
  fail red if it does not run;
- **independent confirmations are counted, not assumed.** One local run plus two
  CI Node versions is one confirmation of behaviour, not three — a version
  matrix cannot vary a defect in a test's own construction. Checks that cannot
  observe the behaviour contribute zero;
- the GitHub Codex review bot has posted a clean verdict for the current head;
- all actionable review findings are resolved;
- repository CI is green;
- the branch is current and mergeable against `master`;
- no secret, private corpus, credential, or live-account artifact is included.

The implementing agent merges the PR when authorized and reports the PR number,
merge commit, issue number, checks, proof receipt, and limitations to the
orchestrator. If repository permissions prevent that, it reports a clean merge
gate and the orchestrator performs the merge.

The orchestrator independently verifies that remote `master` contains the
merged content before advancing the DAG. A merge without proof does not advance
the frontier.

## Monitoring and recovery

The orchestrator owns the run:

- keep at most one active implementation lane per issue;
- run independent frontier nodes concurrently only when their paths and
  exclusive resources do not conflict;
- poll agents and PR checks with bounded waits;
- nudge a quiet agent, inspect its branch/PR/terminal, and recover its lane
  before declaring it stalled;
- return conflicts, CI failures, proof gaps, and review findings to the
  implementing agent;
- preserve durable receipts in GitHub and the repository so a new session can
  resume from tracker state rather than conversational memory.

## Stop conditions

Continue dispatching until no executable frontier remains. Stop only when:

- a required external service, live WhatsApp account, credential, publication,
  or human-only action blocks the proof contract;
- the issue premise is wrong or the implementation cannot be completed without
  expanding its approved scope;
- an unrecoverable infrastructure or authorization failure prevents progress;
- the fourth review round still has actionable findings.

Never bypass a release or live-proof gate with guessed APIs, vendored code, a
Git dependency, weakened acceptance, or an unsupported proof claim. Record the
exact blocker, affected descendants, current PR or branch, and the command or
evidence that establishes the stop.
