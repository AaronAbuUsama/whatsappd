---
status: accepted
---

# Session failures have one precedence

`start()` and `stop()` report concurrent failures in this order:

1. an awaited subscriber's rejection;
2. socket or credential teardown failure;
3. an ordinary run failure.

The exact rejection reason is preserved, including falsy reasons such as
`undefined`. Internal control flow represents outcomes with
`PromiseSettledResult`; it does not infer failure from truthiness. `stop()`
always joins the session supervisor even when teardown fails. The enclosing
WhatsApp Runtime, not the session, owns and releases the Account Lease.

`start()` retains its rejection for callers that await it, while also owning an
internal rejection observer so the documented detached-start pattern cannot
become a process-level unhandled rejection.

## Consequences

- A failed credential wipe is reported before `logged_out` can be announced.
- A stop during socket creation tears down the late socket and explicitly
  settles the machine at `disconnected`.
- A subscriber failure cannot be masked by a simultaneous credential-drain or
  transport failure.
- The real socket `end()` memoizes teardown, drains writes that arrive while it
  is draining, and retains the first credential-write rejection.

This extends ADR-0013's awaited-handler rule across session teardown.
