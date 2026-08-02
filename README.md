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
  createSession,
  createWhatsAppClient,
  createWhatsAppRuntime,
  memoryBackend,
  qrAuth,
} from "whatsappd";

const backend = memoryBackend();
const runtime = createWhatsAppRuntime({
  accountId: "personal",
  backend,
  openSession: (credentials) => createSession({ store: credentials, auth: qrAuth() }),
});

// Returns once the account is being consumed; the session keeps running.
await runtime.start();

// Resolves only after durable account, chat, contact, and group state is hydrated.
const client = await createWhatsAppClient(runtime);
console.log(client.chats.list());

const conversation = await client.chats.open("15551234567@s.whatsapp.net");
const unsubscribe = conversation.subscribe((state) => {
  console.log(state.messages);
});

// Reads an older saved page from the backend and merges it into state. It never
// asks WhatsApp for phone history.
await conversation.loadOlder();

unsubscribe();
conversation.close();
await client.close();
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

Images, videos, audio and voice notes, documents, and stickers are downloaded
while the live WhatsApp handle is usable. `fileMediaStore()` writes their bytes
as private immutable local objects; libSQL stores only the message's opaque
media reference and its `stored` or typed `failed` state. Read bytes explicitly
with `backend.media.read({ accountId, ref })`. The package does not invent a
filesystem URL or browser delivery policy.

The Client owns snapshot hydration, revision recovery, and saved/live message
merging. Applications read or subscribe to account, chat, contact, and group
state, then open only the conversations they need. Runtime frames, patches,
revisions, and database cursors stay inside the package.

An opened conversation deduplicates messages by `(chatId, messageId)` and keeps
them newest-first while saved pages and live updates interleave. `loadOlder()`
joins concurrent reads and merges the next saved page without exposing its
cursor. When `hasOlderSaved` is false, it means only that no older messages are
currently stored — never that WhatsApp has no more.

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
is never deleted.

Connection and presence are live signals with an expiry: no status is ever
stored, and none is replayed as current truth. The _instant_ each was observed
at is durable, so `lastSeenAt` on a contact and `lastConnectedAt` /
`lastDisconnectedAt` on the account survive a restart as history — a timestamp
never claims anyone is online now.

When the runtime stops consuming the account, `client.account` publishes
`closed` state. An unexpected session failure includes its `error`; deliberate
runtime shutdown does not, so failure is never mistaken for a quiet account.

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
