# whatsappd

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
file and memory stores from the root entry point.

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

await runtime.start();

for await (const frame of createInProcessWhatsAppClient(runtime).watch()) {
  if (frame.type === "snapshot") console.log(frame.snapshot.revision, frame.snapshot.messages);
  if (frame.type === "patch") console.log(frame.patch.revision, frame.patch.upserts);
}
```

A watch begins with the current snapshot and its revision, then delivers each
change as a patch whose `fromRevision` is the revision it applies to. Replaying
a message the mirror already holds produces no patch.

Credentials, WhatsApp data, the account lease, and media bytes are four separate
capabilities. `memoryBackend()` groups in-memory implementations of all four;
each one — `memoryDataStore()`, `memoryLeaseStore()`, `memoryMediaStore()` — can
be replaced individually. Starting a second runtime for an account another one
holds rejects with `AccountAlreadyClaimedError` before any socket opens.

This first slice stores text messages. Any other durable event rejects with
`UnsupportedDurableEventError` rather than being dropped, and a storage failure
stops processing instead of being logged and skipped. Connection and presence
are live signals with an expiry: they are never stored and never replayed as
current truth.

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
