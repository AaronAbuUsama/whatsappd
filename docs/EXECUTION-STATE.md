# Execution state — WhatsApp application substrate

Last updated: 2026-07-29. Grill-with-docs session complete: **three rounds,
every question answered and confirmed by Aaron, every answer recorded.**
This file is the resume point for a new session.

## Where everything lives

| Artifact                        | Location                                                   |
| ------------------------------- | ---------------------------------------------------------- |
| The spec (single target design) | `docs/architecture/runtime-backends-and-headless-react.md` |
| Glossary (15 terms)             | `CONTEXT.md`                                               |
| Decisions                       | `docs/adr/0001` … `0013`                                   |
| Branch / PR                     | `codex/setup-agent-skills-architecture` → PR #12           |

The spec was updated after every round, so it is fully consistent with the
ADRs. There is no separate PRD: the spec's Decision section, slice plan, exit
proofs, acceptance criteria, and non-goals are the product requirements.

## Decision ledger — all confirmed

**Round 1** (commits `754ee0c`, `f21bada`):

| Q   | Decision                                                               | ADR  |
| --- | ---------------------------------------------------------------------- | ---- |
| —   | Message sender is an actual WhatsApp address                           | 0001 |
| 1B  | Connection readiness ≠ history bootstrap                               | 0002 |
| 2B  | whatsappd owns the canonical current mirror                            | 0003 |
| 3B  | Credentials / data / commands / leases are independent capabilities    | 0004 |
| —   | Pairing is a dynamic runtime command, not constructor config           | 0005 |
| 4A  | Application-owned account workers; sidecar retired, no daemon/HTTP     | 0006 |
| 5B  | Application/backend-native authorization; whatsappd has no user system | 0007 |
| 6C  | Core + proven integration packages only (react, pocketbase first)      | 0008 |

**Round 2** (commit `f3ae956`):

| Q   | Decision                                                                   | ADR                    |
| --- | -------------------------------------------------------------------------- | ---------------------- |
| 7B  | Account lease is a required capability; double-start fails closed          | 0009                   |
| 8C  | Ingestion write failure = pause-and-retry in place, visible degraded state | spec only (reversible) |
| 9B  | Snapshots are windowed; older history via `messages()` pages               | 0010                   |
| 10A | Patches are record upserts with per-account monotonic revisions            | 0011                   |

**Round 3** (commit `605faf5`):

| Q   | Decision                                                                                           | ADR                           |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| 11C | Changesets releases, fixed lockstep group across the family                                        | spec only (one-line reversal) |
| 12B | Pair/unlink ride the command queue; challenges surface in `runtime_state`; unlink keeps the mirror | 0012                          |
| 13B | The seven session streams + callbacks retire at slice 6; `events` is the only surface              | 0013                          |

## Open items — blocked, not undecided

- Convex service-auth glue: designed in the spec, built in slice 4.
- Durable media bytes: separate capability, waits for a real consumer.
- `src/session.ts:273` swallows a failed credential wipe
  (`store.clear().catch(() => {})`), breaking the stated "creds are gone on
  logged_out" guarantee. Fix during slice 1.

## Next step

Begin **Slice 1: contracts and memory proof** (spec § Implementation plan):
rename `SessionStore`→`CredentialStore`, add the unified `WhatsAppEvent`
surface, define the durable/command/client contracts including
`WhatsAppPatch` revisions and the windowed snapshot, implement the runtime
with memory data/command/lease stores, and land the conformance suite. Exit
proofs are enumerated in the spec and include the lease fail-closed proof and
loss-free ingestion recovery. Slices 2–6 follow in order.

## Resuming in a new session

Read this file, then the spec, then `CONTEXT.md`. Do not re-litigate ledger
decisions — they are confirmed; reopening one requires superseding its ADR
explicitly.
