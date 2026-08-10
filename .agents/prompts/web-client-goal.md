# Goal prompt: working web client and registry proof

Deliver the working WhatsApp web client and its web registry extraction against
the source-of-truth contract in
[`docs/architecture/web-client-feature-contract.md`](../../docs/architecture/web-client-feature-contract.md).

Before changing code, read:

- `CONTEXT.md`;
- ADR-0017, ADR-0033, and ADR-0034;
- `docs/architecture/sdk-capabilities.md`;
- `docs/runbooks/development/issue-tracker.md`; and
- `docs/runbooks/development/real-account-testing.md` before any linked-account
  read, send, database access, screenshot, or recording.

## Operating rules

1. Run `pnpm state`. GitHub Issues and their `Blocked by` edges are the canonical
   DAG. This prompt and the feature contract never record mutable progress.
   If canonical issue access is unavailable, report that infrastructure blocker
   instead of inventing a local task order.
2. Select one unblocked issue and name the WC ids it advances. If no suitable
   issue exists, create the smallest issue whose body cites the relevant WC id,
   concrete failing behavior, public seam, proof rung, and retained evidence.
3. Reproduce the failing contract assertion first. Trace the public SDK path and
   all sibling callers before editing. Fix the narrowest shared root cause; do
   not patch the example around an SDK semantic defect.
4. Build the complete working example before extracting reusable source. Use the
   vendored shadcn components and chat primitives; do not create an AI chat
   model, duplicate an existing primitive, or add presentation to
   `@whatsappd/react`.
5. Application authorization remains server-side and separate from registry
   presentation. A disabled button is not authorization.
6. Fixtures are permitted only for deterministic Storybook/browser state proof
   and must be invented, privacy-safe data. The working app uses public Client
   state. Never commit or log material derived from a real account.
7. Any program that can send must enforce the external allowlist at its send
   seam. A missing allowlist disables sends. Use only sanctioned proof targets;
   never infer a target from chat order, subject text, or a mirror read.
8. Prove only the rung actually reached. P0, P1, P2, P4, P5, and P6 retain their
   ADR-0017 meanings. Screenshots alone are not browser proof.
9. Generate evidence under ignored `.artifacts`: semantic assertions, console
   and network health, screenshots, and video keyed by WC id. Regenerate the
   local HTML evidence report and open it in Chrome before claiming P5.
10. Do not start calls, further Updates work, OpenTUI, the docs site, or
    publishing unless a new approved issue explicitly changes the contract.
11. Do not run open-ended review loops. When the named issue and WC assertions
    are green, perform one bounded code review, fix findings within that scope,
    and stop if a finding would expand the public contract.

## Per-task completion

A task is complete only when its issue acceptance is green through the public
seam, every cited WC test is green at its required rung, privacy checks pass,
and durable docs/capability declarations agree with behavior.

After each task, print the actual issue DAG as Mermaid with:

- completed nodes;
- the current node;
- remaining and blocked nodes; and
- the critical path to the whole-goal DoD.

Then report the exact WC ids advanced, tests run, evidence paths, commit, and the
next unblocked node derived from `pnpm state`.

## Goal completion

Do not claim the goal complete until the Whole-goal Definition of Done in the
feature contract is green, including the registry extraction, P6 clean consumer,
and privacy-safe browser evidence report.
