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

**How "closed" is decided here, because an earlier version of this file got it
wrong.** A class is not closed because its fix looks structural. It is closed
when someone has _written the violating code, compiled it, and run the suite_.
An audit did exactly that against the round-2 head and found four classes
recorded here as closed whose violations compiled clean and passed all 374
tests. Every entry below now says which test it stands on, and an entry with no
red test says so instead of claiming a guarantee it does not have.

## Classes

### C1 — publish before the transition is complete

**Closed by** `commit(mutate: (tx: Tx) => void): void` in `src/runtime/client.ts`,
which is not `async`. A function that cannot await cannot yield, so no
application callback can observe a half-applied transition. There is one
notification point per transition.

**Narrowed by** the bound writers. `put`, `drop` and `reset` are built _inside_
`commit`, closing over that transaction's `touch`, so there is nothing to call
from anywhere else — the same scope trick `current()` uses, run in reverse.
Storing a value used to be four things lined up by hand at eleven sites (the
right container, the copy, the announcement, and the announcement naming the
same namespace as the container); it is now one call that cannot do three of
them wrongly.

**Not fully closed, and the residue is named honestly.** The raw `Map`s are
still in factory scope, so a determined edit can bypass the writers. What
changed is that the bypass is now _greppable_ — a bare `chats.set(` with no
`put.chat` — where before the correct and incorrect paths looked identical.

**Inherited obligation.** Layers 2 and 3 add no second publication path. Every
new mutation goes through a writer inside `commit`; `fanout` is called from
exactly one site.

**The layer-2 half of that obligation was discharged by design rather than by
discipline, on 2026-08-03.** This entry used to end by saying conversation state
belongs in the factory beside the other cells and **not** in per-`open()` locals
with their own notification list — the retired design
(`docs/issue-71-postmortem.md` §2) which compiled clean against this head. That
sentence was an instruction, and C10 predicts instructions lose whenever the
wrong path is cheaper to type.

A four-way design exercise on #106 replaced the conversation handle with a fifth
namespace. **There is no `open()`, so there is no per-conversation call scope in
which to declare that variable.** The retired design stopped being the cheaper
path and became an unavailable one. That is the shape this file keeps asking for
and rarely gets: not a firmer sentence, but the removal of the thing the sentence
was guarding.

The residue is unchanged and still named — the raw `Map`s remain in factory
scope, so a determined edit can still bypass the writers. What is closed is the
specific recurrence that killed PRs #93 and #94.

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

**Carve-out added at #106, because the obligation as written forbade the correct
code.** `messages.older()` reads the raw `following` variable rather than
`basis().following`. That is deliberate and is _not_ a live read: routing it
through the frozen delivery basis would make a call from inside a fanout see the
basis as it was before a listener closed the Client, and issue a storage read
against a Backend the application already owns the closing of. The obligation
governs reads that _derive a reported value_; a guard deciding whether to
perform an effect needs the current fact, not the delivery's.

**Recurred a third time, at #106 review round 1, on a new axis.** `older()` is
the first public path that commits _synchronously_, so a listener calling it —
the infinite-scroll shape the issue documents — ran a whole nested `commit`
inside the outer `fanout`. The nested one sampled a second basis and then
restored the outer, older one, so a sibling listener watched a presence expire,
return, and expire again with no live frame between. **Closed by** `commit`
reusing an in-progress basis (`delivery = outer ?? sample()`) instead of
re-sampling: a nested transition is part of the same synchronous burst, which is
exactly the unit ADR-0028 says cannot split. Pinned by a test that crosses a
freshness deadline from inside a listener that pages.

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

**Closed by** moving the resolution _inside_ the thing it resolves for. The
presence map is now private to a three-operation primitive (`read`, `retain`,
`release`); `formsOf` is called within it, so there is no way to reach an entry
without resolving the subject first. Routing two call sites through a shared
helper was the first attempt, and it was still an instruction — an audit showed
a third site keying the raw address compiled clean.

