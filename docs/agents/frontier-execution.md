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

The implementing agent may not delegate review, claim another issue, or create
additional workers.

## Merge gate

A PR may merge only when all of these are true:

- every acceptance criterion is met;
- the required proof rung has current evidence for the PR head;
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
- the seventh review pass still has actionable findings.

Never bypass a release or live-proof gate with guessed APIs, vendored code, a
Git dependency, weakened acceptance, or an unsupported proof claim. Record the
exact blocker, affected descendants, current PR or branch, and the command or
evidence that establishes the stop.
