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

## Runtime, backend, and Client

The Runtime owns one account. It claims the account lease before WhatsApp is
opened, durably accepts each change, and publishes it to Clients only after the
write commits. The friendly Client is awaited: when its factory resolves,
account, chat, contact, and group state are already hydrated.

For a Current Mirror, credentials, Account Leases, and media that survive
process replacement, install the optional libSQL client:

```bash
pnpm add whatsappd @libsql/client
```

<!-- packed-client-typecheck -->

```ts
import {
  createWhatsAppClient,
  createWhatsAppRuntime,
  fileMediaStore,
  libsqlBackend,
  type WhatsAppClient,
} from "whatsappd";

const backend = libsqlBackend({
  url: "file:./whatsapp.db",
  accountId: "personal",
  media: fileMediaStore({ directory: "./whatsapp-media" }),
});

const runtime = createWhatsAppRuntime({
  accountId: "personal",
  backend,
});

// Returns once the account is being consumed; the session keeps running.
await runtime.start();

const client = await createWhatsAppClient(runtime);
const c: WhatsAppClient = client;
void c;

const chats = client.chats.list();
const chatId = chats[0]?.chatId;
if (chatId) {
  // get() is in-memory. older() pages the local durable mirror and never asks
  // WhatsApp or the phone for history.
  const before = client.messages.get(chatId);
  if (before.older === "stored") client.messages.older(chatId);
}

// Close in application-owned order. Client closure does not stop the Runtime,
// and Runtime closure does not close the Backend.
await client.close();
await runtime.stop();
await backend.close();
```

`client.chats.list()`, `contacts.list()`, and `groups.list()` return stable,
ordered views. Each namespace has `subscribe(() => ...)`; listeners re-read the
state they need after a committed transition. `messages.get(chatId)` retains
that chat's saved rows and later live upserts, while `messages.older(chatId)`
extends it backwards through the local mirror. `"exhausted"` means only that no
older row is stored locally.

Connection, identity, and presence are live state. A replacement process over
the same database and media directory reconstructs durable records and observed
instants, but reports no connection, identity, or presence until a session
attaches. Starting a second Runtime while another process holds the account
rejects with `AccountAlreadyClaimedError` before any socket opens.

Images, videos, audio and voice notes, documents, and stickers are downloaded
while the live WhatsApp handle is usable. `fileMediaStore()` writes private,
immutable objects; libSQL stores only an opaque reference and a `stored` or
typed `failed` state. Read bytes explicitly with
`backend.media.read({ accountId, ref })`.

A local `file:` database uses WAL, so `whatsapp.db-wal` and
`whatsapp.db-shm` sit beside it. Move or copy the database only while its Backend
is closed, and keep all three files together.

## Observability

A session reports what it is doing through `metrics`, a synchronous hook that
receives connection transitions, inbound messages, updates, contacts, presence,
groups, sends, and reconnect attempts. It carries shapes and counts — a message
event names its `kind` and whether it arrived live, never its text or its
sender — so the hook can be pointed at a metrics backend without routing private
content there.

```ts
const session = createSession({
  store,
  auth: qrAuth(),
  metrics: (event) => {
    if (event.type === "transition") gauge("whatsapp.phase", event.to);
    if (event.type === "reconnect") counter("whatsapp.reconnect", event.attempt);
  },
});
```

A hook that throws is caught and logged rather than allowed to break the
connection, so an unreachable metrics backend degrades the telemetry and
nothing else.

Logging is separate. The library logs at `warn` by default — set `WA_LOG_LEVEL`
to change it — and the logger it builds censors message bodies, addresses, and
credentials, because the errors it reports come from the protocol layer and can
arrive carrying the payload that failed to send. Passing your own `logger` opts
out of that entirely and gives you exactly what you configured; see
[ADR-0031](docs/adr/0031-the-default-logger-censors-what-it-cannot-vouch-for.md).

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

## Working on whatsappd

```bash
pnpm install
pnpm test
```

That is the whole setup from a fresh clone — no database to start, no service to
run, and no WhatsApp account to obtain. `CONTRIBUTING.md` covers the inner loop,
the checks CI runs, and the conventions review will hold you to.

Three environment variables exist, all optional and none of them secret:
`WA_LOG_LEVEL` sets the level of the default session logger, while `LOG_LEVEL`
and `AUTH_DIR` only affect the test harnesses. `.env.example` documents them.
Credentials never travel by environment variable — they live behind a
`CredentialStore`.
