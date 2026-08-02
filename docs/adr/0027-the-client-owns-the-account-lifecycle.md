---
status: accepted
---

# The Client owns the account lifecycle

The framework-independent WhatsApp Client is the one ordinary application
resource for a WhatsApp Account. An awaited `createWhatsAppClient(options)`
opens owned Backend and Session adapters, creates the internal Runtime, acquires
the Account Lease, starts live consumption, hydrates the Current Mirror, and
returns only after coherent application state is readable.

The Runtime remains an implementation role: it owns durable acceptance,
projection, live Session consumption, reconciliation, and the Account Lease.
It is not an ordinary root interface and applications do not start, stop, or
pass Runtime objects into the Client. Runtime-to-Client snapshots, patches,
revisions, frames, accepted-source records, and stored-page cursors remain
private synchronization details.

Backend and Session remain real adapter seams because multiple production and
local/deterministic adapters exist. The Client receives factories rather than
borrowed live instances. Every adapter instance returned by those factories is
owned by that Client, including cleanup when creation fails.

`client.close()` latches the Client closed, cancels subscriptions and Client
waits, closes every Opened Conversation, stops the internal Runtime and Session,
releases the Account Lease, and closes the Backend last. Concurrent calls join
one teardown. Cleanup continues after an individual failure, and the primary
failure is reported after every applicable release has been attempted.

A Runtime that terminates after Client creation immediately removes live
connection and presence and exposes Runtime Closure through account state. The
last coherent durable state remains readable until explicit Client close. A
Runtime that terminates before initial hydration makes Client creation fail; it
cannot leave the factory waiting behind a blocked read.

A live connection or presence observation cannot outlive the Account Lease
that made it trustworthy. The Runtime caps each live frame's freshness at that
lease's expiry, so a stalled renewal or replacement holder makes the old
Client's live state unavailable without adding a second lease query to Client
reads or recovery. The deadline is authoritative, not a timer wake-up: an early
wake re-arms until the wall clock reaches it, while account and conversation
reads and each listener delivery derive the live view at that instant. Timers
publish the eventual expiry transition but never authorize stale state.

## One transition authority

The Client prepares all state affected by one contiguous patch or recovery,
commits every namespace and Opened Conversation synchronously, and only then
notifies application listeners. Hydration and recovery reads happen outside
that commit. Their results carry a Client generation and cannot publish after a
newer recovery, Runtime Closure, or resource close.

A hard Client failure follows the same boundary: it detaches live input,
cancels owned deadlines, closes every Opened Conversation, and discards queued
nonterminal notifications before publishing terminal account state. A terminal
listener therefore cannot cross-read a still-live resource owned by that Client.

Runtime Closure bypasses hydration and recovery queues. A conversation opened
during recovery validates the committed generation before `open()` resolves,
so it cannot return state older than the Client it belongs to.

Each stored message page carries the Current Mirror revision at which it was
read. A page newer than the Client starts the same recovery transaction used by
a frame gap; it cannot commit beside older account or chat state. A page older
than the Client may still merge by message identity because the intervening
Runtime patches are already committed. Recovery replacement windows commit
only when every page has exactly the fresh global snapshot revision.

This transition mechanism consumes already projected Current Mirror records.
It is not a second projection reducer and does not change the Accepted Source
Batch transaction, source cursor, fencing, or Current Mirror semantics.

## Considered options

- **Keep independent Backend, Runtime, and Client ownership**: rejected because
  every application must coordinate three lifecycles and the Client cannot own
  terminal cancellation and recovery completely.
- **Hide Runtime but borrow an application-owned Backend**: rejected for the
  ordinary seam because callers would still own two teardown orders and Client
  creation failure could not release everything it acquired.
- **One Client owning adapter instances and the internal Runtime**: accepted
  because every account resource has one owner while Backend and Session remain
  replaceable through their existing adapter seams.
- **Adopt an effect or state framework**: rejected because native promises,
  abort-aware waits, generation checks, and synchronous commit-before-notify
  express the required lifecycle without a new public programming model.

## Consequences

- ADR-0006 is superseded where it requires applications to create public
  Runtime objects. Applications continue to own and supervise worker processes.
- ADR-0023 is superseded where it gives Backend, Runtime, and Client independent
  lifetimes. Its namespaced synchronized-state interface remains accepted.
- ADR-0004 remains unchanged: Backend Capability contracts stay independent
  even though one Client owns the adapter instances composed for its account.
- Account Worker processes create one Client per account and close that Client
  during process teardown.
- The pre-0.3 root interface makes a hard cut. No compatibility overload accepts
  a public Runtime, and no speculative advanced Runtime subpath is introduced.
