# Execution state — WhatsApp application substrate

Last updated: 2026-07-29. The rescue Batch Grill and Grill-with-Docs frontier is
settled through ADR-0015. This branch contains architecture decisions, not the
SDK implementation. Run `/to-spec` and `/to-tickets` before implementation.

## Where everything lives

| Artifact                         | Location                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| Sharpened target architecture    | `docs/architecture/runtime-backends-and-headless-react.md` |
| Shared domain language           | `CONTEXT.md`                                               |
| Accepted architecture decisions  | `docs/adr/0001` … `0015`                                   |
| Ambient v3 downstream dependency | Release-gated handoff supplied separately                  |
| Branch / PR                      | `codex/setup-agent-skills-architecture` → PR #12           |

The architecture document is grill output: a single coherent target with code
sketches, consequences, implementation slices, and proof boundaries. Per the
ask-matt route, it must become a build spec and a tracer-bullet ticket graph
before any slice starts.

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

1. Run `/to-spec` over the architecture, glossary, and ADRs.
2. Run `/to-tickets` to create tracer-bullet slices and blocking prototype
   edges.
3. Do not start Slice 1 merely because the documentation PR is mechanically
   green.

## Resuming in a new session

Read this file, then the architecture, `CONTEXT.md`, and ADR-0001 through
ADR-0015. Treat current source as evidence of the old package, not evidence that
the target APIs already exist. Reopening an accepted decision requires an
explicit superseding ADR.
