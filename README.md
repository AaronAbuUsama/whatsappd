<p align="center">
  <img src="assets/banner.png" alt="whatsappd — turn a WhatsApp number into an AI agent channel" width="100%">
</p>

<p align="center">
  Turn a WhatsApp number into an AI agent channel — a sealed
  <a href="https://github.com/WhiskeySockets/Baileys">Baileys</a> engine,
  plug-and-play agent tools, an HTTP sidecar, and an
  <a href="https://eve.dev">Eve</a> adapter.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/whatsappd"><img src="https://img.shields.io/npm/v/whatsappd.svg" alt="npm version"></a>
  <a href="https://github.com/AaronAbuUsama/whatsappd/actions/workflows/ci.yml"><img src="https://github.com/AaronAbuUsama/whatsappd/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/whatsappd.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/whatsappd.svg" alt="Node version">
</p>

A **deep module** over [Baileys](https://github.com/WhiskeySockets/Baileys): a
narrow, fully-typed WhatsApp client whose entire connection / auth / message space
is modeled — derived from Baileys' real behaviour, not invented. The Baileys
internals are **sealed**: no Baileys type ever crosses the surface (`grep baileys`
the published `.d.ts` and you get zero hits). You learn one function, three streams,
and two ports; you never reopen the rest.

> **Scope:** `createSession` is tenant-naive — one account per session, storage
> pluggable. The whole package is deliberately single-account: one sidecar
> process per WhatsApp number (see [Multiple accounts](#multiple-accounts)).

## Install

```bash
npm install whatsappd
# optional, only if you use the libsql store:
npm install @libsql/client
```

Requires Node ≥ 20.

## Quick start

```ts
import { createSession, qrAuth } from "whatsappd";
import { fileStore } from "whatsappd";

const session = createSession({
  store: fileStore("./.wa-auth"), // WHERE creds live (pluggable)
  auth: qrAuth(), // or pairingAuth("+15551234567")
  // logger optional; metrics, pacing, status filter all have sane defaults
});

// 1) Lifecycle — one callback per connection fact.
session.onStatus((s) => {
  if (s.phase === "pairing" && s.pairing.step === "challenge_live") {
    console.log("scan/enter:", s.pairing.qr ?? s.pairing.code);
  }
  if (s.phase === "online") console.log("ready to send");
  // logged_out / suspended are terminal
});

// 2) Inbound — one callback per message; `reply` answers in-chat.
session.onMessage(async (m) => {
  if (m.fromMe || !m.live) return;
  if (m.kind === "text" && m.text === "ping") await m.reply("pong");
});

await session.start();
// …later
await session.stop(); // intentional teardown — never reported as a fault
```

Every `onX` has a matching `AsyncIterable` for `for await` —
`for await (const m of session.inbound)` reads the same messages. Callbacks fan
out to any number of listeners and each returns an unsubscribe; a stream is
single-consumer.

## The surface

```ts
const session = createSession(config);

session.status                 // current Status (sync read)
session.connection             // AsyncIterable<Status>          — lifecycle
session.inbound                // AsyncIterable<InboundMessage>  — messages in
session.updates                // AsyncIterable<Update>          — receipts/reactions/edits/revokes

session.onStatus(fn)           // callback per lifecycle event   → Unsubscribe
session.onMessage(fn)          // callback per inbound message (m.reply bound) → Unsubscribe
session.onUpdate(fn)           // callback per receipt/reaction/edit/revoke   → Unsubscribe
//  …also onConversationSync / onContact / onGroup / onPresence

session.start()                // Promise<void> — connect + supervise (auto-reconnect)
session.send(to, msg, opts?)   // Promise<MessageRef>
session.markRead(refs)         // Promise<void> — blue ticks
session.setTyping(chatId, on)  // Promise<void> — typing indicator
session.stop()                 // Promise<void> — intentional teardown
```

### Inbound messages

A closed discriminated union with an `unsupported` catch-all — it is
type-impossible to crash on or silently drop a message. `switch (m.kind)` is
exhaustive:

```ts
for await (const m of session.inbound) {
  switch (m.kind) {
    case "text":
      m.text;
      break;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      m.media;
      m.text /* caption */;
      break;
    case "location":
      m.lat;
      m.lng;
      m.name;
      break;
    case "contacts":
      m.contacts;
      break;
    case "poll":
      m.name;
      m.options;
      break;
    case "unsupported":
      m.rawType;
      break;
  }
}
```

Every message carries `id`, `chatId`, `from`, `fromMe`, `timestamp`, `live`
(`true` = arrived now, `false` = history backfill), `isGroup`, and optionally
`context` (quote/mentions), `addressing` (LID/PN), and `flags`
(viewOnce/ephemeral/edited).

**Media is lazy** — bytes never sit in the stream. Pull them when you're ready;
expired media is transparently re-uploaded and re-fetched:

```ts
if (m.kind === "image") {
  const bytes: Buffer = await m.media.download();
  // m.media also has mimetype, fileLength, width, height, caption, …
}
```

### Sending

`send` is one polymorphic verb and returns a `MessageRef` so you can act on what
you just sent:

```ts
const ref = await session.send(to, { text: "hello" });
await session.send(to, { image: buffer, caption: "hi" }); // Buffer | {url} | {stream}
await session.send(to, { audio: buf, ptt: true }); // voice note
await session.send(to, { location: { lat, lng, name } });
await session.send(to, { contacts: { displayName, vcards } });

// reference-based ops — no proto, just a MessageRef
await session.send(to, { react: { to: ref, emoji: "👍" } }); // emoji "" clears it
await session.send(to, { edit: { target: ref, text: "fixed" } });
await session.send(to, { delete: ref });

// options
await session.send(to, { text: "re:" }, { quote: ref, mentions: ["1555…@s.whatsapp.net"] });
```

`refOf(inboundMessage)` builds a `MessageRef` from something you received.

### Updates

Changes to _existing_ messages arrive on a separate stream:

```ts
for await (const u of session.updates) {
  switch (u.kind) {
    case "receipt":
      u.status;
      /* server_ack → delivered → read → played */ break;
    case "reaction":
      u.emoji;
      u.removed;
      u.by;
      break;
    case "edit":
      u.message;
      /* the new content, same shape as inbound */ break;
    case "revoke":
      u.by;
      break;
  }
}
```

## The two ports

**`SessionStore`** — where credentials live. An opaque key/value store; the module
serializes all Baileys auth state into plain strings, so your store needs **zero
Baileys knowledge**:

```ts
interface SessionStore {
  read(key: string): Promise<string | null>;
  write(entries: Record<string, string | null>): Promise<void>; // null = delete
  clear(): Promise<void>;
}
```

Three are included:

```ts
import { memoryStore, fileStore } from "whatsappd";
import { libsqlStore } from "whatsappd/stores/libsql";

memoryStore(); // ephemeral (tests, scripts)
fileStore("./.wa-auth"); // one file per key
libsqlStore({ url: "file:wa.db", account: "1555…" }); // local SQLite…
libsqlStore({ url: "libsql://…turso.io", authToken, account }); // …or remote Turso
```

The `account` field namespaces rows, so one libsql database can hold many
accounts. Bring your own (Redis, Postgres, DynamoDB, …) by implementing the
three methods over a `(key, value)` table.

**`AuthStrategy`** — how you log in: `qrAuth()` or `pairingAuth(phone)` (E.164,
validated at the edge).

## Multiple accounts

This package is deliberately **single-account**: one session, one adapter, one
sidecar process per WhatsApp number. Running several numbers means running
several sidecar processes — each with its own store dir, port, and
`WHATSAPP_ACCOUNT` label — all forwarding into the same app. Events carry
`accountId`, so the receiver can tell the numbers apart.

Process-per-account is a feature, not a limitation: Baileys sessions
reconnect, re-pair, and occasionally crash-loop; isolating each number in its
own process means one account's bad day never touches another's, and "which
QR is this?" always has an obvious answer. (An in-process multi-account
supervisor used to live here; it was removed — see git history if you ever
need the pattern back.)

**Single ownership still applies.** A WhatsApp number is exactly one
linked-device session — two processes on the same account kick each other off
(the `440 connection_replaced` fault). Point exactly one sidecar at each
credential store.

## Configuration

```ts
createSession({
  store,
  auth,
  logger, // optional; defaults to pino at WA_LOG_LEVEL (or "warn")
  receiveStatusBroadcast, // default false — drop status@broadcast story posts
  sendMinGapMs, // default 1000 — anti-ban gap between sends; 0 disables
  metrics, // (e: MetricEvent) => void — fire-and-forget hook
  verdictWindowMs, // pairing-rejection (silent-400) window
  syncGraceMs,
  reconnectBaseMs,
  reconnectMaxMs,
});
```

**Send pacing** is on by default: outbound sends are funnelled through a FIFO
queue with a minimum gap, because WhatsApp flags bursty accounts. Set
`sendMinGapMs: 0` to disable. (`markRead`/`setTyping` are not paced.)

**Metrics** is an optional observability seam — the session calls it on
`transition`, `message_in`, `update_in`, `message_out`, and `reconnect`. A thrown
hook can never break the connection.

## Connection model (summary)

`status.phase`: `disconnected → connecting → pairing → authenticated → online`,
with `backing_off` for retryable drops and two terminal sinks:

- **`logged_out`** (401/440, or a rejected pairing) — creds are dead; the store is
  wiped for you before the event fires; re-pair.
- **`suspended`** (403/411/500) — account/device problem; re-pairing won't help.

`online` ≠ `authenticated`: the device is only sendable once history sync settles.
The pairing flow honestly reports WhatsApp's silent 400 rejection via a verdict
window.

## Agent channel: sidecar + Eve adapter

The deep module above is transport. On top of it this package ships an **agent
channel**: a sidecar process that owns the Baileys socket, plus a plug-and-play
adapter for the [Eve framework](https://eve.dev). The sidecar POSTs inbound
events to your app; your app POSTs replies back. No Baileys import ever enters
the framework side.

```
WhatsApp ←Baileys WS→ sidecar (this package)  ←HTTP→  Eve app (thin adapter)
```

**1. Run the sidecar** (one process per number; first run prints a QR):

```bash
WHATSAPP_FORWARD_URLS=https://my-app.example/api/channels/whatsapp/event \
WHATSAPP_SIDECAR_TOKEN=s3cret \
npx whatsappd
```

or programmatically: `import { runSidecar } from "whatsappd/sidecar"`.

**2. Drop the channel into your Eve app** as `agent/channels/whatsapp.ts`:

```ts
export { default } from "whatsappd/adapters/eve";
// reads WHATSAPP_SIDECAR_URL / WHATSAPP_SIDECAR_TOKEN, or configure:
// import { whatsappChannel } from "whatsappd/adapters/eve";
// export default whatsappChannel({ sidecarUrl: "http://localhost:8788" });
```

One WhatsApp conversation ↔ one Eve session (`continuationToken` = chat JID).
Replies deliver on `message.completed`; read receipts + typing presence fire on
`turn.started`; inbound media stages through Eve's `fetchFile` from the
sidecar's `/media/...` endpoint.

For non-Eve hosts, `whatsappd/tools` exports the 8 agent tools
(`sendText`, `sendMedia`, `reply`, `markRead`, `setTyping`, `react`, `edit`,
`deleteMsg`) over the same `WhatsAppChannelAdapter` surface, and the sidecar's
HTTP API (`/send`, `/markRead`, `/setTyping`, `/media`, `/health`) is
framework-neutral.

## Develop & test

```bash
npm test          # no-phone tests (mappers, machine, stores, auth round-trip, pacer, channel, sidecar, eve adapter)
npm run typecheck
npm run build     # → dist/ (ESM + types; Baileys kept external; 0 baileys leaks in .d.ts)
```

### Live proof (needs a phone)

```bash
npm run proof              # QR login; message "ping" from another phone → "pong"
npm run proof -- +1555…    # pairing-code login
npm run e2e 1555…          # full outbound suite + self-driven react/edit/delete (loopback)
npm run store-proof        # QR once, then reconnect from libsql with no QR
npm run proof:reset        # kill proof + wipe ./.wa-auth for a fresh QR
```

Always `Ctrl-C` (or `proof:reset`) before clearing auth — never delete the auth
directory under a running session.

## Disclaimer

This package uses **Baileys**, an unofficial reverse-engineered implementation
of the WhatsApp Web multi-device protocol. It is **not affiliated with,
endorsed by, or connected to WhatsApp or Meta** in any way. Automating a
personal WhatsApp account can violate WhatsApp's Terms of Service and may lead
to your number being **temporarily or permanently banned**. Use it at your own
risk, ideally with a number you can afford to lose, and make sure your usage
complies with WhatsApp's terms and any laws that apply to you.

## Contributing

Bug reports and pull requests are welcome.

## License

[MIT](./LICENSE) © Aaron AbuUsama
