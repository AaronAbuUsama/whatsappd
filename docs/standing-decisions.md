# Standing decisions

What this repository has decided and must not quietly re-decide. Everything
here is true until a superseding decision replaces it, and none of it changes
when an issue closes.

**This file holds no execution state.** Which node is next, what is blocked,
what merged, and which PRs are open are derived from GitHub:

```bash
pnpm state
```

`tooling/checks/execution-state.ts` derives this from the `## Blocked by` edges
the issues already declare; no document duplicates that changing state.

## Where things live

| Artifact                                         | Location                                      |
| ------------------------------------------------ | --------------------------------------------- |
| Node state, blockers, frontier                   | GitHub Issues, via `pnpm state`               |
| Accepted architecture decisions                  | `docs/adr/` — the filenames are the decisions |
| Shared domain language                           | `CONTEXT.md`                                  |
| Internal architecture and capability guides      | `docs/architecture/`                          |
| Development, delivery, and operations procedures | `docs/runbooks/`                              |
| Published build specification                    | GitHub issue #15                              |
| Shipped product path                             | `packages/whatsappd/src/`                     |

Architecture guides summarize the product surface without governing it;
accepted ADRs and shipped code are authoritative.

## Decisions with no ADR

`docs/adr/` is the authority for everything numbered. These were accepted in
review or in the specification and never became ADRs; they are recorded here so
that "it has no ADR" is not mistaken for "it was never decided".

| Decision                                                                                 | Origin        |
| ---------------------------------------------------------------------------------------- | ------------- |
| Connection and presence remain ephemeral; remote connection truth expires with its lease | PR #12 review |
| Conversation-sync deletion requires explicit, scope-bounded replacement metadata         | PR #12 review |
| Executing command claims expire to terminal `outcome_unknown`, never automatic retry     | PR #12 review |
| Actorless receipts use a non-null aggregate subject for idempotent projection            | PR #12 review |
| Ambient Brain follows accepted source batches, not live callbacks or mirror patches      | Architecture  |
| No compatibility aliases or wrappers ship in the hard-cut package line                   | ADR-0013/spec |
| `whatsappd/testing` drives events and records commands without sleeps                    | ADR-0013/spec |
| Changesets releases the package family as a fixed lockstep group once one exists         | Spec          |

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

The proof ladder these claims climb is defined in `CONTEXT.md`. A lower rung
does not establish a higher claim. Browser screenshots accompany semantic,
interaction, console, and network assertions; they do not replace them. A
Database Oracle independently cross-checks stable identities, order,
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

Until the first prototype proves otherwise, UI language may say "no older saved
messages" and "request sent"; it may not say "all history loaded", "no more
WhatsApp messages", or report a delivered count tied to the request.

## A linked test account is a one-time human cost

Pairing a real WhatsApp device is the only step in the proof ladder a human has
to perform, and it must be performed once rather than once per run.

`libsqlBackend()` persists credentials, and `createWhatsAppRuntime` hands that
store straight to the session (`packages/whatsappd/src/runtime/runtime.ts:714`), so a Runtime whose
database file survives the process resumes its link with no human present. The
same is already true of `fileStore` at the Session layer, which is why
`proofs/runners/proof.ts` re-runs without a second QR scan.

Therefore every real-account proof:

- keeps its database, media, and credentials in a durable **profile directory**
  under the gitignored `proofs/private/`, and never deletes it between runs;
- pairs only when that profile holds no credentials;
- treats a rerun after a code change — which any head-bound receipt forces — as
  a resume, not a re-pair.

Two steps genuinely require an unlinked start: proving pairing itself, and
proving unlink. Those run against a **separate, throwaway profile**, so the
durable profile keeps its link. One WhatsApp account supports several linked
devices, and each profile is one of them.

Nothing about this weakens a proof. A resumed credential is the product
behavior ADR-0005 and #109 exist to establish; requiring a human to re-scan is
not a stronger claim, only a more expensive one.

**Two profiles were linked on 2026-08-05, on two distinct numbers**, which makes
the test peer a second real account rather than a self-send:

| Profile   | Primary phone      | Role                                         |
| --------- | ------------------ | -------------------------------------------- |
| `ios`     | iPhone             | peer; the account behind the #18 P4 receipts |
| `android` | Samsung Galaxy S25 | subject; also the #50 platform arm           |

`android` is the subject for anything that publishes a receipt. Its mirror is
small enough to assert against, and a proof whose fixtures are someone's actual
correspondence is one nobody can safely publish. Each profile is one account and
one process — ADR-0009 means two runtimes cannot share a database.

The profiles are the only thing here a human has to recreate, and only if a
machine is lost. `pnpm proof:profile <name>` establishes or resumes one.

## Standing facts about the 0.3 Client

- **The conversation handle does not exist.** #106 replaced
  `chats.open() => WhatsAppConversation` with a fifth `messages` namespace: no
  handle, no `open()`, no per-chat `close()`. Three of four independent designs
  concluded the handle was what created the layer's hazards, and the fourth —
  briefed to defend it — conceded the retired design stayed typeable under it.
  Anything that still names `conversation.*` is superseded text, not a contract.
- Client message retention is deliberately unbounded, with the reasoning and the
  measurements it waits on recorded in #121. The README states the growth
  plainly rather than going quiet about it.
- `libsqlBackend()` persists credentials, accepted/current data, and leases;
  `fileMediaStore()` supplies the separately injected restart-safe media bytes.
  `fileStore()` remains the credential-only option for the standalone Session.
  No additional local-backend wrapper ships.
- The Ambient Agent v3 PocketBase spike remains fixture evidence on the old
  package. Production integration waits for a published release with durable
  media and a persistent runtime backend.
- Postgres, S3-compatible media, and dependent browser delivery are post-0.3.
  PocketBase and Convex substrate work stays deferred until a concrete consumer
  is selected. `CHAT-15` and `CALL-04` are intentionally unsupported; `ACC-14`,
  `CONTACT-07`–`CONTACT-08`, `MEDIA-06`–`MEDIA-07`, `MEDIA-09`, and `OBS-03`
  retain their catalogue application-owned boundaries.

## Resuming in a new session

Read `CONTEXT.md`, this file, the relevant ADRs, and `docs/architecture/sdk-capabilities.md`.
Then run `pnpm state` and open the frontier issue bodies. Do not reconstruct
blockers from prose in any document, including this one — `## Blocked by` on the
issue is the edge. `packages/whatsappd/src/runtime/` is real product code; reopening an accepted
decision requires an explicit superseding ADR.
