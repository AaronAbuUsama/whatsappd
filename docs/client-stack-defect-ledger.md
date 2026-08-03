# Client stack — persistent defect-class ledger

One ledger for the whole 0.3 Client stack (#105, #106, #107). Each PR restarts
its numeric round counter at 1 and keeps its own four-round ceiling; this file
does not reset. It exists because PR #94's ledger reset hid that #93 and #94
were one review loop relabelled as two attempts
(`docs/issue-71-postmortem.md` §1).

Opened at #105 / PR #116. A class is closed only when a _value-level primitive_
makes it unreachable by construction — an ordering rule re-established by hand
at each site is what recurred nineteen times across the retired work.

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

**Root cause of the recurrence**: the fix satisfied the ADR's example rather
than its property. **Fixed at the layer that decides it** — the delivery-scoped
value is now the whole derivation basis (`Derivation = { at, claim, identity }`),
sampled once per delivery.

**Inherited obligation.** Anything a read derives from that can change without a
transition belongs in `Derivation`, not sampled at the read. Adding a field to
what reads consult means adding it there.

### C3 — recovery or termination as a detached task rather than a Client state

**Closed by** reporting a follow failure as account state. A durable-follow
failure that the Runtime's terminal frame cannot describe now commits a closure
carrying the error and releases the live channel, instead of emitting a warning
and going quiet. A Client that silently stops following renders state that can
never change again while reporting itself live — the exact condition Runtime
Closure exists to make impossible (`CONTEXT.md`), one layer up.

**Inherited obligation.** Every path that can end following ends it _visibly_.

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

**Inherited obligation.** Derive mutations from decision points, not intuition.
Keep the harness out of the PR (issue #52's lesson: a harness in the diff
generates unbounded findings).

### C8 — ordering determinism

**Closed by** `compareId` in `src/runtime/client.ts`, routed through by every
ordered read. `localeCompare` disagrees with the stores' binary ordering. This
is the control case from `docs/issue-71-postmortem.md` §3 — a value-level
primitive that never recurred.

## Properties that are structurally unprovable at layer 1

Recorded so a later layer does not mistake them for missing tests. Each becomes
provable only if the substrate changes.

| Property                                           | Why no test can fail red                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replace()` clears chats / groups / aliases        | Only contacts have a delete producer (`MirrorDelete` is contact-only by type, ADR-0019/0022), and alias rows are insert-only in both stores. Nothing else can ever _disappear_ from a snapshot. |
| Freed native ids are dropped from the alias map    | `projection.ts` re-points every freed id in the same patch, so the sweep changes no read. It is required by #105 and bounds alias-map growth.                                                   |
| The delivery basis is restored rather than cleared | Save/restore is defensive against a nested `commit`, which no public path can currently produce.                                                                                                |
| `close()` clears listeners; `close()` is memoized  | After `detached` is set and the pump has ended, no commit follows, so neither is behaviourally observable. Both are hygiene.                                                                    |

## Substrate issues observed but out of scope

- `claim.expiresAt` originates from the lease store's clock (`libsql.ts` computes
  it with `julianday('now')`) and is compared against a process `Date.now()`.
  Postmortem R23 class. Damage is bounded by `freshnessMs`, which is
  process-clock and binds tighter.
- `pnpm proof:pack` is not in CI and does not rebuild.
