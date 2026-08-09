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

**Closed by** `commit(mutate: (tx: Tx) => void): void` in `packages/whatsappd/src/runtime/client.ts`,
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

**Closed by** `fanout()` in `packages/whatsappd/src/runtime/runtime.ts`, shared by the Runtime's
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

**No open consequence. Still the one to watch — the class is an obligation, not
a construction.**

- `tests/packed-imports.ts` was all-negative assertions; a stale, empty or
  declaration-less `dist/` satisfied every one. A positive control now runs
  before them: the declarations must be non-empty, and the packed `dist/` must
  hash byte-for-byte identical to a rebuild from the working tree's source.
- `pnpm proof:pack` archived whatever `dist/` held — `pnpm pack` does not
  rebuild — and was **absent from CI**. Both fixed by #117: the script now
  builds before packing, and CI runs it on the Node 22 and Node 24 legs.
  Verified the way this file requires — the violating state was reproduced
  (a forbidden root export, no build, exit 0) and then made red.
- **The residue was that the fix was in the caller, not the proof**, and #119
  closed it at both live consequences. `.github/workflows/release.yml` now runs
  `pnpm proof:pack` before the publish step, so the tarball that reaches npm is
  one the packed proof inspected on the publishing commit. And the positive
  control no longer names symbols — `createWhatsAppRuntime` and friends are in
  every recent build, so they caught an **empty** `dist/` and not a **wrong**
  one. It compares the artifact instead. `pnpm pack` still archives a stale
  `dist/`, but the proof now says so rather than depending on its caller to
  prevent it — running the harness bare, without `proof:pack`'s build in front
  of it, is trustworthy for the first time.

  Verified on three violating states, each observed red by the digests it
  disagreed on rather than by an exit code. `dist/` built with `packages/whatsappd/src/` checked
  out from `7e1a730` — the repro #119 records — differs in four of its six
  files, and the retired control passed that same artifact green, re-confirmed
  by running master's harness against it on the fix branch. A planted
  `dist/zz-stale-sentinel.d.mts` reaches the tarball and is absent from the
  rebuild. A build stubbed to write nothing throws `ENOENT` on a `dist/` removed
  a line earlier, instead of comparing two stale directories equal.

  Note what the export surface could not have done: `packages/whatsappd/src/index.ts` is
  byte-identical between `7e1a730` and today, all 104 names, so a control
  derived from the published vocabulary — the obvious next-strongest idea —
  would have passed the exact artifact this one catches.

  **The ceiling is that this trusts `vp pack` to clean `dist/` and to be
  byte-idempotent.** Both hold today: the build logs `Cleaning 6 files`, and two
  consecutive builds hash identically. Losing idempotence turns the control red
  on every run, which announces itself. Losing the clean would let a stale file
  survive into both sides and read green — the one way this weakens quietly, so
  it is what a `vp` upgrade has to re-check.

- The round-1 mutation audit chose its mutations from the author's model of the
  design, so it was blind exactly where the design was. Round 2 derived them
  from the code's decision points instead, and killed 39 of 46 where the first
  set killed 20 of 25.
- **A test double that diverges from the adapter it stands in for is this class
  too.** `createTestWhatsAppSession` returned a stable identity object while the
  live session (`packages/whatsappd/src/baileys/socket.ts`) builds a fresh one per call, so a cache
  keyed on object identity passed its test and was inert in production. The
  double now allocates per call, and the test fails red against the real shape.

**Inherited obligation.** Derive mutations from decision points, not intuition.
Keep the harness out of the PR (issue #52's lesson: a harness in the diff
generates unbounded findings). When a double stands in for an adapter, match the
adapter on the axis under test — especially object identity.

### C8 — ordering determinism

**Held by** `compareId` in `packages/whatsappd/src/runtime/client.ts`, routed through by every
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

