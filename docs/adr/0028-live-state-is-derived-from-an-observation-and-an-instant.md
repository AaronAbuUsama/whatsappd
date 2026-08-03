---
status: accepted
---

# Live state is derived from an observation and an instant

ADR-0020 established that a decaying status is not durable while the instant it
was observed at is. It did not say how a client represents the status while it
is still current, and issue #71's first two implementations answered that
question two ways at once — as committed state maintained by timers, and as a
value recomputed at each read. Holding both produced a contradiction that was
written into the specification and graded satisfied on both sides.

The contradiction is exact. If a transition must commit every affected value
before any listener runs, and expiry must also be revalidated at each listener
delivery, then a deadline falling between the third and fourth listener of one
delivery gives those listeners different values _from the same transition_. Both
requirements were in the issue; both were marked met.

## A decaying value has no commit point

Durable state changes because something happened, and that something can be
committed and given a revision. Live state — connection status, presence —
changes because the wall clock moved. There is no event to commit and no
revision to order it against.

Live state is therefore **derived**, not committed. The Client retains the
observation and its supplied `expiresAt`, and every read computes the current
value from that pair and the current instant. Expiry is never a transition.

Two consequences follow, and both are the point of the decision:

- **Timers are not correctness.** A timer that fires early, late, or never can
  delay the moment subscribers _learn_ that something expired. It can never make
  a read return an expired value. Scheduler fidelity stops being a source of
  defects, and the machinery that detected early wake-ups and re-armed
  deadlines stops existing.
- **One instant per delivery.** The Client samples the current instant once,
  immediately after commit, and every listener in that delivery is given a view
  derived from that same instant. A deadline crossing during fanout cannot split
  one transition into two observed values.

The second consequence is the one that must be implemented as a primitive: an
instant threaded through the delivery, not a clock re-read at each listener. Any
implementation that calls the clock per listener has reconstructed the
contradiction inside the derived model.

Freshness bounds remain as ADR-0020 and ADR-0009 describe them. An observation
is trustworthy no longer than the Account Lease it was made under, so its
effective deadline is the earlier of its own expiry and that lease's expiry. That
is a property of the stored pair, evaluated at read time like any other.

## Considered options

- **Committed live state with expiry timers**: rejected. It makes correctness a
  property of the scheduler. Five of issue #71's twenty-eight findings were in
  this class, and the code that resulted had to detect early timer wake-ups and
  re-arm, install cancellation handles before a re-entrant callback could observe
  them, and treat a blocked event loop as a source of incorrect state rather than
  late notification.
- **Both, as previously specified**: rejected as self-contradictory. It is what
  the retired implementations built, and it produced three P1 findings that were
  each fixed on one side of the contradiction and refiled on the other.
- **Publishing an expiry deadline to applications and letting them decide**:
  rejected. It re-exports to every application the reconciliation ADR-0023
  assigns to the Client once, and it is the failure mode issue #71 exists to end.
