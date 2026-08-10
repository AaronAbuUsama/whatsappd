# whatsappd

A typed WhatsApp Session, durable Current Mirror, and synchronized WhatsApp Client for Node.js.

## Install

```bash
pnpm add whatsappd
```

Node.js 20 or newer is required. Install `@libsql/client` as well when using the libSQL backend, and `@whatsappd/react` when a React renderer needs Client subscriptions.

## Quick start

This example observes connection state and performs no send. Linking a real account is already a side effect; a quick start must never choose a recipient automatically.

<!-- quick-start:start -->

```ts
import { createSession, fileStore, qrAuth } from "whatsappd";

const session = createSession({
  auth: qrAuth(),
  store: fileStore("./.wa-auth"),
});

const unsubscribe = session.subscribe({
  connection(status) {
    console.log(status.phase);
  },
});

try {
  await session.start();
} finally {
  unsubscribe();
  await session.stop();
}
```

<!-- quick-start:end -->

`online` means the socket is ready. Initial WhatsApp sync is separate and may continue afterwards.

## Choose the right layer

- **Session** is the direct, live WhatsApp boundary: normalized updates plus send, typing, read, group, profile-picture, and history commands.
- **WhatsApp Runtime + WhatsApp Client** add the Account Lease, Current Mirror, media storage, Stored Message Pages, and queued WhatsApp Operations.
- **`@whatsappd/react`** adapts WhatsApp Client state to React without owning DOM, CSS, Next.js, shadcn, or OpenTUI.
- **Web and OpenTUI renderers** are editable source delivered through the registry; working applications live in the repository’s `examples/` directory.

## Documentation

- [Tutorials, how-to guides, reference, and explanation](https://aaronabuusama.github.io/whatsappd/docs/)
- [Capability reference](https://aaronabuusama.github.io/whatsappd/docs/reference/capabilities/)
- [Detailed SDK capability catalogue](https://github.com/AaronAbuUsama/whatsappd/blob/master/docs/architecture/sdk-capabilities.md)
- [Operational runbooks](https://github.com/AaronAbuUsama/whatsappd/tree/master/docs/runbooks)

## Verification

The repository builds this README’s quick start against the packed npm artifact. Source tests alone are not used as publication proof.

```bash
pnpm test:pack
```
