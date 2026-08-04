# whatsappd

The [SDK capability catalogue](docs/sdk-capabilities.md) lists what Baileys
offers, what whatsappd exposes today, and the planned friendly Client API. It is
a human-maintained planning guide, not a product authority or merge gate.
Verification status is deliberately plain: automated tests exist, while live
WhatsApp, browser React, and OpenTUI runs have not been performed.

A typed WhatsApp session engine for Node.js. It normalizes Baileys events,
awaits application handlers in source order, and keeps credentials behind an
opaque replaceable store.

## Install

```bash
pnpm add whatsappd
```

Node.js 20 or newer is required.

## Session

```ts
import { createSession, fileStore, qrAuth } from "whatsappd";

const session = createSession({
  store: fileStore("./.wa-auth"),
  auth: qrAuth(),
});

const unsubscribe = session.subscribe({
  connection(status) {
    console.log(status.phase);
  },
  async message(message, { reply }) {
    if (message.kind === "text" && message.text === "ping") {
      await reply("pong");
    }
  },
});

await session.start();
unsubscribe();
```

`subscribe()` accepts any subset of `connection`, `conversationSync`, `message`,
`update`, `contact`, `group`, and `presence` handlers. It returns one idempotent
cleanup function and accepts `{ signal }` for cancellation. Every matching
handler is awaited before the next normalized event advances. A rejection fails
the session pipeline.

Messages are pure data. Reply is available only in message-handler context and
quotes the handled message by default.

## Commands

```ts
await session.send(chatId, { text: "hello" });
await session.markRead([messageRef]);
await session.setTyping(chatId, true);
```

The session also exposes `groupMetadata()`, `profilePictureUrl()`, `identity()`,
and `stop()`.

## Credentials

`CredentialStore` is an opaque string key/value capability. The package ships
file and memory stores from the root entry point. `fileStore(dir)` owns only its
private `.whatsappd-credentials` child: `clear()` never removes `dir` or any
unrelated file. Writes atomically replace a private `0600` state file, and old
per-key files are migrated on first read. A later `clear()` removes every
recognized old Baileys credential file—even one never read—from a replacement
process while preserving other caller-owned entries.

## Runtime, backend, and client

The runtime owns one account: it claims the account lease before WhatsApp is
opened, durably accepts each WhatsApp change, and publishes what changed to
clients only after that acceptance commits.

```ts
import {
  createInProcessWhatsAppClient,
  createSession,
  createWhatsAppRuntime,
  memoryBackend,
  qrAuth,
} from "whatsappd";

const runtime = createWhatsAppRuntime({
  accountId: "personal",
  backend: memoryBackend(),
  openSession: (credentials) => createSession({ store: credentials, auth: qrAuth() }),
});

// Returns once the account is being consumed; the session keeps running.
await runtime.start();

const client = createInProcessWhatsAppClient(runtime);

for await (const frame of client.watch()) {
  // The snapshot is account state, chat summaries, contacts, and groups - never
  // a message window per chat.
  if (frame.type === "snapshot") console.log(frame.snapshot.revision, frame.snapshot.chats);
  if (frame.type === "patch") console.log(frame.patch.revision, frame.patch.upserts);
}

// One chat's stored messages, newest first, then scroll back through
// `nextBefore`. This reads the backend only - it never asks WhatsApp for
// anything.
const page = await client.messages("15551234567@s.whatsapp.net", { limit: 25 });
const older = page.nextBefore
  ? await client.messages("15551234567@s.whatsapp.net", { before: page.nextBefore })
  : undefined;

// Releases the account lease, and reports a session that died on its own.
await runtime.stop();
```

For a Current Mirror, credentials, and Account Leases that survive process
replacement, install the optional libSQL client and inject the independent
media capability explicitly:

```bash
pnpm add whatsappd @libsql/client
```

```ts
import {
  createSession,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  qrAuth,
} from "whatsappd";

const backend = libsqlBackend({
  url: "file:./whatsapp.db",
  accountId: "personal",
  media: fileMediaStore({ directory: "./whatsapp-media" }),
});

const runtime = createWhatsAppRuntime({
  accountId: "personal",
  backend,
  openSession: (credentials) => createSession({ store: credentials, auth: qrAuth() }),
});
await runtime.start();

// A replacement backend opened on the same URL reconstructs the accepted
// source, mirror, stored pages, and attachment bytes.

await runtime.stop(); // releases the account; does not close a shared backend
await backend.close(); // the application owns the libSQL client's lifetime
```

A local `file:` database is opened in WAL, so `whatsapp.db-wal` and
`whatsapp.db-shm` sit beside it — move, copy, or delete the three together. WAL
is what lets `read()` hold its transaction open without blocking writers, and
the `-wal` file carries whatever commits land while a long read is open until
that read finishes. A filesystem with no shared memory — many network mounts —
keeps the rollback journal instead, where one open read blocks every writer on
the file until it commits.

