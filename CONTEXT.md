# WhatsApp application substrate

This context describes the WhatsApp-native language shared by the live session,
durable mirror, backend adapters, clients, and UI bindings.

## Language

**WhatsApp Address**:
A protocol-native address for a WhatsApp participant, carrying one primary ID
and every known equivalent native ID, such as its PN and LID forms.
_Avoid_: Identity, contact, person

**Address Resolution**:
The Current Mirror fact that delivered PN or LID forms of a WhatsApp Address
belong to one contact record. It joins only native forms WhatsApp supplied and
never infers a person.
_Avoid_: Identity resolution, person matching

**Message Sender**:
The WhatsApp Address of the actual author of a message, including the linked
account for an own message.
_Avoid_: From, counterpart, chat

**WhatsApp Account**:
One linked WhatsApp identity and its account-scoped credentials, current
mirror, commands, runtime state, and single-writer lease.
_Avoid_: User, channel

**Pairing**:
The account lifecycle operation that links an unregistered WhatsApp Account by
QR or by a dynamically supplied phone number and pairing code.
_Avoid_: Runtime authentication, constructor configuration

**WhatsApp Runtime**:
The backend-independent service that owns one account’s pairing, live session,
durable projection, command execution, reconciliation, and lease lifecycle.
_Avoid_: Sidecar, agent, channel

**Account Worker**:
An application-owned long-running Node process that runs a WhatsApp Runtime for
one account; an application may run several workers as separate processes.
_Avoid_: Sidecar, whatsappd daemon, hypervisor

**Current Mirror**:
The canonical, durable, account-scoped WhatsApp state maintained by the runtime
for clients. It projects current records from Accepted Source Batches; it is not
itself the source-event history.
_Avoid_: Event archive, application database, observation log

**Accepted Source Batch**:
A durable, account-scoped, revisioned batch of normalized WhatsApp events,
appended at the same acceptance boundary that projects the Current Mirror.
Backend consumers follow these batches from their own cursor when they require
source history rather than current state. An ephemeral connection or presence
status is excluded; the instant it was observed at is a derived observation and
is included.
_Avoid_: Client patch, live callback, application observation

**Backend Capability**:
One independently replaceable runtime persistence responsibility: credentials,
accepted/current data, commands, account leases, protected pairing challenges,
or media bytes. A backend factory may conveniently provide several capabilities
without merging their contracts.
_Avoid_: Generic database abstraction, application repository

**WhatsApp Client**:
The backend-independent snapshot, patch, stored-message-page, history-request,
and command contract consumed by applications and the headless React bindings.
_Avoid_: HTTP client, backend SDK

**Stored Message Page**:
An indexed read of messages already present in the Current Mirror for one chat,
using a stable database cursor. It never contacts WhatsApp.
_Avoid_: History sync, phone request, complete history

**History Backfill Request**:
An explicit per-chat command asking WhatsApp for messages older than a known
message key and timestamp. Its request size, phone dependency, and asynchronous
result are distinct from Stored Message Page semantics.
_Avoid_: Pagination, `loadOlder`, proof of available history

**Application Authorization**:
The application-owned policy mapping an authenticated application identity to
per-account read and command permissions, enforced through native backend rules
or application-owned server routes.
_Avoid_: WhatsApp authentication, whatsappd user system

**Account Lease**:
The required single-writer claim on one WhatsApp Account, acquired before the
live socket opens and heartbeated for the session’s life, so starting the same
account twice fails closed.
_Avoid_: Optional deployment detail, advisory lock

**Degraded State**:
The visible runtime condition in which the live session is up but durable
acceptance is failing and being retried in place; processing backpressures
rather than logging and skipping the event.
_Avoid_: Silent retry, crash loop

**Runtime Closure**:
The final frame of a client watch, published when the runtime has stopped
consuming an account — deliberately, or on the failure that ended it. Without
it a runtime that died is indistinguishable from a quiet account, and a watch
waits for ever on an update that cannot come. It is not Degraded State: nothing
is being retried, and nothing follows it.
_Avoid_: Silent stream end, disconnect event, error callback

**Connection Freshness**:
An account’s live connection state paired with the current Account Lease and a
short expiry. Clients treat an expired state or lease mismatch as unavailable;
they never hydrate a previously stored `online` or pairing status as current.
_Avoid_: Durable online event, last known connection, startup truth

**Observed Instant**:
When an address was last seen present, or when an account last connected or
disconnected — derived from an ephemeral signal, durable, and carrying no
status. It is history a restart restores; it never says anything about now.
_Avoid_: Stored presence, last known status, cached online state

**Command Attempt**:
A leased claim on one durable command. An expired claim may return to pending
only before execution begins; an expired executing attempt becomes terminal
`outcome_unknown` and is never transparently retried.
_Avoid_: Permanent running state, automatic send retry, best-effort recovery

**Revision**:
The per-account monotonic Current Mirror number, advanced only when projection
changes state. Snapshots report it and a patch applies only when its
`fromRevision` exactly matches the client’s current revision; source `seq`
advances for every Accepted Source Batch.
_Avoid_: Timestamp ordering, heuristic deduplication

**Snapshot Window**:
The bounded first frame of a client watch — the account, chat summaries,
contacts with their Address Resolution aliases, and groups. An active
conversation loads Stored Message Pages separately.
_Avoid_: Full-mirror dump, event replay, per-chat message window

**Lifecycle Operation**:
An account-scoped command that changes link state rather than chat state —
pairing and unlinking — carried on the same authorized command queue as chat
commands. Runtime state exposes challenge metadata; the raw challenge is read
through a protected short-lived capability.
_Avoid_: Worker-only API, bespoke application glue

**Live Session Subscription**:
The one callback-style live consumption API:
`session.subscribe({ ...typedHandlers })`. Matching async handlers are awaited
in source order; message reply is a session-local callback action rather than a
function stored on the message.
_Avoid_: Seven independent streams, EventEmitter, public event iterator

**Media Capture**:
The immediate attempt to preserve inbound media bytes while the live Baileys
download handle remains usable, producing an opaque durable reference or an
explicit failed state. Voice transcription is a later derivation from stored
audio.
_Avoid_: Media metadata, lazy future download, transcript as source

**Database Oracle**:
A read-only, independently generated account-scoped manifest of stable record
identities, timestamps, revisions, counts, and hashes used to cross-check
public client or browser behavior after that behavior is asserted at its real
seam. It is supporting proof, not a replacement for the public interface.
_Avoid_: Database-coupled component test, personal message fixture, primary API

**Browser Proof**:
An AI-driven run of the real proof application at fixed viewports that combines
semantic and interaction assertions, console and network health, and
privacy-safe screenshots. It proves rendered integration rather than replacing
deterministic tests of state behavior.
_Avoid_: Screenshot-only acceptance, Storybook rendering, manual claim

**Proof Ladder**:
The required depth of evidence for a claim: P0 mechanical, P1 deterministic
behavior, P2 durable integration, P3 native backend, P4 live WhatsApp, P5
interactive browser, and P6 clean consumer or published release. Passing a
lower rung never implies a higher one.
_Avoid_: Tests passed, visually looks right, mechanically green
