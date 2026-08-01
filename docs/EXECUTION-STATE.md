# Execution state — WhatsApp application substrate

Last updated: 2026-08-01. Issue #61 is the sole stabilization integration lane
after the board/code audit found runtime, credential, session, and WhatsApp
Address defects beneath the product frontier. Product dispatch remains held
until #61 merges with its exact-head proof gate; only then may #21 and #38
reopen.

## Where everything lives

| Artifact                         | Location                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| Sharpened target architecture    | `docs/architecture/runtime-backends-and-headless-react.md` |
| Shared domain language           | `CONTEXT.md`                                               |
| Accepted architecture decisions  | `docs/adr/0001` … `0022`                                   |
| Published build specification    | GitHub issue #15                                           |
| Locked executable graph          | Issue #15, comment of 2026-07-31                           |
| Tracer-bullet ticket graph       | GitHub issues #16 … #41                                    |
| Ambient v3 downstream dependency | Release-gated handoff supplied separately                  |
| Shipped product path             | `src/runtime/`, merged to `master` by PR #54               |
| Stabilization integration lane   | GitHub issue #61 / `agent/stabilization-integration`       |

The architecture document is grill output: a single coherent target with code
sketches, consequences, implementation slices, and proof boundaries. The
ask-matt route is now complete: issue #15 is the published specification and
issues #16 through #41 are the approved dependency graph.

## Accepted decision ledger

### Original confirmed boundary

| Decision                                                         | ADR  |
| ---------------------------------------------------------------- | ---- |
| Message sender is an actual WhatsApp address                     | 0001 |
| Connection readiness is separate from history bootstrap          | 0002 |
| whatsappd owns the canonical current mirror                      | 0003 |
| Backend capabilities remain independently replaceable            | 0004 |
| Pairing method and phone number are dynamic runtime inputs       | 0005 |
| Applications compose account workers; current sidecar is retired | 0006 |
| Applications and native backends own user authorization          | 0007 |
| Only complete, proven integrations become packages               | 0008 |

### Rescued frontier

| Decision                                                                                 | ADR / artifact |
| ---------------------------------------------------------------------------------------- | -------------- |
| Account-scoped backend lease is required; duplicate account start fails closed           | 0009           |
| Summary snapshots, stored paging, and WhatsApp backfill are distinct                     | 0010           |
| Patches require contiguous `fromRevision`; a gap replaces state with a snapshot          | 0011           |
| Pair/unlink use the command queue; raw challenge secrets use a protected capability      | 0012           |
| `session.subscribe({ ...handlers })` is the sole awaited live-session API                | 0013           |
| Accepted source batches are durable, cursor-followable, and distinct from current mirror | 0014           |
| Every inbound media attachment attempts immediate durable byte capture                   | 0015           |
| Ambient Brain follows accepted source batches, not live callbacks or mirror patches      | Architecture   |
| Voice transcription is derived from retained raw PTT audio and cannot replace it         | 0015           |
| No compatibility aliases or wrappers ship in the hard-cut package line                   | 0013 / spec    |
| `whatsappd/testing` provides awaited event driving and command recording without sleeps  | 0013 / spec    |
| Changesets releases the package family as a fixed lockstep group                         | Spec           |
| Headless React owns WhatsApp state while shadcn owns optional chat presentation          | 0016           |
| Every ticket declares TDD seam, acceptance, proof rung, and database-oracle boundary     | 0017           |
| Connection and presence remain ephemeral; remote connection truth expires with its lease | PR #12 review  |
| Conversation-sync deletion requires explicit, scope-bounded replacement metadata         | PR #12 review  |
| Executing command claims expire to terminal `outcome_unknown`, never automatic retry     | PR #12 review  |
| Actorless receipts use a non-null aggregate subject for idempotent projection            | PR #12 review  |
| Acceptance has its own cursor and the writer's fencing token                             | 0018           |
| A patch carries only upserts until something produces a delete                           | 0019           |
| Observed instants are durable; live statuses are not                                     | 0020           |
| Session failures rank subscriber, teardown, then ordinary run                            | 0021           |
| Delivered PN/LID equivalence may consolidate redundant current contacts                  | 0022           |

## Semantics that must not be collapsed

