# Execution state — WhatsApp application substrate

Last updated: 2026-08-03. The capability catalogue merged at
`d7923f6cf93c810f8ea660089dd1edbd96523a81`, and #68 merged the first executable
graph at `4bc28f7dc44b2573ba08eace67f831b5a7cd4bb1`. After #64/#70 and substrate
#96–#98 landed, the owner replaced the underspecified #71/#22/#23/#30/#40/#41
spine with the executable stack #105–#113. #105 merged in PR #116 at
`6778fdf`. #117 went ahead of #106 because it repairs a proof that six of the
remaining nodes list as required validation — #106, #107, #108, #109, #111 and
#112. Not #113, which is a human release operation with no validation list.

The owner also moved #110 out of 0.3 on 2026-08-03: the headless React bindings
are being written inside a real OpenTUI application and will be extracted into
`@whatsappd/react@0.4.0` once stable there, per ADR-0008. **0.3.0 publishes
`whatsappd` alone**, the repository stays a single package through the release,
and #111 becomes #112's only blocker.

## Where everything lives

| Artifact                         | Location                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| Historical target architecture   | `docs/architecture/runtime-backends-and-headless-react.md` |
| Shared domain language           | `CONTEXT.md`                                               |
| Accepted architecture decisions  | `docs/adr/0001` … `0030` (`0027` reserved)                 |
| Published build specification    | GitHub issue #15                                           |
| Capability planning guide        | `docs/sdk-capabilities.md`                                 |
| Execution-graph repair           | GitHub issue #68                                           |
| Tracer-bullet ticket graph       | GitHub issues linked from #15 and #68                      |
| Ambient v3 downstream dependency | Release-gated handoff supplied separately                  |
| Shipped product path             | `src/session.ts`, `src/runtime/`, and root exports         |

The architecture document preserves the original target and proof boundaries.
Accepted ADRs and the current #15 execution receipt supersede it where
implementation and owner decisions moved on. The capability guide summarizes
the planned and current product surface without governing it.

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

| Decision                                                                                     | ADR / artifact |
| -------------------------------------------------------------------------------------------- | -------------- |
| Account-scoped backend lease is required; duplicate account start fails closed               | 0009           |
| Summary snapshots, stored paging, and WhatsApp backfill are distinct                         | 0010           |
| Patches require contiguous `fromRevision`; a gap replaces state with a snapshot              | 0011           |
| Pair/unlink use the command queue; raw challenge secrets use a protected capability          | 0012           |
| `session.subscribe({ ...handlers })` is the sole awaited live-session API                    | 0013           |
| Accepted source batches are durable, cursor-followable, and distinct from current mirror     | 0014           |
| Every inbound media attachment attempts immediate durable byte capture                       | 0015           |
| Ambient Brain follows accepted source batches, not live callbacks or mirror patches          | Architecture   |
| Voice transcription is derived from retained raw PTT audio and cannot replace it             | 0015           |
| No compatibility aliases or wrappers ship in the hard-cut package line                       | 0013 / spec    |
| `whatsappd/testing` provides awaited event driving and command recording without sleeps      | 0013 / spec    |
| Changesets releases the package family as a fixed lockstep group                             | Spec           |
| Framework-independent Client owns WhatsApp state; React binds it; renderers own presentation | 0023           |
| Every ticket declares TDD seam, acceptance, proof rung, and database-oracle boundary         | 0017           |
| Pre-acceptance process-death replay is unknown and carries no lossless-delivery claim        | 0025           |
| Capability inventory is a human-maintained planning guide, not a product authority           | 0026           |
| Connection and presence remain ephemeral; remote connection truth expires with its lease     | PR #12 review  |
| Conversation-sync deletion requires explicit, scope-bounded replacement metadata             | PR #12 review  |
| Executing command claims expire to terminal `outcome_unknown`, never automatic retry         | PR #12 review  |
| Actorless receipts use a non-null aggregate subject for idempotent projection                | PR #12 review  |
| Acceptance has its own cursor and the writer's fencing token                                 | 0018           |
| A patch carries only upserts until something produces a delete                               | 0019           |
| Observed instants are durable; live statuses are not                                         | 0020           |
| Session failures rank subscriber, teardown, then ordinary run                                | 0021           |
| Delivered PN/LID equivalence may consolidate redundant current contacts                      | 0022           |
| Live state is derived from an observation and sampled instant                                | 0028           |
| Client commits once, then delivers through one listener primitive                            | 0029           |
| Coherent reads come from the substrate through a module-private Runtime source               | 0030           |

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
2. Contiguous patch gap detection and fresh-snapshot replacement through a real
   backend subscription.
3. Lease acquire/renew/loss behavior under concurrent processes for each
   backend, including PocketBase server transactions and fencing tokens.
4. Restartable background media capture and blob-orphan cleanup when #72 is
   implemented. Immediate capture, restart-safe file bytes, and failed-capture
   visibility already ship and remain the 0.3 contract.

The pre-acceptance process-death boundary is deliberately not a proof gate.
ADR-0025 records the unknown replay/loss window and the absence of any lossless,
at-least-once, or exactly-once claim; #19 remains closed `wontfix`.

Until the first prototype proves otherwise, UI language may say “no older saved
messages” and “request sent”; it may not say “all history loaded”, “no more
WhatsApp messages”, or report a delivered count tied to the request.

## Known implementation inputs

- #64 closed the remaining synchronous custom-session teardown boundary in
  PR #86.
- #70 completed normalized message/update projection in PR #88; accepted
  updates remain retained and page by source `seq`. #96–#98 supply joint reads,
  split durable/live delivery and alias deltas. #105–#107 own the friendly
  Client stack; #105 landed the private Runtime source, hydrated namespaces,
  one commit and one delivery primitive in PR #116.
