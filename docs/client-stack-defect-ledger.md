# Client stack — persistent defect-class ledger

One ledger for the whole 0.3 Client stack (#105, #106, #107). Each PR restarts
its numeric round counter at 1 and keeps its own four-round ceiling; this file
does not reset. It exists because PR #94's ledger reset hid that #93 and #94
were one review loop relabelled as two attempts
(`docs/issue-71-postmortem.md` §1).

Opened at #105 / PR #116, **at round 2 rather than before round 1** — the
protocol asks for it before review is requested, and rounds 1 and 2 were
requested against `4ecd58f`/`cfd8bc5` and `c57714f` before this file existed.
No history was lost, because this is the stack's first PR and there was nothing
prior to inherit, but the receipt is late and the record should say so rather
than read as though it had always been here.

Classes are numbered after `docs/issue-71-postmortem.md` §3, which is why the
numbering is not contiguous: **C7 (docs audited by string, not by surface) has
no instance in this stack** and is retained as a number so a reader can match
these against the postmortem's table.

A class is closed only when a _value-level primitive_ makes it unreachable by
construction — an ordering rule re-established by hand at each site is what
recurred nineteen times across the retired work.

## Classes

### C1 — publish before the transition is complete

**Closed by** `commit(mutate: (tx: Tx) => void): void` in `src/runtime/client.ts`,
which is not `async`. A function that cannot await cannot yield, so no
application callback can observe a half-applied transition. There is one
notification point per transition.

**Inherited obligation.** Layers 2 and 3 add no second publication path. Every
new mutation goes through `commit`; `fanout` is called from exactly one site.

### C2 — decaying state whose currency depends on a scheduler

**Closed by** deriving live state from `(observation, claim, instant)` at read
time. **There are no timers anywhere in the Client.** Reintroducing one reopens
the class.

**Recurred once, inside this PR, and that is the important entry.** The first
implementation threaded only the _instant_ through a delivery and re-sampled the
claim and the session identity per read. A listener may legitimately stop the
Runtime, and `release()` clears the lease and the session synchronously — so
listeners after that one observed a different connection, presence and identity
_from the same transition_. That is ADR-0028's contradiction re-instantiated on
a different axis: the ADR names the instant because the clock was the axis
issue #71 argued about, but its requirement is general.

**Root cause of the first recurrence**: the fix satisfied the ADR's example
rather than its property. The delivery-scoped value became the whole basis —
`Derivation = { at, claim, identity }`, sampled once.

**Recurred a second time, at review round 2, and that is the entry that
matters.** The round-1 fix introduced `detached`, a flag written outside
`commit` and read by `current()` — so a listener calling `client.close()`
mid-fanout again gave later listeners a different connection and presence from
the same transition. Three sites, one class.

The reason it kept recurring is that `Derivation` was **a discipline wearing a
primitive's clothes**. `current()` was defined inside the factory closure, so
reaching a stray variable was _easier_ than the correct path of adding a field
to `Derivation` and `sample()`. The default was wrong and the compiler was
silent — the "commit before notify" shape, not the `compareId` shape.

**Closed by construction at round 2**: `current()` and `Derivation` moved to
module scope, closed over nothing. The function now physically cannot consult
anything but its two parameters, so reaching a new input _requires_ adding it to
`Derivation`, which is the one place it can be sampled once per delivery.
`following` (was `detached`) is a field there like any other.

**Inherited obligation.** Keep `current()` at module scope. The moment it moves
inside the closure, or a live read is written that does not route through it,
the class is open again.

### C3 — recovery or termination as a detached task rather than a Client state

**Closed by** reporting a follow failure as account state. A durable-follow
failure that the Runtime's terminal frame cannot describe now commits a closure
carrying the error and releases the live channel, instead of emitting a warning
and going quiet. A Client that silently stops following renders state that can
never change again while reporting itself live — the exact condition Runtime
Closure exists to make impossible (`CONTEXT.md`), one layer up.

**Inherited obligation.** Every path that can end following ends it _visibly_.

### C9 — one fact answered two ways at two seams

New in this stack; the postmortem has no number for it.

A presence is keyed by the address WhatsApp used, while a contact is one peer
under several native forms. The **read** was taught to span a contact's forms
and the **removal** was left keying the delivered address alone, so an
`unavailable` naming a consolidated contact's LID removed nothing and both
forms went on reporting `typing` with nothing able to end it. That is the same
class as the original defect — the live and durable halves of one fact
disagreeing — closed on one path and left open on its sibling.

**Closed by** `formsOf(nativeId)`: one function returning every address that
speaks for a subject, with the read and the removal both routed through it.
"Resolve the subject the same way on both paths" is an instruction; one function
they both call is the primitive.

**Inherited obligation.** Any new presence-shaped read or write goes through
`formsOf`. Layer 2's opened-conversation presence is the next such site.

### C4 — ownership defined by API visibility rather than memory provenance

**Closed by** `own()` = `structuredClone` + deep freeze, once, at ingest. Reads
return stored values directly. The terminal `error` is deliberately exempt: the
Runtime hands it out by identity so callers can compare causes.

### C5 — one listener Set holding several roles

**Closed by** `fanout()` in `src/runtime/runtime.ts`, shared by the Runtime's
channels and the Client's namespaces, plus registration _records_ rather than
callbacks as Set members.

**Recurred once, inside this PR.** Membership was copied per namespace rather
than per transition, so a listener reached under one namespace could add or
remove one under a namespace the same delivery had not visited yet. **Fixed at
the granularity decision**: one tagged Set, so the copy spans the transition by
construction.

### C6 — a proof that reports green having observed nothing

**Not closed. Partially mitigated, and the one to watch.**

- `tests/packed-imports.ts` was all-negative assertions; a stale, empty or
  declaration-less `dist/` satisfied every one. A positive control now asserts
  the declarations were actually read and contain known-published symbols.
- `pnpm proof:pack` still archives whatever `dist/` holds — `pnpm pack` does not
  rebuild — and is **absent from CI**. Filed separately; not fixed here.
- The round-1 mutation audit chose its mutations from the author's model of the
  design, so it was blind exactly where the design was. Round 2 derived them
  from the code's decision points instead, and killed 39 of 46 where the first
  set killed 20 of 25.
- **A test double that diverges from the adapter it stands in for is this class
  too.** `createTestWhatsAppSession` returned a stable identity object while the
  live session (`src/baileys/socket.ts`) builds a fresh one per call, so a cache
  keyed on object identity passed its test and was inert in production. The
  double now allocates per call, and the test fails red against the real shape.

**Inherited obligation.** Derive mutations from decision points, not intuition.
Keep the harness out of the PR (issue #52's lesson: a harness in the diff
generates unbounded findings). When a double stands in for an adapter, match the
adapter on the axis under test — especially object identity.

### C8 — ordering determinism

**Closed by** `compareId` in `src/runtime/client.ts`, routed through by every
ordered read. `localeCompare` disagrees with the stores' binary ordering. This
is the control case from `docs/issue-71-postmortem.md` §3 — a value-level
primitive that never recurred.

## Properties that are structurally unprovable at layer 1

Recorded so a later layer does not mistake them for missing tests. Each becomes
provable only if the substrate changes.

| Property                                                    | Why no test can fail red                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replace()` clears chats / groups / aliases                 | Only contacts have a delete producer (`MirrorDelete` is contact-only by type, ADR-0019/0022), and alias rows are insert-only in both stores. Nothing else can ever _disappear_ from a snapshot.                                            |
| Freed native ids are dropped from the alias map             | `projection.ts` re-points every freed id in the same patch, so the sweep changes no read. It is required by #105 and bounds alias-map growth.                                                                                              |
| The delivery basis is restored rather than cleared          | Save/restore is defensive against a nested `commit`, which no public path can currently produce.                                                                                                                                           |
| `close()` releases each registration; `close()` is memoized | After `following` is false and the pump has ended, no commit follows, so neither is behaviourally observable. Releasing each registration detaches caller-supplied abort signals; the memo makes concurrent closes join. Both are hygiene. |

## Decisions taken here that a later layer may want to revisit

- **`account.get()` returns a fresh view per read.** It derives from the clock,
  so it cannot be memoized against a transition. A referentially-stable snapshot
  is what `useSyncExternalStore` needs, and ADR-0023 assigns selectors and hooks
  to `@whatsappd/react`; React is a declared non-goal of #105. An attempt at it
  here was removed as speculative — and it was also inert, because it keyed on
  the session's object identity. Layer 3 should decide where the cache lives.
- **`closed` deliberately conflates a stopped Runtime with a failed follow.**
  Both mean "this Client is finished, make another one", and recreating is
  correct for either, so an application need not branch. If a later layer needs
  to distinguish them, add a cause to the closure record rather than a second
  boolean.
- **Presence ties break on the contact's own `nativeIds` order.** Two forms of
  one peer each holding a current observation is WhatsApp contradicting itself;
  `Observation` keeps no `observedAt`, so there is nothing to prefer by.

## Substrate issues observed but out of scope

- `claim.expiresAt` originates from the lease store's clock (`libsql.ts` computes
  it with `julianday('now')`) and is compared against a process `Date.now()`.
  Postmortem R23 class. Damage is bounded by `freshnessMs`, which is
  process-clock and binds tighter.
- `pnpm proof:pack` is not in CI and does not rebuild.