```text
session.subscribe({ ...handlers })
    live low-level processing with awaited backpressure

accepted source feed
    durable backend catch-up for consumers such as Ambient Brain

WhatsAppClient
    summary snapshot, contiguous patches, stored paging, history requests,
    commands, and headless React
```

Likewise:

```text
initial WhatsApp sync
    connection-driven protocol delivery

messages()
    deterministic reads of records already stored in the mirror

requestHistory()
    explicit, asynchronous, per-chat request to the linked phone
```

## Proof ladder

| Rung | Claim boundary                                                      |
| ---- | ------------------------------------------------------------------- |
| P0   | Types, formatting, build, exports, and package graph                |
| P1   | Deterministic behavior through an agreed public seam                |
| P2   | Real database, restart, rollback, fault injection, and durability   |
| P3   | Native backend transactions, authorization, rules, and realtime     |
| P4   | Actual linked WhatsApp account, phone, history, media, and verdict  |
| P5   | AI-driven browser behavior with semantic assertions and screenshots |
| P6   | Packed clean consumer or installed published release                |

A lower rung does not establish a higher claim. Browser screenshots accompany
semantic, interaction, console, and network assertions; they do not replace
them. A Database Oracle independently cross-checks stable identities, order,
timestamps, revisions, counts, and hashes after public behavior is asserted.
Personal message content, native addresses, media, and credentials remain out
of published evidence.

## Prototype gates, not design questions

The build graph must block dependent claims on runnable proof of:

1. Baileys on-demand history request/result correlation, completion, empty or
   exhausted behavior, boundary inclusivity, multi-chunk ordering, counts above
   50, and phone-offline/error behavior.
2. The remaining pre-acceptance crash boundary between protocol delivery and
   the first durable backend transaction.
3. Contiguous patch gap detection and fresh-snapshot replacement through a real
   backend subscription.
4. Lease acquire/renew/loss behavior under concurrent processes for each
   backend, including PocketBase server transactions and fencing tokens.
5. Immediate media capture, restart durability, failed-capture visibility, and
   blob-orphan cleanup.

Until the first prototype proves otherwise, UI language may say “no older saved
messages” and “request sent”; it may not say “all history loaded”, “no more
WhatsApp messages”, or report a delivered count tied to the request.

## Known implementation inputs

- #61 closes #49's residual session defects, including credential-clear
  failures, detached starts, startup-stop state, and falsy-safe precedence.
- Accepted updates are retained and page by source `seq`; their receipt/edit/
  revocation current-mirror projection remains a later product slice.
- `fileStore()` is restart-safe and migration-safe, but libSQL remains the first
  backend intended to persist the whole runtime (#38).
- The Ambient Agent v3 PocketBase spike remains fixture evidence on the old
  package. Production integration still waits for a published release with
  durable media and a persistent runtime backend.

## Next step

The executable graph is temporarily held at the stabilization gate:

```text
#61 stabilization ─┬─→ #21 durable media
                   └─→ #38 persistent libSQL runtime ─→ #25 background history
                                                        (also blocked by #50)
```

While #61 is open, it is the only dispatchable node. Its post-merge DAG receipt
may relabel #21 and #38 `ready-for-agent`; #25 remains deferred behind #38 and
the unanswered-phone research in #50. The integration does not silently start
either product slice.

This graph is the whole graph. It is narrowed by owner decision, not only by
dependency edges: the 2026-07-30 and 2026-07-31 re-plan receipts on issue #15
deferred the command matrix (#22), browser pairing (#23), PocketBase (#26–#29),
the browser proof app (#30–#32), Convex (#33–#37), and release (#40–#41), and
closed #19 and #52 `wontfix`. Several deferred issues still carry a `Blocked by`
edge that is satisfied — #22 is dependency-clear today — so reading bodies alone
overstates the frontier. `ready-for-agent` means fully specified
(`docs/agents/triage-labels.md`); it does not mean available. Do not start a
descendant merely because the documentation PR is mechanically green, and do not
start a deferred node merely because its blockers closed.

## Resuming in a new session

Read this file, then the architecture, `CONTEXT.md`, ADR-0001 through ADR-0022,
specification issue #15 **including its comments** — the 2026-07-31 re-plan
and the 2026-08-01 #61 hold receipt supersede earlier frontier receipts — then
read #61 and the conditionally next ticket bodies. `src/runtime/` is real
product code. Reopening an accepted decision requires an explicit superseding
ADR.
