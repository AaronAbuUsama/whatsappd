# Issue #71 — attempt 3 plan

Decisions taken 2026-08-03 against `docs/issue-71-postmortem.md`. Every one of
them is a change from what the retired attempts did.

| #   | Joint           | Decision                                                                                              |
| --- | --------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Public contract | Restore the pre-implementation TypeScript contract, amended for 4–6, **frozen** before implementation |
| 2   | Scope           | Three substrate fixes land on `master` first                                                          |
| 3   | Update loop     | Consume the Runtime's existing pull loop; one publication point per iteration                         |
| 4   | Live state      | Derived from `(observation, now)`; timers are latency, not correctness                                |
| 5   | Conversations   | One shared window per `chatId`, N refcounted handles                                                  |
| 6   | Listeners       | Synchronous, after commit, membership snapshotted; five closed rules                                  |
| 7   | Reviewable unit | Substrate PRs, then six vertical slices, hard 400-line budget                                         |
| 8   | Proof           | Positive artifact required; "did not throw" is not evidence                                           |
| 9   | Factory         | `createWhatsAppClient(runtime)`. Owned lifecycle filed separately, blocked on #71                     |

Recorded as ADR-0028 (joint 4), ADR-0029 (joints 3, 5, 6) and ADR-0030 (joint 2 —
all three substrate changes). ADR-0011, ADR-0020 and ADR-0023 carry amendment
notes pointing at them. ADR number 0027 is **reserved** for the owned-lifecycle
decision, which is what the retired branch's unlanded `0027` describes; reusing
the number for anything else makes the review history unreadable.

## Why this is expected to differ from attempts 1 and 2

The retired attempts failed on coordination, not on domain behaviour — merging,
ordering, paging and dedupe worked in the first commit and never regressed, while
the file grew 549 → 859 lines across eight rounds adding zero features. Three
things change:

1. **Each substrate fix deletes Client code that would otherwise be written.**

   | Substrate fix                  | Client mechanism it removes                                                                   |
   | ------------------------------ | --------------------------------------------------------------------------------------------- |
   | Revision-pinned joint read     | the unbounded retry loop and its livelock, page-revision validation, most generation checking |
   | Live/durable channel split     | the presence special case, and presence's exemption from the commit boundary                  |
   | Alias delta on the patch       | the O(n) full rebuild on every contact change                                                 |
   | Reusing the existing pull loop | sixteen of seventeen publication sites                                                        |

2. **Every mechanism is a primitive, not an ordering.** The one cluster in the
   record that never recurred was fixed with a primitive; the ordering fixes
   recurred four rounds running.

