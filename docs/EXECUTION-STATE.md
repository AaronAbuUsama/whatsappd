# Execution state — WhatsApp application substrate

Last updated: 2026-07-29. The rescue Batch Grill, Grill-with-Docs, specification,
and tracer-bullet planning frontier is settled through ADR-0017. This branch
contains architecture decisions, not the SDK implementation. Only the
unblocked ticket frontier may start.

## Where everything lives

| Artifact                         | Location                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| Sharpened target architecture    | `docs/architecture/runtime-backends-and-headless-react.md` |
| Shared domain language           | `CONTEXT.md`                                               |
| Accepted architecture decisions  | `docs/adr/0001` … `0018`                                   |
| Published build specification    | GitHub issue #15                                           |
| Tracer-bullet ticket graph       | GitHub issues #16 … #41                                    |
| Ambient v3 downstream dependency | Release-gated handoff supplied separately                  |
| Branch / PR                      | `codex/setup-agent-skills-architecture` → PR #12           |

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
| Acceptance has its own cursor, observation identity, and fencing token                   | 0018           |

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

- `src/session.ts` currently swallows a failed credential wipe, breaking the
  stated terminal-clear guarantee. Fix it under its separate bug ticket.
- Current callback handlers are fire-and-forget, current channels are
  memory-only, and downstream tests use sleeps and hand-built multi-stream
  fakes. The hard-cut session implementation replaces those surfaces rather
  than wrapping them.
- The Ambient Agent v3 PocketBase spike remains pinned to the old whatsappd
  package as fixture evidence. Its production integration must wait for a
  published release containing the accepted-source reader, durable media, final
  subscription API, and official test driver.

## Next step

Issues #16, #17, #18, and #10 are closed; #19 and #52 are closed `wontfix` by
the product-first grill (issue #15 re-plan receipt, 2026-07-31). Issue #20
delivers the first complete product path — runtime, backend capabilities,
memory implementations, and the in-process client for one text message.

The executable graph is:

```text
#20 ─┬─→ #21 media capture ─────────────────┐
     └─→ #24 stored paging ─┬─→ #25 backfill┼─→ #39
                            └─→ #38 libSQL ─┘
```

Every other issue remains blocked by the edges recorded in its body. Do not
start a descendant merely because the documentation PR is mechanically green.

## Resuming in a new session

Read this file, then the architecture, `CONTEXT.md`, ADR-0001 through ADR-0018,
specification issue #15, and the currently unblocked ticket bodies. Treat
current source as evidence of the old package, not evidence that the target APIs
already exist. Reopening an accepted decision requires an explicit superseding
ADR.
