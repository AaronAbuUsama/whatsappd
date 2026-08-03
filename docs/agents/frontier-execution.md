# Unattended frontier execution

This policy governs an explicitly authorized unattended run of the GitHub issue
DAG.

## Source of truth

- GitHub Issues owns node state and dependency edges.
- A node is executable only when it is open, labelled `ready-for-agent`,
  unclaimed by another active lane, and every issue named under `Blocked by` is
  closed.
- Pull requests are implementation and review surfaces, never new work intake.
- After every merge, the orchestrator reads GitHub again, prints the whole DAG
  with merged, in-flight, frontier, and blocked nodes, and dispatches only the
  newly executable frontier.

## Lane shape

One issue is one implementation lane, branch, worktree, and pull request.

1. The orchestrator creates a worktree from current `origin/master`.
2. The implementing agent is named `issue_<number>`.
3. The agent reads `CONTEXT.md`, relevant ADRs, the issue body, its proof
   contract, and the real code path before editing.
4. It chooses the narrowest applicable repository skill. Behavior changes
   normally start with `tdd`; straightforward integration or mechanical work
   may use `implement`.
5. It works only its assigned issue, satisfies the written acceptance criteria,
   records the required proof, and opens one PR targeting `master`.

### The reviewable unit is bounded before the PR opens

Finding supply is roughly `reviewable surface × evidence standard`. Per-pass
patching shrinks neither, which is why three separate loops in this repository
(#45/#47, #51, #93/#94) ran long without converging.

CI enforces a budget of 400 changed lines across `src/` and `tests/` per PR. It
is a check rather than a rule because a remembered rule is the failure class
this policy exists to prevent. A unit that genuinely cannot be split raises it
with `PR-Budget: <n>` in the PR body and states why; raising it without a reason
is itself a review finding.

An issue whose work does not fit the budget is split into vertical slices, each
merging on its own, **before** the first implementation PR opens. Slicing after
the surface is already too large is what has never worked here.

## GitHub review loop

The implementing agent must not grade its own work and must not create a
reviewer task or thread. Once its PR is ready, the same implementing agent
triggers the GitHub Codex review bot and babysits the PR until the bot posts its
verdict.

The implementing agent:

- asks the GitHub Codex review bot to review the current immutable PR head
  against the complete issue, architecture invariants, proof contract, full
  diff, tests, and affected callers;
- waits for the bot's complete verdict on the PR;
- returns every actionable finding to its own implementation loop;
- fixes findings, pushes the new head, and triggers the bot again;
- repeats until the bot posts a clean verdict for the exact merge candidate.

A review pass means one complete GitHub Codex bot verdict over the current PR
head, not one comment or one finding.

The hard ceiling is seven complete review passes:

- passes 1–2 normally patch fix-complete findings;
- a repeated defect class or a fix requiring a new mechanism triggers
  root-cause diagnosis immediately;
- pass 4 triggers diagnosis even without an obvious repeated class;
- unresolved actionable findings after pass 7 block the lane and prohibit
  merge.

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
another issue.

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
- repository CI is green, including the reviewable-unit budget;
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
- the seventh review pass still has actionable findings.

Never bypass a release or live-proof gate with guessed APIs, vendored code, a
Git dependency, weakened acceptance, or an unsupported proof claim. Record the
exact blocker, affected descendants, current PR or branch, and the command or
evidence that establishes the stop.