`retain` deliberately keys by the address WhatsApp delivered: a presence carries
no Address Resolution evidence of its own, and an address with no contact record
yet must still have somewhere to live (ADR-0020).

**Recurred a second time, at review round 3, on the primitive's own third
seam.** `read` and `release` resolved the subject; `retain` did not — correctly,
since a presence carries no Address Resolution evidence — but `read` then
answered in the contact's `nativeIds` order and returned the _first_ current
hit. So a peer who went idle in a 1:1 (observed under its PN) and then started
typing in a group (observed under its LID) was reported idle, on both forms, for
the whole freshness window; and the delivery announcing the change reported the
state before it.

**Closed by** ordering on arrival. The primitive stamps each retained
observation with a counter and `read` returns the newest current one. The first
attempt ordered on `expiresAt` and was wrong for a reason worth recording: two
observations of one peer routinely land in the _same millisecond_, and
`expiresAt` is the observation instant plus a constant, so it cannot separate
them. The test caught it.

**Pinned by** three red tests — a read that does not span the forms, a release
that does not, and a read that answers in `nativeIds` order rather than newest.

**Inherited obligation.** Layer 2's opened-conversation presence uses this
primitive rather than its own map.

**Discharged at #106 by absence, not by compliance.** There is no
conversation surface in the `messages` namespace, so there is no second presence
map and nothing for the obligation to bind to — `contacts.presence(nativeId)`
remains the only presence read in the Client. Recorded rather than dropped
silently, because "no instance" and "obligation met" are different claims and a
later layer that adds a per-chat presence surface inherits this entry unchanged.

### C4 — ownership defined by API visibility rather than memory provenance

**Narrowed by** `own()` = `structuredClone` + deep freeze, now called by the
writers rather than by each ingest site, so a value cannot be stored without
being copied through `put`. Reads return stored values directly.

`put.closed` and `put.page`'s failure branch are the two writers that
deliberately do _not_ copy — the second added at #106, for the same reason and
required by its acceptance criteria. The Runtime
hands a terminal error out by identity so a caller can compare it against the
cause it holds — and copying would also throw outright on an error carrying a
function in its `cause`, losing the very failure being reported. Proven: an
audit ran `structuredClone` against that shape and got `DOMException: () => {}
could not be cloned`.

**Residue.** Three of the writers' copies are pinned by a red test; the account
path is not independently falsifiable, because every reachable account change
also marks through `put.connection` or `put.closed`.

**#106 added two more copies and, at review round 1, neither was falsifiable** —
both `own()` calls could be deleted with the whole suite green. Now pinned by a
test that asserts the frozen shape and a caller's mutation throwing, for the
live-patch writer and the page writer separately.

`entry.before` is the one value entering `retained` that is neither `own()`ed
nor one of the two documented exceptions. It is two primitives behind
`readonly`, never handed to a caller, and both shipped adapters copy it on the
way out — so the exposure is a third-party `WhatsAppBackend` returning an
aliased cursor, and the damage is confined to this Client's own paging. Recorded
rather than fixed.

### C5 — one listener Set holding several roles

**Closed by** `fanout()` in `src/runtime/runtime.ts`, shared by the Runtime's
channels and the Client's namespaces, plus registration _records_ rather than
callbacks as Set members.

**Pinned by** the listener-rule tests, and — since round 3 — by one that
subscribes a single function twice and asserts two deliveries, then releases one
and asserts one more. Until that was written, a Set deduped by callback identity
passed the entire suite, which is this file's own rule going unapplied to itself.

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
- `pnpm proof:pack` archived whatever `dist/` held — `pnpm pack` does not
  rebuild — and was **absent from CI**. Both fixed by #117: the script now
  builds before packing, and CI runs it on the Node 22 and Node 24 legs.
  Verified the way this file requires — the violating state was reproduced
  (a forbidden root export, no build, exit 0) and then made red.
