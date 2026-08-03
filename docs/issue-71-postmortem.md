# Issue #71 — Investigation Report

Two failed implementations (PR #93 closed, PR #94 retired), 8 hosted review rounds,
28 valid findings, 5 still open. This is the diagnosis, not a design.

Investigated at: master `921ac3a`, PR #93 head `537726cd`, PR #94 head `4009780d`.

---

## 1. The headline

**Three findings, in order of how much they change the plan.**

1. **It was never two attempts. It was one 8-round loop, relabelled.**
   PR #94's first implementation commit is _byte-identical_ to PR #93's round-1 head —
   same blob SHA for `src/runtime/client.ts` (`94768d3f…`) and `tests/client.test.ts`
   (`8d889df6…`). Only docs differ. The re-charter reset the ledger, not the artifact.
   And it was mandated: commit 2 of the issue's own plan says _"carry forward the already
   proven friendly Client state foundation from the retired reviewed unit."_

2. **You were never in a complex state machine.** The genuine lifecycle has **4 states**.
   Of the 8 mechanisms this problem needs, **7 are not state machines** — they are one
   transaction problem, two concurrency problems, one resource-lifetime problem, one
   scheduling problem, one clock problem, and one substrate transaction problem. No
   statechart library addresses any of them. Not one of the 28 findings is a
   transition-legality defect.

3. **The complexity was created by a model switch, and by deleting the thing that made
   it unnecessary.** Master's client seam is _pull_ — `watch(): AsyncIterable<Frame>`,
   backed by a ~100-line async generator at `runtime.ts:604-703` that already handles
   subscribe-before-snapshot, revision cursor, gap recovery, awaitable cancellation and
   terminal close, correctly. Both PRs deleted it and reached past to the raw push
   primitive `onFrame(listener)`, then re-derived all of it by hand at ~4× the size —
   in a context where re-entrancy is possible.

---

## 2. How the state machine was precipitated

`createClientState` grew **549 → 859 lines in seven hours across eight rounds, and not
one added line was a feature.** Domain behaviour was complete in the first commit.

| Measure                                                         | Value                     |
| --------------------------------------------------------------- | ------------------------- |
| Coordination variables live at once (3 conversations, 4 timers) | **62**                    |
| Distinct commit-then-notify implementations                     | **6**                     |
| Logical notification sites                                      | **17**                    |
| Notification sites with no barrier at all                       | **4**                     |
| Genuine Client lifecycle states                                 | **5** (4 + failed-closed) |
| Variables encoding those states                                 | **9**                     |
| File that is lifecycle/coordination vs domain shaping           | **71% / 18%**             |

Four overlapping machines share one closure scope with no shared vocabulary: Client
lifecycle, durable coherence, live-state freshness, per-conversation paging. Machine 4
reads machines 1 and 2's private variables directly.

They _did_ build a general barrier — `pendingNotifications`, at commit 13 of 28 — and
wired it into **1 of 17 sites**. `closeClient` (`client.ts:193`) actively discards it.
It could never have generalised: it is keyed by _listener Set_, not by _transition_, so
it can coalesce deliveries but cannot decide what to stage.

### Why a single barrier was genuinely hard

1. Global namespace state lives in Client-scope Maps; conversation state lives in locals
   created fresh inside each `open()` call (`client.ts:481-509`). No common commit function.
2. The participant set is discovered _mid-transition_ — `affectedConversations` is built
   by scanning while walking the patch body (`client.ts:261-289`).
3. The participant set _mutates during_ the transition — `recover()` snapshots
   `replacing = [...conversations]` at `:395`, then awaits I/O, during which `open()` can
   insert at `:737` and `close()` remove at `:732`.

(2) and (3) are downstream of the push model. In a pull loop the transition is a loop
iteration, so the participant set is fixed by construction at the top of the body.

---

## 3. The rule that explains every recurrence

**68% of findings (19 of 28) were "same class, new site"** — recurring _after_ a fix for
that class had shipped green. Only 8 were new territory. But one cluster never recurred,
and the difference is the whole lesson:

> **Fixes that installed a value-level primitive generalised.
> Fixes that imposed a statement ordering never did.**

**Control case.** Round 1 found `localeCompare` disagreeing with the stores' binary
ordering. The fix introduced one `compareId` and routed all five sort sites through it.
Never recurred. Every future call site is forced through the primitive by construction.

**Counter-case.** "Commit before notify" is an ordering constraint — unenforceable by
construction, so it must be re-established by hand at every site, including sites written
after the fix. It was re-cut four rounds running, each time moving exactly the one
statement the reviewer's repro exercised:

```
bd82a1a  conversation.receive(...)        // notifies INSIDE the record loop
ef0f88a  notify(...) x4; then commit()    // commit AFTER the namespace notifies
5f6375d  commit(); then notify(...) x4    // moved above
537726c  stage() loop; flush() loop; notify
```

**The proof:** the presence branch is byte-identical from `bd82a1a:212-216` to
`4009780:373-377` — untouched across both PRs and all eight rounds. Defective at round 1,
flagged at round 8. It sat inside `consume()`, a function edited in five separate commits.
Sibling search ran every round and missed it every time, because nothing in the code made
it _look_ like a publication site.

By the final head: **three publication disciplines in one file, none mandatory** — manual
stage/flush in `apply()`, `pendingNotifications` in `recover()`, bare `publish()` in
presence / `loadOlder` / `hydrate`.

### Root-cause clusters

| Cluster                                           | N   | The one property that enabled every member                                                    |
| ------------------------------------------------- | --- | --------------------------------------------------------------------------------------------- |
| C1 Publish-before-complete                        | 7   | ~22 sites can invoke application code; "the transition is complete" is never representable    |
| C2 Decaying state has no currency authority       | 5   | Live state = cached value + timer, so currency is a property of the _scheduler_, not the data |
| C3 Recovery is a detached task, not a Client mode | 4   | `void recover()` fire-and-forget, own error handling, own participant snapshot                |
| C4 One-sided trust boundary                       | 5   | Ownership defined by _API visibility_ instead of _memory provenance_                          |
| C5 Listener `Set` holds three roles               | 2   | One Set is registry, iteration target, and cleanup handle                                     |
| C6 Proof asserts an environment it never verifies | 2   | The only oracle is `execFile` not rejecting                                                   |
| C7 Docs audited by string, not by surface         | 2   |                                                                                               |
| C8 Ordering determinism                           | 1   | **control — primitive fix, never recurred**                                                   |

C1 + C5 collapse to one statement covering 11 findings: _the Client synchronously invokes
arbitrary re-entrant application code from ~20 internal mutation points and has no
contract about what those points may assume._

**What a pinpoint review structurally cannot say.** All 18 hosted findings are
line-anchored. A line-anchored review can say _this line is wrong_; it cannot say _this
file has N sites of a kind and no shared rule_. **8 architectural observations, each
readable from a single head in minutes, were unpacked into 28 findings over 8 rounds.**

---

## 4. The specification co-evolved with the implementation

Issue #71 has **9 body revisions**. Five land minutes after a specific review finding and
generalise it into a requirement.

| Edit     | Text added                                                      | Follows  | Gap                                                                 |
| -------- | --------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| v4 21:46 | "expiry-aware at every public read"                             | R2 21:40 | 6 min                                                               |
| v5 21:59 | "early timer wake-ups re-arm until the wall clock reaches it"   | same     | code landed **3 min before** the requirement                        |
| v6 22:34 | "Application callbacks are reentrant, mutable trust boundaries" | R2 fixes | same sentence reappears 9 min later in the round-3 _review request_ |
| v7 23:36 | "Ownership is two-sided at adapter seams"                       | R3 22:51 | 45 min                                                              |
| v8 23:49 | "Renewal arguments … are independent values"                    | —        | written **1 min before** the commit it describes                    |

**6 of 16 acceptance criteria (#4, #5, #6, #7, #9, #12) are bug fixes promoted to
requirements.** Each names its originating defect rather than the property behind it —
guaranteed satisfiable, guaranteed non-predictive. That is why 13/16 could be graded
satisfied on a PR nobody trusted.

**AC #5 was graded "satisfied" at head `4009780d` while round 4 filed two AC-#5 violations
against that exact head.** A criterion that can be marked satisfied on a head that
violates it is not a criterion.

### The diagnosis being handed forward is already falsified

The v3 re-charter asserts: _"The repeated review defects share one cause: … do not pass
through one lifecycle and transition authority."_ PR #94 **built that authority** — and
round 4 still filed two commit-boundary P1s. Building an authority doesn't help if nothing
forces every path through it.

### A genuine contradiction inside the criteria

- **AC #5**: every transition commits all state before _any_ listener runs.
- **AC #12**: expiry is revalidated at _each listener delivery_.

Expiry-driven change has no commit point — it's caused by the wall clock. If a deadline
falls between listener 3 and listener 4 of one delivery, they observe different values
_from the same transition_. The literal negation of AC #5. Both graded satisfied. The spec
never chooses between "live state is a pure function of `(observation, now)`" and "live
state is committed and expiry is a real transition". PR #94 did the first for reads and
the second for timers, simultaneously.

### The DX contract was deleted

v2 (11:26, five hours before any implementation) specified the public surface as ~90 lines
of real TypeScript plus a usage example. It is **essentially identical to what shipped**.
The v3 re-charter deleted all of it; the current body has zero type declarations and zero
code fences.

**The part specified as a contract before any code existed is the part that worked.
The parts specified afterwards, by transcribing findings, are the parts that failed.**

Recovered to `issue71-v2.md`.

---

## 5. The substrate is implicated — a Client-only redesign fails again

Responsibility scoring of the failed Client: **11 substrate-forced, 4 spec-forced,
5 self-inflicted.**

Three substrate properties, ranked, that most increase Client complexity:

1. **No revision-pinned joint read.** `snapshot()` (`libsql.ts:1251`) and `messages()`
   (`:1334`) open separate read transactions; nothing in `WhatsAppDataStore` accepts an
   `atRevision`. Reconciling a global snapshot with N per-conversation pages therefore
   needs an unbounded `for(;;)` retry against a live write stream — **livelock-prone**.
   Caused PR #94's round-1 P1. Unfixable above the store.
2. **Live and durable share one channel, live published first.** `presence`/`connection`
   (no revision, expiring) sit in the same union and listener set as `snapshot`/`patch`
   (`contracts.ts:626-648`), and the Runtime publishes the live frame _before_ the durable
   patch derived from the same observation (`runtime.ts:321`, `:335`). Presence
   structurally **cannot** join a revision-ordered barrier.
3. **The patch drops derived-view deltas.** The projection computes `contact_alias`
   mutations (`projection.ts:33`) and `WhatsAppPatch` (`contracts.ts:352`) carries only 2
   of 3 mutation kinds. `MirrorDelete` omits freed native ids. Alias maintenance is forced
   to a full O(n) rebuild — **and a client maintaining state from patches cannot maintain
   `contactAliases` coherently at all.**

### Master carries all six defect classes

| Class                     | On master?                                        | What the next round surfaces                                                    |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1 commit-before-notify    | **Yes** — R4, R10, R11                            | R10/R11 are a _design_ blocker, not a code one                                  |
| 2 cancellation & lifetime | **Yes, densely** — R17, R18, R19, R6, R7, R20-R24 | The reviewer lands on `session.ts`, which the redesign doesn't touch            |
| 3 live-state expiry       | **Yes** — R5, R6, R23                             | R5 is verbatim the brief's phrasing; R23 compares a DB clock to a process clock |
| 4 mutable value ownership | **Yes, 3 P1s** — R12, R13, R14                    | The **session** seam has zero mutation tests                                    |
| 5 listener-set integrity  | **Yes, worse than known** — R1, R2, R3            | Two are in `publish()` — the function the redesign subscribes to                |
| 6 false-green             | **Yes** — R25                                     | The only test over `publish`'s catch passes identically with or without the bug |

Three P1s in `publish()` (`runtime.ts:233-245`), all reproduced:

- **R1** — live `Set` iteration. One `emit` drove **200,000 listener deliveries**; a
  listener that resubscribes never returns. _This is the same defect as the client's
  surviving P1 `r4-f1` — it exists at both layers, and only the client one was found._
- **R2** — a throwing listener is silently, permanently unsubscribed and never gets `closed`.
- **R3** — `structuredClone` sits _inside_ the same `try`, so **one unclonable frame
  deletes every listener**; the stream dies silently forever with no terminal frame.

Also P1: `memoryLeaseStore.acquire()` returns the stored lease **by reference** — one
field write makes the lease immortal and defeats mutual exclusion (R12). Session events
reach every handler by reference, so an app handler rewrites what the runtime persists
(R13). `session.status` hands out a shared module-level object — mutating it poisons every
other session in the process (R14).

**Rebuilding the Client alone does not clear a single class.**

---

## 6. Why the verification apparatus caught none of it

**One genuine false-green, and it was the required proof.** `{...process.env}` leaks
`NODE_TEST_CONTEXT` into a nested `node --test`, which prints _"run() is being called
recursively … skipping running files"_ and **exits 0**. Reproduced on both CI runtimes.
The fix for round 1's finding _created_ it: it satisfied the letter (a real subprocess)
and destroyed the substance (execution).

It is a **false proof of a true fact** — running the children with a clean env shows
durable libSQL state does survive a real process boundary; the reader fails on exactly one
field, `lastDisconnectedAt`, legitimately stamped by teardown _after_ the writer captured
its expectation. Two independent defects in one test, each masking the other.

**The tell visible every round: 363 tests in 4.2 seconds, one claiming two Node spawns.**

### The independence illusion

| Counted as                                              | Worth                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| local `pnpm test` + Node 22 CI + Node 24 CI = 3         | **1** — false green reproduced on both runtimes; a Node matrix can't vary a bug in the test's own env construction   |
| `check`/`build`/`proof:pack`/`audit`/`diff --check` = 5 | **0** for behaviour — none can observe a test that doesn't run. Inflated apparent evidence 1 → 6                     |
| "two independent local audits"                          | **1** — same skill, same diff, same checklist. One round recorded a _duplicate_ finding and read it as corroboration |
| 8 hosted rounds                                         | **8 shallow samples of one artifact.** Findings per round: `6,3,1,2` then `1,1,1,3`                                  |

Round 4's `r4-f3` flags code introduced by **round 1's own fix**, byte-unchanged since.
Seven rounds reviewed a diff containing it — each explicitly instructed to audit "genuine
two-process libSQL replacement" — and none flagged it.

**The gate that requested the proof was also the gate that accepted it, statically.**
No point in the loop had anyone's job as watching the proof run. The local `code-review`
skill is by construction a _diff_ review and says to "skip anything tooling already
enforces" — deferring correctness to a green suite whose greenness needed auditing.

### The suite is an index of the review transcript

**31% designed, 69% reactive** — 24 added tests against ~24 accepted findings, roughly one
test per finding. The designed baseline never improved across all 8 rounds.

Empty cells, verified by reading tests:

- **`unsubscribe` appears twice in 2,560 lines** — both at top level, never inside a
  callback. That is the `r4-f1` cell.
- **No test ever holds two live controllers on the same chat id.** All 11 presence
  emissions target one chat with one controller. That is the `r4-f2` cell.

Cells nobody has reached (rounds 5-7 candidates): `chats.open()` from inside a presence
listener (`open` has **no `await` before `conversations.add` at :736**, so it inserts into
the Set mid-iteration); `subscribe()` during fanout; unsubscribing a _different_ listener
during fanout; cross-process lease fencing (both holders currently share one event loop,
so real fencing failures are structurally unreachable); presence expiry with two controllers.

---

## 7. The mechanism inventory — what this problem actually needs

| #   | Mechanism                                          | Kind                              | State machine?                                            |
| --- | -------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| T1  | Atomic visibility across a dynamic destination set | **Transaction** (isolation)       | No — a reader sees a torn write; no transition is illegal |
| C1  | Cancellation of waits                              | Concurrency                       | No — `AbortSignal.any`                                    |
| C2  | Stale-result rejection at commit                   | Optimistic concurrency            | No — a CAS on a version                                   |
| R1  | Scoped ownership + deterministic unwind            | Resource lifetime                 | No — the `AsyncDisposableStack` shape                     |
| S1  | Untrusted-callback scheduling                      | Scheduling                        | No — don't run foreign code in the critical section       |
| V1  | Validity-window values                             | Clock                             | No — derivable from `expiresAt`                           |
| X1  | Revision-pinned joint read                         | Transaction, **in the substrate** | No                                                        |
| L1  | Lifecycle phase                                    | —                                 | **Yes — 4 states**                                        |

**The guarantee that makes it structural:** a **non-`async` `commit()`**.

```ts
function commit(mutate: (tx: Tx) => void): void; // cannot await ⇒ cannot yield
```

A non-async function cannot yield to the event loop, so the conversation set cannot mutate
mid-transaction, and commit-before-notify stops being a rule remembered at 17 sites and
becomes a property of the type signature. This is the "primitive, not ordering" rule
instantiated.

### Prior art converges on one shape — and none of it uses a state-machine library

- **Relay** — two-phase `publish()` / `notify()`; notify **re-reads each subscriber against
  committed state**.
- **Apollo** — reentrant transaction counter; `broadcastQueries()` fires once at depth 0.
- **Yjs** — the dirty set (`transaction.changed`) is accumulated **by the mutation itself**,
  not recomputed at flush. The direct answer to a dynamic destination set.
- **TanStack Query** — `notifyManager` is **~80 lines, standalone**.

Pattern: (a) a dirty set accumulated during mutation, (b) a depth counter so nested
mutations flush once, (c) notify re-derives from committed state.

### Library verdicts

| Candidate                                         | Verdict                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| XState / statecharts                              | **Reject.** Addresses transition legality; no ledger defect is a legality defect. One actor per conversation _is_ the failed design plus a runtime. |
| Signals (`@preact/signals-core`, `alien-signals`) | **Reject the dep, take `batch()`'s pattern.** ~15 lines is the integration anyway. TC39 signals is Stage 1.                                         |
| Immer                                             | **Reject.** Records are already fresh-parsed per read; `Object.freeze` at the parse boundary deletes all five existing cloning layers at zero cost. |
| `AbortSignal.any`                                 | **Adopt.** Stdlib, present on both legs. Collapses 10 hand-rolled `Promise.race` triples.                                                           |
| TC39 explicit resource management                 | **Take the shape, not the syntax** — see below.                                                                                                     |

### Node 22 blocks `await using` (verified on both CI legs)

|                        | Node 22.12.0    | Node 24.18.1 |
| ---------------------- | --------------- | ------------ |
| `AsyncDisposableStack` | **undefined**   | present      |
| `await using` syntax   | **SyntaxError** | parses       |
| enabling flag          | **none exists** | n/a          |
| `AbortSignal.any`      | present         | present      |

No TypeScript escape: `--experimental-strip-types` **erases types without transforming
syntax**, `tsconfig` is `noEmit` at `esnext`, CI matrixes `node: [22, 24]`. Hand-roll the
stack shape (~20 lines: LIFO async closures, aggregated errors, idempotent dispose),
structured so dropping Node 22 is a one-line swap.

---

## 8. What survives into the redesign

**Load-bearing (carry):**

- One awaited `createWhatsAppClient(options)`; resolving means durable hydration applied.
  No `ready()`, no "empty until hydrated" ambiguity. _(specified pre-implementation)_
- Named namespaces + opened-conversation controller. _(ADR-0023, with real rejected options)_
- Applications never handle frames, snapshots, patches, revisions, cursors. _(ADR-0023/0011/0010)_
- Stored paging: stored-only, cursor-free, single-flight, retryable; "no older saved" ≠
  "no more WhatsApp history". _(ADR-0010 — the best-provenanced block in the issue)_
- Connection/presence live-only, never hydrated as truth; observed instants durable. _(ADR-0020)_
- Runtime Closure must become observable account state. _(CONTEXT.md)_
- Account lease required, fail-closed, fencing token. _(ADR-0009)_
- One subscription per registration, idempotent unsubscribe, `AbortSignal`. _(ADR-0013)_
- Client owns adapter instances from its factories; creation failure unwinds; close is
  idempotent and joins. _(ADR-0027 — the genuine DX gain of the re-charter)_
- Public test seam is the public API; SQL only as post-hoc cross-check. _(ADR-0017)_

**Residue (drop):**

- The Problem Statement's "one transition authority" root-cause claim — tested and falsified.
- The prescribed two-phase + generation-number _mechanism_. Keep the goal, drop the machine.
- "Terminal closure bypasses the hydration/recovery queue" — one finding, generalised.
- "A conversation opened during recovery must validate the current committed generation" — one finding.
- "expiry-aware at every public read and listener delivery … early wake-ups re-arm" — `setTimeout` fidelity in a product spec, and half of the AC#5/AC#12 contradiction.
- "Application callbacks are reentrant, mutable trust boundaries …" — back-filled.
- "Ownership is two-sided …" / "Renewal arguments … independent values" — back-filled; and
  provably not universal (#95 covers the same class on a path where `structuredClone` cannot work).
- The 10-commit plan in full, especially commit 2 and green-at-every-commit.
- The `Effect` ban — unmotivated, added after the failure.
- The 6 back-filled acceptance criteria.

---

## 9. The systemic finding

This is the **third** occurrence of this loop in this repo. Review rounds on substantial PRs:

| PR                      | rounds | size           | outcome |
| ----------------------- | ------ | -------------- | ------- |
| #45 harness             | 13     | +23006         | closed  |
| #47 live-account proof  | 21     | +1125          | closed  |
| #51 history semantics   | 18     | +1538          | merged  |
| #62 runtime fixed point | 9      | +1695/-410     | merged  |
| #88 message storage     | 7      | +1617/-63      | merged  |
| #93 client (attempt 1)  | 4      | +2298/-663     | closed  |
| #94 client (attempt 2)  | 4      | **+4145/-760** | retired |

Eight rounds on #71 is **below** this repo's median for work of this size.

A memory recorded from issue #18 already diagnosed the mechanism:

> finding supply ≈ (reviewable harness surface) × (evidence standard);
> per-pass patching shrinks neither factor.

Substitute the terms and it predicts #71 exactly: **finding supply ≈ (reviewable
transition surface) × (concurrency-correctness standard)**. PR #94 presented a 723-line
function with 62 coordination variables and 17 notify sites against an extremely high
atomicity standard.

The _cord-pull_ half of that lesson fired — the 4-round cap is new, and it is why #93 and
#94 died at 4 instead of 21. But the cap converted one long doomed loop into two shorter
doomed loops. **The lesson's actual prescription — shrink the reviewable surface before
opening the PR — was never applied.** #94 was the largest PR in the project's recent history.

---

## 10. Open questions for the grill

1. Does the substrate get fixed first (revision-pinned joint read; split live from durable;
   carry the alias delta), or does the Client absorb it again?
2. Pull core with a push façade — or something else? What drives the loop, and what is a
   "transition"?
3. Is live state committed state, or a pure function of `(observation, now)`? The spec
   must pick one; picking both is the AC#5/AC#12 contradiction.
4. Should two `chats.open()` calls on the same chat return the same controller? Every
   multi-controller defect assumes they are independent.
5. What may an application callback do? Enumerate closed, not incident by incident.
6. What is the reviewable unit, given the finding-supply arithmetic? Does master get fixed
   in separate PRs before the redesign opens?
7. What proves a proof ran?