- `docs/issue-71-dx-contract-v2.md` is historical. #105 deliberately diverged
  from it — zero-argument namespace listeners, a flat `ClientAccountState`,
  `connection?: Status`, and one presence primitive on `contacts` — and where
  the two disagree, `src/runtime/client.ts` on `master` wins. #106's interface
  block was corrected to the landed shapes on 2026-08-03.
- `docs/client-stack-defect-ledger.md` spans #105–#107 and does not reset per
  PR. Its "Inherited obligation" lines are binding on later layers.
- **#106's shape was re-decided on 2026-08-03 and is no longer the handle.** A
  four-way design exercise replaced `chats.open() => WhatsAppConversation` with
  a fifth `messages` namespace: no handle, no `open()`, no per-chat `close()`.
  Three of four independent designs concluded the handle was what created the
  layer's hazards, and the fourth — briefed to defend it — conceded the retired
  per-`open()` design stayed typeable under it. Trap 1 is now unavailable rather
  than discouraged. Two further claims made here on the day of the decision were
  **wrong and are corrected in #106**: widening `NAMESPACES` is not free (it is a
  `TS7053` error against `ordered`, and `reset()` needs an explicit
  `retained.clear()`), and the fill rule alone does not make stale page results
  impossible — entry identity is also required, and a converging catch-up
  transient remains and is disclosed. Read #106, not this paragraph, for the
  mechanisms. Retention is deliberately unbounded in 0.3 and tracked by #121.
  C1's inherited obligation records the discharge.
- `libsqlBackend()` now persists credentials, accepted/current data, and leases;
  `fileMediaStore()` supplies the separately injected restart-safe media bytes.
- `fileStore()` remains the credential-only option for the independently usable
  Session. The durable 0.3 Runtime path composes `libsqlBackend()` with an
  explicitly injected Media Store; no additional local-backend wrapper ships.
- The Ambient Agent v3 PocketBase spike remains fixture evidence on the old
  package. Production integration still waits for a published release with
  durable media and a persistent runtime backend.

## Next step

The owner locked Postgres, S3-compatible media and dependent browser delivery
to post-0.3. #63 and #39 were removed as redundant because libSQL plus injected
filesystem media already supplies the local durable composition.

The replacement 0.3 graph is:

```text
completed substrate: #64  #70  #96  #97  #98  #105

#117 proof:pack observes the artifact under test
  ↓
#106 conversations, paging, recovery and lifetimes
  ↓
#107 public/packed Client cut   ← the friendly Client becomes the package root
  ↓
#108 durable operations
  ↓
#109 pairing and unlink
  ↓
#111 real-account P4
  ↓
#112 release candidate
  ↓
#113 publish 0.3.0
```

The graph is now one line. A child may start from its predecessor's reviewed
exact head after the documented handoff gate, targets that predecessor while
stacked, and never merges before it. #106–#112 are fully specified for agents
and #113 is a human release operation.

#117 went first because `pnpm proof:pack` could pass having observed a `dist/`
built before the change under test — a false green in six gates at once. It now
builds before packing and runs in CI.

Its residue is **#119**, and C6 in `docs/client-stack-defect-ledger.md` is the
only place that describes it; anything else points there. Bare `pnpm pack` is
still stale-prone, `release.yml` publishes a tarball the packed proof never
inspected, and the positive control catches an empty `dist/` but not a wrong
one. **#112 and #113 depend on #119**: #113's acceptance requires that the
registry tarball match #112's reviewed packed artifact, and nothing in the
release path establishes that until #119 lands.

#107 is worth more than its position suggests. It is the node that makes
`createWhatsAppClient` reachable at all. The package exports exactly `.`,
`./testing` and `./package.json` (`package.json:29-33`), and
`tests/packed-imports.ts:137-139` asserts every other subpath rejects with
`ERR_PACKAGE_PATH_NOT_EXPORTED` — so an installed consumer cannot deep-import
its way to the friendly Client. It gets the raw frame surface at
`src/index.ts:55-106` or nothing. The OpenTUI application that will later
produce #110's bindings is blocked on exactly that, and on #108 for sends.

#118 was absorbed into #106 rather than tracked beside it. The reasoning is
`docs/issue-71-postmortem.md:79` — 19 of 28 findings were "same class, new
site", recurring after a fix — together with C10 in the defect ledger, which
draws the conclusion those recurrences support: an obligation is missed when
the correct path costs more to type than the incorrect one, and a firmer
sentence in a document never changes that. An obligation in a sibling issue an
executor may not open is the most expensive path of all.

Post-0.3 and research lanes do not block that spine:

```text
#50 real Android history research ──┐
#113 published 0.3 ─────────────────┴─→ #25 automatic history
#108 ─→ #110 extract @whatsappd/react once a real OpenTUI consumer is stable
#113 ─→ #72 restartable media jobs
#113 ─→ #73 … #80 domain expansion
#113 ─→ #81 Postgres ─┐
#113 ─→ #82 S3 ───────┴─→ #83 browser delivery → #84 browser proof
```

PocketBase (#26–#32) and Convex (#33–#37) remain deferred until a concrete
consumer is selected. `CHAT-15` and `CALL-04` remain intentionally unsupported;
`ACC-14`, `CONTACT-07`–`CONTACT-08`, `MEDIA-06`–`MEDIA-07`, `MEDIA-09`, and
`OBS-03` retain their catalogue application-owned boundaries.

## Resuming in a new session

Read this file, the capability catalogue, `CONTEXT.md`, relevant ADRs, and the
latest execution receipt on #15, then open the frontier issue bodies. Do not
reconstruct blockers from older #15 comments. `src/runtime/` is real product
code; reopening an accepted decision requires an explicit superseding ADR.
