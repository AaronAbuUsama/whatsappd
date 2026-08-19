# whatsappd

A typed WhatsApp Session, durable Current Mirror, and synchronized WhatsApp Client for Node.js.

## Install

```bash
pnpm add whatsappd
```

Node.js 20 or newer is required. Install `@libsql/client` when using the libSQL backend, `convex` when using the Convex backend, and `@whatsappd/react` when a React renderer needs Client subscriptions.

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

### History arrives once, at Pairing

whatsappd asks WhatsApp for a **full** history sync when an account pairs. That
request can only be made at Pairing — the protocol carries it on the registration
node, and a credential that is already linked has no way to ask again. Link an
account light instead if you would rather not receive it:

```ts
createSession({ auth: qrAuth(), store: fileStore("./.wa-auth"), syncFullHistory: false });
```

That is a permanent choice for that credential. Undoing it means pairing again.

`session.requestHistory(anchor)` is the separate, per-chat way to ask the phone
for older messages after linking. See
[`docs/architecture/history-semantics.md`](docs/architecture/history-semantics.md)
for what it does and does not promise.

### Media failures say why

`message.media.download()` rejects with a `MediaDownloadError` carrying `reason`,
`statusCode` and `retryable`, so an expired file and a throttle are not the same
event:

```ts
try {
  const bytes = await message.media.download();
} catch (error) {
  if (error instanceof MediaDownloadError && error.retryable) scheduleRetry();
  else markUnavailable();
}
```

| `reason`      | Cause                                 | `retryable` |
| ------------- | ------------------------------------- | ----------- |
| `expired`     | 404/410 from the CDN                  | no          |
| `throttled`   | 429                                   | **yes**     |
| `unavailable` | 5xx                                   | **yes**     |
| `unknown`     | no status; often a decryption failure | no          |

## Where the account is stored

Backend Capabilities are independent, so a deployment picks each one. `memoryBackend()`
holds everything in process, `libsqlBackend()` puts it in SQLite or Turso, and
`convexBackend()` puts it in a Convex deployment — local or cloud. Media bytes are
always injected separately; `fileMediaStore()` writes them to disk.

For Convex, two files go in the application's own `convex/` directory:

```ts title="convex/schema.ts"
import { defineSchema } from "convex/server";
import { whatsappdTables } from "whatsappd/convex";

export default defineSchema({ ...whatsappdTables });
```

```ts title="convex/whatsappd.ts"
export * from "whatsappd/convex";
```

```ts
const backend = convexBackend({
  url: process.env.CONVEX_URL,
  accountId: "primary",
  media: fileMediaStore({ directory: "./whatsapp-media" }),
});
```

Every adapter answers the same conformance suites, so swapping one changes where the
account lives and nothing else.

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
