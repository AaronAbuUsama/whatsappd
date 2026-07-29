# WhatsApp application substrate

This context describes the WhatsApp-native language shared by the live session,
durable mirror, backend adapters, clients, and UI bindings.

## Language

**WhatsApp Address**:
A protocol-native address for a WhatsApp participant, carrying one primary ID
and every known equivalent native ID, such as its PN and LID forms.
_Avoid_: Identity, contact, person

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
for clients; applications may derive separate archives and product projections.
_Avoid_: Event archive, application database

**Backend Capability**:
One independently replaceable runtime persistence responsibility: credentials,
current data, commands, or account leases. A backend factory may conveniently
provide several capabilities without merging their contracts.
_Avoid_: Generic database abstraction, application repository

**WhatsApp Client**:
The backend-independent snapshot, update, and command contract consumed by
applications and the headless React bindings.
_Avoid_: HTTP client, backend SDK

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
application is failing and being retried in place; ingestion pauses rather
than skips or drops.
_Avoid_: Silent retry, crash loop

**Revision**:
The per-account monotonic number the data store stamps on every applied batch;
snapshots report the revision they include and patches apply only above it.
_Avoid_: Timestamp ordering, heuristic deduplication

**Snapshot Window**:
The bounded first frame of a client watch — the account, chats, contacts,
groups, and each chat’s most recent messages; older history arrives only
through paged reads.
_Avoid_: Full-mirror dump, event replay

**Lifecycle Operation**:
An account-scoped command that changes link state rather than chat state —
pairing and unlinking — carried on the same authorized command queue as chat
commands, with challenges surfaced through runtime state.
_Avoid_: Worker-only API, bespoke application glue