- **The residue is that the fix is in the caller, not the proof.** `pnpm pack`
  by itself still packs a stale `dist/`, so `proof:pack` is trustworthy and
  bare packing is not. Two live consequences: `.github/workflows/release.yml`
  builds and packs but never runs `proof:pack`, so a published tarball is one
  the packed proof never inspected; and the positive control at
  `tests/packed-imports.ts:51-57` names symbols present in _any_ recent build,
  so it catches an **empty** `dist/` and not a **wrong** one. This class stays
  open on that second point — a wrong-but-nonempty artifact still reads green.
  Both consequences are filed as #119, and the second is confirmed rather than
  reasoned: building `dist/` from `7e1a730` (pre-#105 master, before
  `src/runtime/client.ts` existed — 1,175 insertions of divergence) and running
  the harness bare passes every assertion, positive control included.
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

**Held by** `compareId` in `src/runtime/client.ts`, routed through by every
ordered read, and pinned by a test that first asserts its two fixtures order
_differently_ under binary and locale rules before using them.

**And it is a rule, not a construction** — a new sort site can call
`localeCompare` and it compiles. It never recurred anyway, which is the useful
correction to this file's own thesis: what predicts recurrence is not
enforceability but whether the wrong path is _cheaper_. `compareId(a, b)` costs
the same keystrokes as `a.localeCompare(b)`. "Remember to announce what you
changed" cost strictly more than not bothering — which is why that one recurred
and this one did not.

### C10 — a rule whose wrong path is the cheaper one

The generalisation of everything above, recorded so a later layer can apply the
test rather than re-derive it.

Before adding an obligation, ask what the _cheapest_ thing a future author can
type is. If the correct path costs more than the incorrect one, the obligation
will be missed — no matter how clearly it is documented here. The fix is never
a firmer sentence in this file; it is making the cheap path the correct one, or
making the wrong one unavailable.

Applied: the ordered-read caches are keyed (`delete ordered[namespace]`) rather
than an `if`-chain per namespace, so adding a namespace cannot leave a stale
cache behind a branch nobody extended; and `NAMESPACES` defines `Namespace`
rather than being annotated with it, so widening the type without widening the
array is a compile error instead of a snapshot that silently stops recovering.

## Properties that are structurally unprovable at layer 1

Recorded so a later layer does not mistake them for missing tests. Each becomes
provable only if the substrate changes.