| Property                                                                | Why no test can fail red                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replace()` clears chats / groups / aliases                             | Only contacts have a delete producer (`MirrorDelete` is contact-only by type, ADR-0019/0022), and alias rows are insert-only in both stores. Nothing else can ever _disappear_ from a snapshot.                                                                                                                                                                                                                                                   |
| Freed native ids are dropped from the alias map                         | `projection.ts` re-points every freed id in the same patch, so the sweep changes no read. It is required by #105 and bounds alias-map growth.                                                                                                                                                                                                                                                                                                     |
| The delivery basis is restored rather than cleared                      | Still unprovable, and #106 did **not** falsify it — an earlier version of this row said so and was wrong. Replacing `finally { delivery = outer }` with `delivery = undefined` passes the whole suite. What #106 changed is the row below: a different property on the same two lines.                                                                                                                                                            |
| A nested `commit` reuses the running delivery basis                     | **Provable, and newly so at #106.** `messages.older()` commits synchronously, so a listener calling it produces the nested `commit` the row above said no public path could — but what fails red is `delivery = outer ?? sample()` replaced by `delivery = sample()`, not the restore. Conflating the two is how this table briefly claimed a proof it did not have.                                                                              |
| `close()` releases each registration; `close()` is memoized             | After `following` is false and the pump has ended, no commit follows, so neither is behaviourally observable. Releasing each registration detaches caller-supplied abort signals; the memo makes concurrent closes join. Both are hygiene.                                                                                                                                                                                                        |
| `put.account`'s and `put.connection`'s marks, separately                | Mutually redundant: every reachable account change marks through at least one of them, so neither is falsifiable alone. Removing **both** is caught.                                                                                                                                                                                                                                                                                              |
| `put.alias`'s mark                                                      | Redundant with `put.contact` — every alias the projection emits accompanies the contact upsert that produced it (`projection.ts`). Not, as an earlier note here said, with `put.connection`.                                                                                                                                                                                                                                                      |
| The retired per-entry revision watermark is absent                      | Verifiable by reading `Retained` — no revision field exists — and **not behaviourally**. A watermark only refuses a patch at or below the page's revision, and in the single-writer path every patch published after a page read has a higher one. The damaging case needs the Client lagging the mirror, and nothing in the public surface delays the frame pump. Reinstating the watermark exactly as #106 describes it passes the whole suite. |
| `stopped()` announces nothing when no read was running                  | The `entry.older !== "loading"` short-circuit in `put.page`'s ENDED branch can be deleted with the suite green. Its effect is real — without it every `close()` delivers a spurious `messages` notification to every subscriber — but no assertion counts deliveries on a Client that was idle when it closed.                                                                                                                                    |
| `entry.failure` is cleared by the next success, not by the next attempt | Clearing it on `put.page`'s started branch instead passes the suite. The contract says "cleared by the next success" and the issue tells applications to "track `error` and back off" — under the mutation `error` vanishes the moment the retry starts, so a back-off keyed on it never sees what it is backing off from. Thin enough that recording it is the proportionate response.                                                           |
| A page is applied atomically                                            | The outer `catch` in `older()` commits the failure and delivers either way, so half-applying a page and then reporting it is indistinguishable from applying none of it: the partial rows are real rows from that page and a retry fills the rest. Kept as defence in depth, claimed as nothing.                                                                                                                                                  |
| `error` present-but-`undefined` on a closure                            | `error` is spread rather than tested, so a failure whose cause _is_ `undefined` still reports the key. Correct in code, and **unproven**: no public path constructs a terminal failure with an `undefined` cause.                                                                                                                                                                                                                                 |

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

**Mutation audit at the round-1 fix head.** Thirteen mutations derived from the
diff's decision points rather than from the author's model of it, each written,
compiled and run: fill rule removed, `touch("messages")` removed, entry-identity
guard removed, both `own()` calls removed separately, drop rule removed,
`retained.clear()` removed, ascending tie-break, `localeCompare` tie-break,
nested-commit basis re-sampled, both `following` guards in `older()`, and
`endFollowing` ending following without ending the reads in flight. All thirteen
fail red. Before round 1, seven of them did not.

**One methodological correction, because it is the kind of thing this file
exists to catch.** The first pass of that audit applied mutations _by line
number_ while the diff was still moving, so two of them silently landed on the
wrong lines and reported a green suite as evidence of an unfalsifiable `own()`.
Re-run against matched content, both fail red. A mutation audit that cannot say
it mutated what it meant to is C6 wearing a lab coat — the audit needs the same
"did this actually observe anything" check it is applied to.

### Round 2 — `018ca47`

Two lenses: "did the round-1 fixes introduce new defects" and an independent
correctness pass over concurrency and failure. Four blocking findings, and the
important thing about them is that **three were caused by the round-1 fixes.**

**The repeated class, and why round 1's fix was the wrong shape.** One property
kept failing: _a chat must never say `"loading"` when no read is running._ Round
1 found it on the `close()` path and fixed it by adding a rollback at the two
sites that end following. That is an instruction-shaped fix, and C10 says those
lose. Round 2 found the same property broken two more ways:

- a throw while _applying_ a page — reachable through any third-party
  `WhatsAppDataStore`, and made **worse** by round 1's own fix, which moved the
  success `commit` outside the `try` to stop a mislabelled error and thereby
  traded a recoverable wrong label for a permanently unpageable chat with no
  `error` at all and no delivery;
- and the rollback itself, which corrected the stored value **beside** `commit`
  rather than through it, so it announced nothing. A poller saw the fix; a
  `useSyncExternalStore` binding — the consumer this namespace exists for — kept
  its cached `"loading"` snapshot for ever. That is the exact outcome the
  rollback's own comment claimed to remove, and it also made `endFollowing` a
  second publication path for namespace state, which C1's inherited obligation
  forbids outright.

**Replanned rather than patched again.** The root cause is that `older` was a
committed field whose lifetime is a read's lifetime, with five exits — success,
read failure, apply throw, close, follow failure — each separately responsible
for ending it _and_ announcing it. Ending a read is now a **total function** over
a `PageLanding` union with a member for every one of those exits, `older()`'s
async body has a single landing and no path out without one, and ending
following is a `Tx` writer (`tx.stopped()`) inside `commit` rather than a
function beside it. `following = false` appears in exactly one place.

The apply-throw path additionally commits the throw as the failure it is, so the
chat is retryable and the application can see why, and `put.page` does all its
`own()`ing before its first mutation so a page this Client cannot take ownership
of owns nothing.

**A finding that removed a claim rather than adding a fix.** Tracer 11.6 said it
proved the watermark's absence. It did not, for two reasons — the harness's
deferred-read mode was inert against `memoryDataStore` (which pins its mirror
when `read` is _entered_, so waiting inside the `MirrorView` still read the
pre-`accept` snapshot), and, once that was fixed, a watermark reinstated exactly
as #106 describes it still passed all 406 tests. The reason is structural and is
now recorded in the table above. The tracer's claim was corrected to what it
actually demonstrates; the criterion is met by construction, and this file says
so rather than pointing at a test that cannot fail.

**Mutation audit at the round-2 fix head.** Eighteen mutations, each written,
compiled and run. Sixteen fail red. The two that do not are recorded above as
unprovable with their reasons, rather than left looking pinned. Three of the
sixteen — the cross-chat row filter, the apply-throw commit, and `stopped()`
announcing rather than only correcting — were green when first written and are
red only because this audit found them.

### Round 3 — `e8d2028`

Two lenses: "did the replan close the class" and a merge-gate pass over
acceptance, documentation and scope.

**The class is closed.** Neither lens found a new way to leave a chat reporting
`"loading"` with no read running, and both looked for one specifically —
`stopped()` racing a landing in both directions, a gap recreating the entry
mid-read, `stop()` twice, a listener calling `older()`/`close()` from inside the
`stopped()` delivery, and a throw from the `commit` that reports an apply-throw.
The trap-3 negative result held for the third round, from a third independent
route.

**Both blocking findings were documentation, and one was ugly.** Deleting
`endFollowing` left its twenty-line doc comment behind, attached to `sample()` —
so the module's live documentation described a function that samples the
derivation basis as one that stops following, and argued, in the head commit that
removed the defect, for _"Deliberately not a `commit`"_: the round-2 blocking
defect, stated as guidance to the next editor. `pnpm check` cannot see a comment
on the wrong symbol. Deleted.

**The second is this table over-claiming on the one row it edited.** Round 2
struck "the delivery basis is restored rather than cleared" as falsified. It is
not: replacing `finally { delivery = outer }` with `delivery = undefined` still
passes the whole suite. What #106 made provable is a _different_ property on the
same two lines — reusing an in-progress basis rather than re-sampling — and
conflating them turned an honest row into a claimed proof. Both rows now exist
separately, and both were re-measured rather than reasoned. The rule this table
states about the code applies to the table.

Also corrected: the README asserted the catch-up transient "always" resolves by a
later patch, which is false on the gap branch — a snapshot carries no messages,
so the chat empties and the application must re-page. This PR's own tracer
exercises that path. And `entryFor`'s comment undercounted the mutations outside
`commit`, which is the wording an acceptance criterion turns on.

**The replan's proof was arity-one, and round 3's second lens found it.** Three
violations compiled clean and passed all 406 tests, all three in the _lifetime_
of a read rather than its _content_ — which is where the round-2 audit's decision
points were concentrated, and so exactly where it was blind:

1. **`stopped()` ending only the first in-flight read.** A `break` after the
   first `"loading"` entry passed the whole suite, and left a second chat
   stranded for good. Every regression test for this property paged one chat.
   The replan's claim — that ending a read is a total function — was proven for
   one chat, in a namespace whose entire purpose is to hold several. Under C10's
   own thesis the cheap wrong path here is a `break`, an early `return`, or a
   `find()`-shaped rewrite of that loop, and nothing red stopped any of them.
2. **`older()` after a deliberate Runtime closure**, an explicit acceptance
   criterion of #106 with no coverage at all. Conflating `!following` with
   `closure !== undefined` passed, and left an application reading history from
   the mirror after its worker shut down with an empty chat, no `error` and no
   delivery.
3. **The follow failure being one transition rather than two.** Splitting it let
   a `messages` listener observe `closed: false` on a Client that had already
   stopped following — C3's condition, one delivery wide.

All three now fail red. The lesson for the next layer is not about page reads:
**a mutation audit inherits the blind spot of whatever the author was thinking
about when they chose the mutations.** Round 2's set was derived from the
replan's own decision points, so it tested the shape the replan had just
established and not the loop that shape runs in. Round 1 made the same mistake in
a different direction and this file already records it once. Deriving mutations
from the code's decision points is necessary and is not sufficient; the arity of
every loop the property ranges over is a decision point too.

## #107 review rounds

### Round 1 — `09163a1`

The packed proof held: a fresh consumer installed the exact tarball, used the
root Client with file media and libSQL, paged saved messages without requesting
phone history, then reopened the same files in a distinct process and produced
the same durable-state hash without reconstructing connection, identity or
presence. C1, C2, C3, C6, C8 and C10 therefore gained no new Client state path.

Two independent lenses blocked the head. The public name had been cut over, but
the internal frame reader still declared a second, incompatible
`WhatsAppClient`; it is now `RuntimeMirrorReader`, so Client has one meaning in
the repository. The README also opened `./data/whatsapp.db` without first
creating `./data`, while the proof harness quietly created that prerequisite.
The example now creates the directory itself, making the documented path match
the fresh-consumer path it claims to teach.

### Round 2 — `03f1b55`

The acceptance lens was clean and executed the README setup in a fresh project.
The standards lens confirmed the duplicate type/factory names were gone, but
found one sentence inside `RuntimeMirrorReader` still calling that raw reader
"the client." The noun is now `reader`; the low-level contract no longer teaches
a second meaning for Client even in prose.

## #108 review rounds

### Round 1 — `5ff5153`

Two independent reviews blocked the first durable-operation head. An inherited
claim had no expiry wake, and shutdown could turn work that had not crossed the
Session boundary into a permanent failure. Recovery now releases safe claims
and schedules the inherited expiry. libSQL also allowed `start()` after the
claim's database-time expiry; the transition now fences that attempt. A success
acknowledged before its authoritative echo disappeared from optimistic state,
so acknowledgement now dismisses only failed/unknown sends while success stays
until the echo. Abort now races a stalled async iterator and closes it.

The same round found two evidence/publication defects: a throwing operation
subscriber made a committed mutation appear rejected and skipped its siblings,
and the packed receipt recorded no operation-produced value. Publication was
isolated and the receipt gained persisted status, acknowledgement and one-write
evidence. Round 2 then tested those fixes rather than accepting their shape.

### Round 2 — `35c79f4`

The expiry timer introduced in round 1 had become permanent empty-queue polling.
The store now reports only the nearest claimed/executing recovery delay; the
executor schedules that one known deadline and sleeps indefinitely when none
exists. The lifecycle check also had a second race after the awaited durable
`start()` write. Ownership is rechecked on both sides; losing it after `start`
terminalizes the attempt as unknown without invoking the stale Session.

Operation notification had independently recreated ADR-0029's live-`Set` and
callback-identity defects. The store now holds registration records and uses the
shared snapshot-and-membership fanout. More importantly, it publishes the
committed receipt itself. That closes both the subscriber rules and the sibling
failure where one transient follow-up `get()` left `operations.wait()` hung on
an already-terminal row. Submission likewise returns the receipt committed by
`submit()` instead of risking a second read that could hide an autogenerated
idempotency key and invite a duplicate retry.

Two boundary findings completed the replan. Unknown input versions/types are
rejected by one shared validator before persistence and again before Session
execution. An abort after a Media Store write committed could previously leave
bytes with no operation; a completed write is now the point of no return, so
the idempotent operation submission finishes. Abort still stops byte
acquisition and unpublished staging. Finally, packed proof now uses three distinct processes:
one submits offline, one resumes and executes exactly once, and one reconstructs
the terminal receipt and Client state again.

### Round 3 — `2926747`

The prior classes were closed and the replacement proof held, but this round
froze implementation for a deeper boundary reset. One atomic claim published an
expired row's intermediate `queued` value and took a fresh membership snapshot
for its later `claimed` value. Store publication now deduplicates each operation
to its final committed receipt and fans the whole transaction through one
registration snapshot.

Queue order had also been inferred from millisecond time and an operation hash,
so two causally ordered submissions in one clock tick could execute backwards.
Operations now carry an account-scoped monotonic sequence allocated inside the
same memory/SQL write and claims order only by it. libSQL migration 3 backfills
existing rows and establishes the unique account/sequence index.

Two safety boundaries were too shallow. Durable input validation had checked
only `version` and `type`; it now projects every allowed member of every input,
outbound, option and message-ref shape, rejects unknown members/non-JSON values,
and validates decoded state. Session results are likewise projected to exactly
`MessageRef`, `{ requestId }`, or `null`; a malformed post-boundary value becomes
`outcome_unknown` rather than persisting an Error, stack or adapter-dependent
JSON. Both stores enforce the result rule as well as the executor.

Media cleanup was solved without inventing a seventh operation state. Temporary
Media Store puts now own staging leases. Successful operation submission retains
the object; failed submission discards that lease, deleting bytes only when no
other lease or durable retention exists. The filesystem markers make this safe
across independent store instances and preserve the existing process-crash
orphan disposition for #72. Finally, Runtime shutdown settles a failing executor
into its terminal failure and publishes `closed` before reporting it, so one
late store rejection cannot leave every Client watcher open forever.
