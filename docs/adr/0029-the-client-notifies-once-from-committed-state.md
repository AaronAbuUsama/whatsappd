---
status: accepted
---

# The Client notifies once, from committed state

Two implementations of issue #71 were retired after eight review rounds. Nineteen
of their twenty-eight findings were one defect class recurring at a new site, and
the largest cluster — eleven findings — reduces to one sentence: the Client
invoked arbitrary re-entrant application code from around twenty internal
mutation points and had no contract about what those points could assume.

The response at the time was an ordering rule, "commit before notify". It was
re-cut in four consecutive rounds, each time moving the one statement the
reviewer's reproduction exercised, because an ordering rule is not enforceable by
construction: it must be re-established by hand at every site, including sites
written after the rule. By the final head one file held three publication
disciplines, none mandatory, across seventeen notification sites — and the
presence branch stayed byte-identical from the first round to the last, defective
throughout, inside a function edited in five separate commits.

The one cluster that never recurred was fixed differently. A sort-ordering defect
was closed by introducing a single comparison function and routing every call
site through it. Every future call site is forced through it by construction, so
the class could not reappear.

This decision applies that difference.

## The transition is the loop iteration

The Client follows the Runtime's durable frame stream as an async iterable and
performs one transition per iteration. Because the participant set is fixed at
the top of the body, it cannot be discovered by scanning during the transition
and cannot mutate while the transition runs — two properties the retired
implementations had to establish by hand and did not.

All state affected by one transition is mutated through a single commit function
that is **not `async`**:

```ts
function commit(mutate: (tx: Tx) => void): void;
```

A non-`async` function cannot await, therefore cannot yield to the event loop,
therefore nothing — no application callback, no timer, no concurrent `open()` —
can interleave inside a transition. "Committed before notified" becomes a
property of the type signature rather than a rule remembered at seventeen sites.
Asynchronous work happens outside commit, and its result is checked before it may
commit.

There is exactly one notification point per iteration.

## What a listener may do

Listeners are application code and may re-enter the Client. Because the
transaction is already closed when they run, re-entrancy is safe and is not
forbidden. The contract is closed, enumerated once, and stated in the public
interface documentation:

1. Listeners run after the transition is fully committed and may read any Client
   state.
2. Listener membership is snapshotted before delivery; subscribing during a
   delivery takes effect on the next transition.
3. Unsubscribing during a delivery takes effect immediately; a listener
   unsubscribed mid-fanout is not called.
4. A throwing listener is rethrown asynchronously, remains subscribed, and
   affects neither Client state nor other listeners.
5. Every listener in one delivery observes the same instant for live state
   (ADR-0028).

Rules 2, 3 and 5 are primitives — a membership copy, a membership check, a single
sampled instant — not orderings.

## One window per chat, many handles

`chats.open(chatId)` returns a distinct handle each call, and all handles for one
`chatId` share one message window, one paging cursor, one in-flight page read and
one presence view. The window is released when the last handle closes; each
handle's `close()` is idempotent and does not affect the others.

This is what allows a transition to address the affected window by key rather
than by scanning the open conversations, which is how notification came to happen
inside an iteration in the retired implementations. It also makes concurrent
paging join by construction rather than per controller, and makes two views of
one chat — the ordinary case under ADR-0016 — cost one window instead of N.

## Considered options

- **A central transition authority that every path is expected to use**:
  rejected, and empirically so. The retired implementation built one; the next
  review round still filed two commit-boundary findings, because building an
  authority does not force paths through it.
- **A statechart library**: rejected. Statecharts address transition legality.
  Not one of the twenty-eight findings was a legality defect; the genuine
  lifecycle has four states, and one actor per conversation is the retired design
  with a runtime attached.
- **A signals or reactivity dependency**: rejected as a dependency, adopted as a
  pattern. The batching behaviour is roughly fifteen lines against this Client's
  shape, which is the integration cost either way.
- **Deferring every delivery to a microtask**: rejected. It makes re-entrancy
  structurally impossible, but delivery becomes asynchronous, which breaks the
  synchronous read that React's external-store binding performs during
  notification (ADR-0016).
- **Forbidding re-entrant calls with a thrown error**: rejected. It converts a
  library-side coordination problem into an application-side crash, and once
  notification happens from committed state there is nothing left to forbid.
- **Independent controllers per `open()` call**: rejected. It is what the retired
  implementations did, it required the scan this decision removes, and it left
  two views of one chat with divergent cursors and duplicate page reads over
  identical rows.