| Property                                                    | Why no test can fail red                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replace()` clears chats / groups / aliases                 | Only contacts have a delete producer (`MirrorDelete` is contact-only by type, ADR-0019/0022), and alias rows are insert-only in both stores. Nothing else can ever _disappear_ from a snapshot.                                                                                               |
| Freed native ids are dropped from the alias map             | `projection.ts` re-points every freed id in the same patch, so the sweep changes no read. It is required by #105 and bounds alias-map growth.                                                                                                                                                 |
| ~~The delivery basis is restored rather than cleared~~      | **No longer unprovable — falsified at #106.** `messages.older()` commits synchronously, so a listener calling it produces exactly the nested `commit` this row said no public path could. Save/restore is now load-bearing, and re-sampling instead of reusing the outer basis is a red test. |
| `close()` releases each registration; `close()` is memoized | After `following` is false and the pump has ended, no commit follows, so neither is behaviourally observable. Releasing each registration detaches caller-supplied abort signals; the memo makes concurrent closes join. Both are hygiene.                                                    |
| `put.account`'s and `put.connection`'s marks, separately    | Mutually redundant: every reachable account change marks through at least one of them, so neither is falsifiable alone. Removing **both** is caught.                                                                                                                                          |
| `put.alias`'s mark                                          | Redundant with `put.contact` — every alias the projection emits accompanies the contact upsert that produced it (`projection.ts`). Not, as an earlier note here said, with `put.connection`.                                                                                                  |
| `error` present-but-`undefined` on a closure                | `error` is spread rather than tested, so a failure whose cause _is_ `undefined` still reports the key. Correct in code, and **unproven**: no public path constructs a terminal failure with an `undefined` cause.                                                                             |

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
- `pnpm proof:pack` — **see C6, which is the only entry that states this.** It
  was restated here, and when #117 fixed it C6 was updated and this line was
  not, so the file contradicted itself for one commit. That is C10 applied to
  the ledger instead of by it: the cheap path is editing the site you happen to
  be looking at. One fact, one home, and a pointer from anywhere else.

## #106 / the `messages` namespace — review rounds

Round counter restarts at 1 here; the classes above do not.

**The GitHub Codex reviewer was unavailable for this run, confirmed by the
repository owner**, so rounds are performed by independent fresh-context local
review agents instead — the same substitution recorded on PR #116, and recorded
here rather than left implicit. Three lenses per round: correctness of the
page/live reconciliation, defect-class recurrence, and contract/scope.

### Round 1 — `c81b671`

Four real defects, and one root cause behind almost every test finding.

**The test root cause, because it is the more useful entry.** Three tracers
seeded fewer messages than one store page (25). The first `older()` therefore
returned everything and left the entry `"exhausted"`, so the _second_ one — the
one each test wrapped in a `hold()` gate believing it was holding a read open —
short-circuited on the single-flight guard before issuing any read. Measured: 0
reads. Every assertion after the gate passed on state nothing had touched. The
issue states this requirement explicitly, for tracer 2 only ("Fixture must
exceed one page so `nextBefore` is real"); it was applied there and nowhere
else. All three now seed above a page, and each asserts a read was issued and
that the entry is `"loading"` before the gate opens, so the vacuous shape cannot
come back quietly.

**Two real defects, both found by more than one lens:**

1. **`close()` mid-read stranded `older: "loading"` for ever.** The guard was on
   the _commit_ rather than on the _effect_, so the transition that ended
   following left a per-chat field mid-flight, describing a read that could
   never finish and that `older()` would never restart. Fixed by binding the two
   facts into one `endFollowing()` — C10 applied rather than restated, since
   `following = false` alone is now greppable and wrong.
2. **A nested `commit` inside a `fanout` ran the derivation basis backwards.**
   Recorded under C2 above as that class's third recurrence.

**Two lower-severity ones:** `older()` could issue a read after a listener
closed the Client inside the loading-mark fanout (now guarded and pinned); and
the success `commit` sat inside the same `try` as the read, so a throw while
_applying_ a page would have committed a failure on top of a half-inserted
buffer and blamed the mirror for it. The second is unreachable with both
in-tree stores and was fixed because the guard shape read as though it already
protected against it.

**The finding the issue invited by name was not found, and the negative result
is recorded rather than a manufactured substitute.** No sequence produces a
permanently wrong result from the fill rule plus entry identity. The argument
bottoms out in two places: a page is never pinned below the Client's own applied
revision, because a patch is published only after the accept that produced it
resolved and both stores read at-or-after that point; and every patch after the
entry exists lands in the buffer, because entries are removed only by
`retained.clear()`, which is exactly what makes the identity check reject the
in-flight page.

**The one window where it does strand is a specification gap, and it is closed
by ordering rather than by the named fallback.** If the entry did not exist for
part of a read's life, `put.message`'s drop rule would discard exactly the
patches that repair the page about to land, and the stale page would be
permanent. The issue mandates that `get()` creates the entry and says nothing
about `older()` — which is the primary way a chat is first filled — so an
implementer following its text literally can write the stranding version and
satisfy every acceptance criterion. `older()` creates the entry synchronously
before issuing its read, and a tracer fails red if that moves. Per-message-id
revisions would not have helped: a dropped patch has no entry to record a
revision in.

**Mutation audit at the round-1 fix head.** Twelve mutations derived from the
diff's decision points rather than from the author's model of it, each written,
compiled and run: fill rule removed, `touch("messages")` removed, entry-identity
guard removed, both `own()` calls removed separately, drop rule removed,
`retained.clear()` removed, ascending tie-break, `localeCompare` tie-break,
nested-commit basis re-sampled, and both `following` guards in `older()`. All
twelve fail red. Before round 1 the first five and the last two did not.
