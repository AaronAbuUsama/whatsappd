# Runbook: session faults

**Symptom:** a session disconnected, is reconnecting in a loop, has gone quiet
without delivering messages, or never reaches `online` at all.

## 1. Get the fault reason

Do not act on the symptom. Every disconnect is mapped from a transport status
code into the closed `FaultReason` union in `packages/whatsappd/src/errors.ts`, and the reason
decides everything that follows.

The reason reaches you as the `error` on the `closed` frame from `watch()` or
`runtime.onFrame()`, and connection phases arrive on `runtime.onLive()`. If you
supplied a `MetricsHook`, the `transition` and `reconnect` events carry the same
story with attempt counts.

If you have neither wired up, set `WA_LOG_LEVEL=debug` and reproduce — but note
that this is the gap to close after the incident, not during it.

If there is no reason to get — no `closed` frame, no error, no reconnect, the
session simply never announcing `online` — then nothing has faulted and this
step has no answer for you. Go to [§3](#3-the-session-never-reaches-online).

## 2. Look up the disposition

`dispositionFor(reason)` is the single source of truth. Three outcomes:

### `retryable` — do nothing

`restart_required` (515), `connection_lost` (428/408), `timed_out` (408),
`service_unavailable` (503), `unknown`.

The lifecycle loop reconnects on its own with capped exponential backoff
(`backoffDelay` in `packages/whatsappd/src/machine.ts`). A worker restart does not help and
discards the backoff state, so restarting on a schedule turns one slow recovery
into a reconnect storm.

`restart_required` immediately after pairing is expected — it is how WhatsApp
completes a link, not a fault.

Escalate only if `reconnect` attempts keep climbing past several minutes, which
means the far side is refusing consistently and the reason is likely misclassified.

### `logged_out` — wipe and re-pair

`logged_out_remote` (401), `connection_replaced` (440), `pairing_rejected` (400).

The credentials are dead and no amount of retrying revives them. Go to
[`credential-rotation.md`](credential-rotation.md).

`connection_replaced` specifically means another device took over the session.
Retrying is not just useless, it is harmful: each attempt gets replaced again,
and two workers fighting over one account is what the account lease exists to
prevent. Check whether a second worker is running before you re-pair — see
[`stuck-account-lease.md`](stuck-account-lease.md).

### `suspended` — a human is required

`credentials_invalid` (403), `multidevice_mismatch` (411), `bad_session` (500).

Re-pairing will not help. The account or device is refused by WhatsApp:
typically banned, a deprecated client, or not enrolled in multi-device. This
needs a decision from whoever owns the account, not an operational fix.

## 3. The session never reaches `online`

`phase` sits at `authenticated` with `sync.step: "draining"`, no fault is
reported, no reconnect is attempted, and the log says nothing. This is almost
never the transport. **Suspect your own handlers first.**

Subscriber dispatch and the session's own transitions share one serialized
promise chain — that is the ordering guarantee in ADR-0013, not an accident. A
handler is awaited before the next event advances _and_ before the transition
that would take the session to `online`. So a `conversationSync` or `message`
handler that never returns pins the state machine exactly where it is. The
grace timer that would force `online` is itself queued behind that handler, so
no timeout rescues it, and nothing is logged because the log line would have to
run behind the same handler.

Check, in this order:

1. **Is the process burning CPU?** `top`/`ps` showing ~100% of one core with
   state `R` means a synchronous loop inside a handler. Confirm with
   `sample <pid> 1` (macOS) or `perf top -p <pid>` (Linux); a stack of
   `PromiseFulfillReactionJob` under continuous allocation is the signature.
   Nothing in-process can report this to you — a blocked event loop cannot run
   the timer that would notice it, which is why the library stays silent.
2. **Is the process idle instead?** Then a handler is awaiting something that
   never settles — an un-timed-out `fetch`, a lock, a promise nobody resolves.
   Put a timeout on every await inside a handler.
3. **Only then look at the transport.** A genuinely stuck connect produces a
   fault reason, which puts you back at §1.

Both cases are consumer bugs, and the library is behaving as specified in each.
Removing the offending handler body should produce `online` within `syncGraceMs`
(3s by default). If it does not, it really is §1.

Do not "fix" this by moving your work off the handler and dropping the await —
that trades a visible hang for silent reordering. Hand the work to your own
queue explicitly if it must not backpressure ingestion, and accept that
whatsappd no longer knows when it finished.

## 4. The session is up but nothing is arriving

A live socket with no delivered messages is usually one of:

- **Durable acceptance is failing.** The runtime publishes to clients only
  after acceptance commits, so a failing data store stops delivery while the
  socket stays healthy. A structured data-store failure stops the session and
  publishes no patch; check the store first.
- **Handlers are throwing.** Every matching handler is awaited before the next
  event advances, and a rejection fails the session pipeline. One slow or
  throwing handler stalls the queue behind it — and a handler that never
  returns stalls it permanently, including the connection transitions ([§3](#3-the-session-never-reaches-online)).
- **The chat was never read.** For the friendly `Client`, a chat that has never
  been read retains nothing and its live messages are dropped rather than
  buffered. This is by design; page the chat once to start accumulating.
- **A view went empty.** If the Client missed a revision it replaces state from
  a fresh snapshot, and snapshots carry no messages. An emptied view is a
  signal to re-page, not an empty chat.

## 5. After the incident

If step 1 sent you to `WA_LOG_LEVEL=debug`, wire up `MetricsHook` or the
`closed` frame's `error` so the next incident starts at step 2 instead.
