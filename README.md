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
file and memory stores from the root entry point and an optional account-scoped
libSQL store from `whatsappd/stores/libsql`.

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
