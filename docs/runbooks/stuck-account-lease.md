# Runbook: stuck account lease

**Symptom:** `AccountAlreadyClaimedError` on a worker that should own the
account, or an account that no worker will pick up.

## What the lease is

Exactly one worker may consume an account at a time (ADR-0009). The claim is
acquired _before_ the WhatsApp socket opens, so starting a second runtime for a
claimed account fails closed rather than putting two writers on one account.

The lease TTL defaults to 30 seconds (`leaseTtlMs`) and is renewed by a
heartbeat at half that interval. A worker that dies without releasing therefore
blocks its account for **at most 30 seconds**, after which the claim expires and
the next worker takes it.

## First: wait 30 seconds

`AccountAlreadyClaimedError` carries `heldUntil` as a millisecond epoch
timestamp. If it is within the next 30 seconds, the previous holder died and the
claim is about to lapse on its own. Waiting is the entire fix.

Restarting the new worker in a tight loop during this window looks like a stuck
lease and is not one.

## If the claim keeps being renewed

A `heldUntil` that keeps moving forward means something is alive and
heartbeating. That is the lease working correctly — find the other worker.

```bash
# libSQL backends: who holds it, and until when
sqlite3 whatsapp.db \
  "SELECT account_id, holder_id, expires_at, fencing_counter FROM wa_account_leases;"
```

`holder_id` identifies the holding runtime. Common causes:

- **A previous deploy is still draining.** Two revisions overlap during a
  rolling restart. Expected; it resolves when the old pod exits.
- **A local process is still attached.** Someone's `pnpm proof` or a debug
  worker is holding the account against the same database.
- **Two workers were configured for one account.** This is the misconfiguration
  the lease exists to catch. Fix the deployment, do not work around the lease.

Stop the real holder. It releases on a clean `runtime.stop()`; if it is
unresponsive, killing it leaves the claim to expire within the TTL.

## Never delete the lease row to force a takeover

Deleting or editing `wa_account_leases` by hand defeats the mechanism. It does
not cause a race — the `fencing_counter` still protects the acceptance boundary,
and the evicted worker will fail with `StaleAccountClaimError` when it next
writes — but it means you have deliberately put two live sockets on one account,
which WhatsApp answers with `connection_replaced` (440) on one of them. You have
converted a clear failure into a confusing one.

If you are certain the holder is gone, wait out the TTL instead. It is 30
seconds.

## `StaleAccountClaimError` in the logs

A worker paused past its TTL (GC pause, suspended container, debugger), another
worker claimed the account, and the first resumed holding a buffered event. The
store compares fencing tokens at the acceptance boundary and rejects the stale
write.

This is the protection working. The stale worker should exit and be restarted;
its buffered event was correctly refused, because accepting it would have
interleaved two writers' views of the same account.

Recurring `StaleAccountClaimError` without an obvious pause means workers are
being starved of CPU long enough to miss a 15-second heartbeat — a capacity
problem, not a lease problem.