3. **The reviewable unit is capped.** `finding supply ≈ (reviewable surface) ×
(evidence standard)`. This repository has run this loop three times (#45/#47,
   #51, #93/#94) and has only ever shrunk the loop, never the surface. PR #94 was
   +4145/−760.

**The known risk:** claim 1 is a prediction. Nobody has yet built this Client on
a fixed substrate. If slice c1 does not come in near its budget, that is the
signal to stop and re-plan, not to raise the budget.

---

## Phase 0 — substrate (three PRs, on `master`, in parallel)

None of these depends on the others or on any Client decision.

### S1 — Revision-pinned joint read

**Problem.** `snapshot()` and `messages()` open separate read transactions
(`src/runtime/contracts.ts:430,443`; `src/runtime/libsql.ts:1250,1332`) and
neither accepts a revision. Reconciling one global snapshot with N per-chat pages
against a live write stream needs an unbounded retry and is livelock-prone. This
produced PR #94's round-1 P1 and it is not fixable above the store.

**Change.** Expose the read transaction boundary `libsql` already has:

```ts
// src/runtime/contracts.ts — WhatsAppDataStore
read<T>(accountId: string, fn: (view: MirrorView) => Promise<T>): Promise<T>;

export interface MirrorView {
  snapshot(): Promise<WhatsAppSnapshot>;
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
}
```

Existing `snapshot()` and `messages()` become one-line wrappers over `read()`.

**Touches.** `contracts.ts`, `libsql.ts`, `memory.ts`, their tests.
**Proof.** A joint read taken while a writer advances the mirror returns a
snapshot and page at one revision, repeatably, with no retry.

### S2 — Split live and durable channels

**Problem.** Presence and connection carry no revision but sit in the same union
and the same listener set as snapshot and patch
(`src/runtime/contracts.ts:626-648`), and from one observation the Runtime
publishes the live frame at `runtime.ts:335` before the durable patch derived
from it at `:353`. Live state structurally cannot join a revision-ordered
boundary.

**Change.**

```ts
export type WhatsAppDurableFrame = snapshot | patch | closed;   // revision-ordered
export type WhatsAppLiveFrame    = presence | connection;       // expiring, unordered

onFrame(listener: (frame: WhatsAppDurableFrame) => void): Unsubscribe;
onLive (listener: (frame: WhatsAppLiveFrame)    => void): Unsubscribe;
```

**Also fix, in the same PR, because they are in the function being rewritten** —
three reproduced P1s in `publish()` (`src/runtime/runtime.ts:233-245`):

- **R1** iteration over a live `Set`: one `emit` drove 200,000 listener
  deliveries when a listener resubscribed. _This is the same defect as the
  Client's `r4-f1`, one layer down, and only the Client one was ever found._
- **R2** a throwing listener is silently and permanently unsubscribed and never
  receives `closed`.
- **R3** `structuredClone` sits inside the same `try`, so one unclonable frame
  deletes **every** listener and the stream dies silently with no terminal frame.

The fix is ADR-0029's rules 2–4 applied at this layer: snapshot membership,
check membership before each call, keep a throwing listener subscribed, clone
outside the guarded region.

**Touches.** `contracts.ts`, `runtime.ts` (including `watch()`), `memory.ts`,
tests.
**Proof.** A listener that resubscribes during fanout terminates; a throwing
listener still receives subsequent frames including `closed`; an unclonable frame
does not remove other listeners.

### S3 — Carry the alias delta on the patch

**Problem.** The projection computes three mutation kinds
(`src/runtime/projection.ts:30-33`) and the patch ships two
(`src/runtime/contracts.ts:356-357`). `MirrorDelete` (`:256`) omits freed native
ids. A client maintaining state from patches cannot keep `contactAliases`
coherent at all — it can only re-snapshot.

**Change.**

```ts
export type MirrorAlias = { readonly nativeId: string; readonly contactId: string };

export interface WhatsAppPatch {
  // …
  readonly aliases?: readonly MirrorAlias[];
}

export type MirrorDelete = {
  readonly type: "contact";
  readonly contactId: string;
  readonly freedNativeIds?: readonly string[];
};
```

This adds a third mutation kind to the patch, so it amends ADR-0011's "a patch
carries normalized mirror-record upserts and deletes" clause. ADR-0019 and
ADR-0022 already established deletes and PN/LID equivalence as the producer;
this makes that equivalence observable from the patch stream rather than only
from a snapshot.

**Touches.** `contracts.ts`, `projection.ts` passthrough, `libsql.ts`,
`memory.ts`, tests.
**Proof.** A PN/LID consolidation and a contact delete are both observable from
the patch stream alone, with no snapshot re-read.

---

## Phase 1 — the Client (six slices, after Phase 0 merges)

Issue #71 rewritten: `docs/issue-71-rewrite.md`. Slices c1–c6 are specified
there. **No slice exceeds 400 changed lines**; over budget means split, not
review.

Order matters only at the front: c1 establishes the commit primitive, the pull
loop and the listener rules, and is reviewed with no conversations in it at all.
c3, c4 and c5 can be authored in parallel once c1 is merged.

Do not import `src/runtime/client.ts` from PR #93 or #94 in any form. The
previous plan mandated exactly that and it is why the second attempt's first
commit was byte-identical to the first attempt's head.

---

## Disposition of the retired work

**PR #94 closes unmerged.** Its three open P1s become test cells in the matrix,
not patches on a retired branch:

| Finding                                        | Where it goes                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `r4-f1` listener membership during re-entrancy | ADR-0029 rules 2–3; slice c1 tests; **and S2**, where the same defect exists one layer down                                         |
| `r4-f2` presence committed before delivery     | removed by construction — joint 5 replaces the scan with a key lookup, joint 4 removes the separate presence transition. Cell in c2 |
| `r4-f3` the process proof does not execute     | joint 8; the receipt pattern below                                                                                                  |

**ADR-0027 as authored on the branch does not land.** It is split:

- its account-lifecycle half becomes the follow-up ticket's ADR, keeping the
  number;
- its live-state half — freshness capped at lease expiry, early wake-ups re-arm,
  expiry revalidated per listener delivery — is superseded by ADR-0028, which
  keeps the lease-expiry bound as a read-time property and discards the timer
  fidelity requirements;
- its "one transition authority" half is falsified and is replaced by ADR-0029.

The branch's amendments to ADR-0006 and ADR-0023 do not land. Both stand as
written on `master`; the application still owns Backend, Runtime and Client.

**Not in scope, still real.** `src/session.ts` and the lease store carry three
further P1s — `memoryLeaseStore.acquire()` returns the stored lease by reference,
so one field write makes a lease immortal and defeats mutual exclusion; session
events reach every handler by reference; `session.status` hands out a shared
module-level object. These are orthogonal to #71 and bundling them is what made
the last two PRs unbounded. File as their own ticket.

---

## Ready to file

### Follow-up ticket — the Client owns its account lifecycle

> **Blocked by #71.**
>
> Today an application composes Backend, Runtime and Client and must close them
> in the right order. Add one factory that owns all three:
>
> ```ts
> export function createOwnedWhatsAppClient(options: {
>   accountId: string;
>   backend: () => Awaitable<WhatsAppBackend>;
>   openSession: (credentials: CredentialStore) => Awaitable<RuntimeSession>;
> }): Promise<WhatsAppClient>;
> ```
>
> Resources returned by those factories transfer to the Client. Creation failure
> unwinds every acquired resource. `close()` is idempotent, joins concurrent
> callers, stops Runtime and Session, releases the lease, and closes the Backend
> last.
>
> This is additive. `createWhatsAppClient(runtime)` remains the primitive and the
> owning factory wraps it — once the Client itself owns nothing, the wrapper is
> thin. Whether the owning factory becomes the _primary_ documented entry point,
> superseding ADR-0006, is decided in this ticket and not before.
>
> Prior art: the retired branch's unlanded `docs/adr/0027-the-client-owns-the-account-lifecycle.md`
> (`git show 4009780:docs/adr/0027-the-client-owns-the-account-lifecycle.md`).
> Its lifecycle, unwind and teardown reasoning is sound and should be recovered.
> Its live-state and transition-authority sections are superseded by ADR-0028 and
> ADR-0029 and must not be carried forward.

### The receipt pattern, for joint 8

The current proof asserts that `execFile` did not reject, and spreads
`process.env` into the child, which leaks `NODE_TEST_CONTEXT` and makes the
nested `node --test` print "run() is being called recursively … skipping running
files" and exit 0. It was green from round 1 onward on both CI runtimes and cited
in every receipt.

```ts
// child, after doing its work
await writeFile(receiptPath, JSON.stringify({ pid: process.pid, mode, revision }));

// parent
const write = JSON.parse(await readFile(writeReceipt, "utf8"));
const read  = JSON.parse(await readFile(readReceipt,  "utf8"));
assert.notEqual(write.pid, read.pid);          // two real, different processes
assert.notEqual(write.pid, process.pid);       // neither is this one
assert.equal(read.revision, write.revision);   // and the state actually crossed

// and never spread the parent environment
env: { PATH: process.env.PATH, HOME: process.env.HOME, /* explicit vars only */ }
```

A child that skips execution writes no receipt, `readFile` throws, and the proof
fails red.

Note when this lands: with the children genuinely running, `lastDisconnectedAt`
is expected to differ — teardown stamps it _after_ the writer captures its
expectation. That is a second, real defect that the false green was hiding, and
it needs its own fix rather than a loosened assertion.

---

## Process rules for this attempt

From the failure record, not from principle.

- **Prefer a primitive over an ordering.** A fix phrased "do A before B" will
  recur. Nineteen of twenty-eight findings did.
- **Shrink the surface before opening the PR.** The four-round cap is not the
  lesson; it converted one long doomed loop into two shorter ones.
- **Do not import the failed implementation.** The previous plan required it.
- **A green suite is not evidence a proof ran.** 363 tests in 4.2 seconds, one
  claiming two process spawns, was observable every round and observed at none.
- **Count independence.** Local run + Node 22 CI + Node 24 CI is one
  confirmation. A version matrix cannot vary a bug in a test's own environment
  construction.
- **Write the test matrix before the implementation.** Sixty-nine percent of the
  retired suite existed because a reviewer found a bug; its designed baseline
  never improved across eight rounds.
- **Do not edit this issue in response to a review finding.** Five of the nine
  previous revisions did, one of them written one minute before the commit it
  described. A finding that suggests the specification is wrong pauses
  implementation and reopens the specification deliberately.
- **Use the persistent defect ledger from round 1.** It exists
  (`break-review-loops`), and its absence is visible in the record.