Images, videos, audio and voice notes, documents, and stickers are downloaded
while the live WhatsApp handle is usable. `fileMediaStore()` writes their bytes
as private immutable local objects; libSQL stores only the message's opaque
media reference and its `stored` or typed `failed` state. Read bytes explicitly
with `backend.media.read({ accountId, ref })`. The package does not invent a
filesystem URL or browser delivery policy.

A watch begins with the current snapshot and its revision, then delivers each
change as a patch whose `fromRevision` is the revision it applies to; a gap
replaces state with a fresh snapshot rather than applying over it. Replaying a
message the mirror already holds produces no patch.

`messages()` and `watch()` are independent data surfaces; the client does not
maintain an application collection or deduplicate them for you. A consumer
merges message records on `(chatId, messageId)`. A backdated message can arrive
as a patch _and_ appear in the older page that now contains it, and that
identity-based upsert leaves one message. The cursor itself prevents skips or
duplicates _between stored pages_. An exhausted cursor means nothing older is
**stored** — never that WhatsApp has no more.

The friendly Client does that merge for you, per chat, and what it retains grows
with what the application **read**: reading a chat creates its entry, and from
that moment that chat accumulates its live traffic whether or not anything pages
it again. A chat never read retains nothing, and a live message for it is
dropped rather than buffered. There is no eviction policy yet, so a long-lived
process that reads every chat retains every chat.

Reconciling a stored page against the live stream leaves one visible transient.
A page read returns the mirror's state at the moment it ran, which can be ahead
of the changes the Client has applied — and a page never overwrites a message
the Client already holds, only adds ones it does not. So a message edited just
before a page read can briefly show its older text, until the patch carrying
that edit arrives — the Client receives every change through the revision the
page was read at, so the last write is the newest, and the window is its own lag
behind the mirror.

One case resolves differently and an application has to handle it: if the Client
misses a revision, it replaces its state from a fresh snapshot, and a snapshot
carries no messages. The chat empties rather than correcting in place, and the
application pages it again — which is why a view that has gone empty is a signal
to re-page rather than a chat with nothing in it.

Credentials, WhatsApp data, the account lease, and media bytes are four separate
capabilities. `memoryBackend()` groups in-memory implementations of all four;
each one — `memoryDataStore()`, `memoryLeaseStore()`, `memoryMediaStore()` — can
be replaced individually. Starting a second runtime for an account another one
holds rejects with `AccountAlreadyClaimedError` before any socket opens.

The Current Mirror projects text and durable media messages, the chats they
belong to, contacts, and groups. Normalized updates such as receipts are retained
in the accepted-source feed even before they gain a current-mirror projection.
Media edits capture a new immutable object instead of retaining a live
`download()` closure or mutating bytes behind an older reference. A download or
media-store error becomes a visible typed media failure and later messages keep
processing; a structured data-store failure still stops the session and
publishes no patch. Accepted-source reads are bounded and resume from their own
`seq`.

Snapshots expose `contactAliases`, mapping every WhatsApp-delivered PN or LID
form to its owning contact record. When later evidence explicitly links two
previously separate contact records, the patch upserts the consolidated record
and deletes only the redundant current-mirror contact; accepted source evidence
is never deleted. That patch also carries the aliases that changed, and the
delete names the native ids it freed, so a consumer following patches keeps
`contactAliases` coherent without re-reading a snapshot.

Connection and presence are live signals with an expiry: no status is ever
stored, and none is replayed as current truth. The _instant_ each was observed
at is durable, so `lastSeenAt` on a contact and `lastConnectedAt` /
`lastDisconnectedAt` on the account survive a restart as history — a timestamp
never claims anyone is online now.

They are also delivered on their own registration. `watch()` and
`runtime.onFrame()` carry the revision-ordered frames — snapshot, patch, and
closed — while `runtime.onLive()` carries presence and connection, which carry
no revision and so cannot be ordered against a patch (ADR-0030).

A watch ends with a `closed` frame when the runtime stops consuming the account.
It carries the `error` when the session died on its own, and none when it was
stopped deliberately — so a runtime that failed is never mistaken for a quiet
account.

## Deterministic application tests

```ts
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";

const test = createTestWhatsAppSession();

test.session.subscribe({
  async message(_message, { reply }) {
    await reply("Received");
  },
});

await test.emit({
  type: "message",
  message: textMessage({
    id: "m1",
    chatId: "person@s.whatsapp.net",
    text: "Hello",
  }),
});

console.log(test.commands.sent);
```

`emit()` uses the real awaited subscription contract, needs neither WhatsApp nor
sleeps, and records send, mark-read, and typing command inputs.

## Proof

```bash
pnpm test
pnpm check
pnpm build
pnpm proof
```

`pnpm proof` is the opt-in live-account harness. Unit tests and the deterministic
driver do not contact WhatsApp.
