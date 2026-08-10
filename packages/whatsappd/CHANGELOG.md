# Changelog

## 0.4.0-alpha.1

### Patch Changes

- Publish the package family after the clean docs and tagged-registry release gates pass.

## 0.4.0-alpha.0

### Minor Changes

- 2a67c63: Keep conversation addresses out of contacts and distinguish unknown group rosters from authoritatively empty rosters.
- 9291dca: Add typed renderer-neutral React Provider/hooks and the shared Client subscription lifetime used by the web and OpenTUI examples.
- 2cbd857: Add the static documentation site and version-locked source registry delivery for the package family.
- 5b56770: Publish the editable OpenTUI components and complete inbox block through the
  version-locked source registry.
- 10cc549: Publish the editable web chat components and complete inbox block through the version-locked source registry.

### Patch Changes

- ef3fc1c: Keep reaction, edit, revoke, and protocol control envelopes out of
  message transcripts, including when reconstructing historical batches.

## 0.3.0

### Minor Changes

- 3ca1d2d: Hard-cut live events to one awaited typed subscription, add the deterministic
  `whatsappd/testing` driver, retain conversation-sync metadata, rename the
  credential capability, and remove agent-era exports.
- b27d364: Capture inbound image, video, audio and voice-note, document, and sticker bytes
  before accepting their messages. Durable source, mirror records, pages, and
  client patches now expose an immutable stored-media reference or a typed capture
  failure. Add the root `fileMediaStore({ directory })` adapter for private,
  restart-safe local attachment bytes while libSQL retains only structured media
  state.
- ebbca1e: Make the awaited, hydrated WhatsApp Client the package-root experience. Export
  `createWhatsAppClient` and its account, chat, contact, group, retained-message,
  and subscription types; rename the friendly interface to `WhatsAppClient`; and
  remove the old frame-oriented Client factory and replication types from the
  root entry point.

  The Client owns reconciliation between live changes and saved pages. Applications
  read named namespaces and close Client, Runtime, and Backend independently.

- 36eb112: Name the actual author of every message. `InboundMessage.from` and
  `addressing` are replaced by `sender: WhatsAppAddress`, which carries the
  author's native address, its identity scheme, and the known equivalent form.
  Own-sent messages now name the linked account instead of the chat peer or
  group, across live messages, synchronized history, and edits.
  `ConversationSyncBatch.self` is removed — it was never populated and is not an
  identity source.
- a98e1ec: Carry every mutation kind the projection computed on the patch (ADR-0030,
  amending ADR-0011). `WhatsAppPatch.aliases` carries the Address Resolution
  that changed, and `MirrorDelete.freedNativeIds` names the native ids a
  consolidated-away contact record owned.

  The projection has always computed all three kinds and the patch shipped two,
  so a consumer maintaining state from patches could not keep Address
  Resolution coherent at all — it could only discard its state and re-read a
  snapshot, which is the gap-recovery path, on an ordinary event. WhatsApp
  delivers PN/LID equivalence routinely (ADR-0022), so that was not rare.

  Only a native id whose owner actually changed appears in `aliases`:
  re-observing a contact re-asserts every alias it already had, and carrying
  those would move the mirror revision on an observation that told it nothing.
  Every id a delete frees is re-pointed by an alias in the same patch, so the
  two arrays need no ordering between them. Accepted source batches are
  unchanged, and ADR-0019's revocation and authoritative-replacement
  restrictions still hold — only the projected patch grows.

- c54b2d9: Run a local libSQL database in WAL, so a read no longer stops every writer on
  the file. `lazyLibsqlClient` sets `journal_mode = WAL` on connect for `file:`
  URLs and reads back the mode actually reached, because an in-memory database
  answers `memory` and a filesystem without shared memory need not reach WAL at
  all.

  `WhatsAppDataStore.read(accountId, fn)` keeps one read transaction open for the
  duration of an application-supplied function. Under the rollback journal that
  refused every writer on the database for as long as `fn` ran — across
  connections, backends, and worker threads alike, with the runtime's `accept()`
  among them — and the native driver's busy wait blocks the event loop while it
  waits rather than yielding it.

  WAL alone does not finish the job: local clients in one process also share a
  write queue, which serialized `accept()` behind an open `read()` no matter what
  the storage engine allowed. A `"read"` operation now skips that queue once WAL
  is confirmed, and `close()` tracks the reads that are no longer in it so it
  cannot return while one is still holding the database open. Writers stay
  queued — two of them still contend, and the loser still busy-waits with the
  event loop stopped.

  The joint-read conformance proof gains the leg it could not have: both stores
  now commit writes _while_ the read is open and are held to answering every
  question at one revision anyway, rather than the libSQL leg agreeing about a
  mirror nothing could write to. A local database now keeps `-wal` and `-shm`
  files beside it.

- 0265b46: Persist one text message through the core runtime. `createWhatsAppRuntime()`
  claims the required account lease before WhatsApp opens, records each durable
  WhatsApp change in the accepted source log, projects it into the current
  mirror, and publishes the resulting patch to clients only after that commits.
  `createInProcessWhatsAppClient()` serves a snapshot followed by contiguous
  revisioned patches, replacing state with a fresh snapshot when a revision gap
  appears. Credentials, WhatsApp data, the account lease, and media bytes are
  four separate capabilities grouped by `memoryBackend()`.

  Acceptance carries its own cursor and claim (ADR-0018): a source consumer
  follows `seq`, which advances for every batch, while `revision` advances only
  when current state actually changed; and a write from a superseded fencing
  token is rejected at the acceptance boundary rather than reaching the mirror.

  A storage failure stops processing with the original failure instead of being
  skipped. This slice projects text messages and the chats they belong to; a
  store rejects unknown durable event kinds with `UnsupportedDurableEventError`
  rather than dropping them. Modeled updates without a current projection remain
  accepted source evidence and advance `seq` without advancing the mirror
  revision. What the runtime observes is accepted whole: a conversation sync's
  contacts are retained alongside the batch's other normalized events. A watch
  ends with a `closed` frame when the runtime stops — carrying the failure when
  the session died rather than being stopped — so a consumer is never left
  waiting on an account nothing is consuming.

  `AccountNotHeldError` reports a runtime acting on an account whose claim it
  never took, has let lapse, or gave back to a stop; the store's
  `StaleAccountClaimError` remains the boundary that can see a newer claim.
  `createTestWhatsAppSession()` now offers `start()` and `stop()`, so a
  deterministic session ends on a handler failure exactly as a live one does.

- aabf2ef: Deliver live and durable frames on separate registrations, and rewrite the
  runtime's frame fanout (ADR-0030). `WhatsAppClientFrame` splits into
  `WhatsAppDurableFrame` — `snapshot`, `patch` and `closed`, every one of them
  a statement about the Current Mirror at a revision — and `WhatsAppLiveFrame`
  — `presence` and `connection`, which carry no revision and stop being true by
  wall clock. `WhatsAppRuntime.onLive()` observes the expiring channel;
  `onFrame()` and `WhatsAppClient.watch()` now carry the revision-ordered one
  alone, so a consumer maintaining a revision-ordered view no longer receives
  values it cannot order against it. `WhatsAppClientFrame` remains exported as
  the union of both.

  The fanout itself carried three defects, all reproduced, all fixed as
  properties of one delivery primitive rather than as rules to re-establish at
  each publication site (ADR-0029 rules 2–4):

  - Listener membership is copied before the first delivery. Iterating the live
    `Set` re-entered a listener that resubscribed during fanout — one
    publication was measured driving 200,000 deliveries.
  - Membership is rechecked before each call, so unsubscribing a _different_
    listener during a fanout takes effect on the frame already in flight.
  - A listener that throws stays subscribed and its failure is surfaced
    asynchronously as a process warning. It was previously unsubscribed silently
    and permanently, so it never received `closed` and its stream simply went
    quiet. The warning is deliberately not a rethrow: a worker with no
    `uncaughtException` handler would end there, and nobody would receive the
    next frame or `closed` — the isolation the surfacing exists to give.
  - Identity on a channel is the registration, not the callback, so
    unsubscribing and re-registering the same function during a fanout takes
    both effects, and one function registered twice is two subscriptions.
  - Each observer's copy is taken outside the region guarding its call, so a
    frame that cannot be cloned costs one delivery instead of removing every
    listener and ending the stream with no terminal frame.

- 860767f: Answer any number of reads about one account at a single revision.
  `WhatsAppDataStore.read(accountId, fn)` runs `fn` inside one read transaction
  and hands it a `MirrorView` — `snapshot()` and `messages()` without the
  account, and without the ambiguity about which revision each answered at
  (ADR-0030).

  Opening a conversation needs both global state and that chat's newest page.
  Taken as two separate reads they arrive at two revisions, and the only
  reconciliation available above the store is read-both-compare-retry, which
  against a live write stream is unbounded and livelock-prone. `read()` exposes
  the transaction boundary both the libSQL and in-memory stores already had
  internally rather than adding a capability, and `snapshot()` and `messages()`
  keep their signatures and behaviour as one-line conveniences over it.

- f0afd05: Add durable, idempotent Client operations for sends, reactions, edits,
  revocations, read receipts, and phone-history requests. Persist queued work in
  memory or libSQL, stage outbound media durably, resume before-boundary work after
  replacement, expose optimistic receipts with wait and acknowledge APIs, and
  keep typing as a non-replayed live command.

  Media adapters now implement streaming `write`/`open` methods instead of
  whole-object `put`/`read`. Buffer sends take one caller-isolating snapshot and
  publish it in bounded chunks; URL and async-iterable sends stream incrementally
  before operation submission. Ambiguous submit responses recover the
  deterministic committed row without deleting its media. Voice notes accept
  already-compatible Ogg Opus mono input and do not transcode.

- 6c7fa6e: Page saved messages and recover revision gaps. A client snapshot is now the
  Snapshot Window it was meant to be — account state, chat summaries, contacts,
  and groups — and no longer carries a message window for every chat, whose size
  grew with chats multiplied by windows while a UI shows one conversation
  (ADR-0010). One chat's messages are read with `client.messages(chatId, { limit })`
  instead, and scrolled with the `nextBefore` cursor each page returns.

  The cursor is `(timestamp, messageId)` descending, both parts load-bearing: a
  history sync lands many messages on one second, and a timestamp-only boundary
  falling inside such a tie would drop or repeat one of them. Reaching the oldest
  saved page returns no cursor, which says that nothing older is _stored_ and
  deliberately makes no claim that WhatsApp history is complete. Paging reads the
  backend alone and issues no WhatsApp history command.

  One chat's view is fed by `messages()` and by the message upserts on `watch()`,
  and the two reconcile on `(chatId, messageId)` rather than by appending — but
  not symmetrically. A page may only _insert_: it never replaces an id already
  held, so a live upsert that landed while a read was in flight is not overwritten
  by the older copy that read was fetching. A patch carries no such rule, because
  by construction it is the newer statement about its id. A backdated message — a
  clock-skewed send, and routinely the backfill of #25 — arrives as a patch _and_
  appears in the older page that now contains it; one message is left, the patch's
  copy survives, and nothing is ever skipped because the cursor is a position in
  the ordering rather than an offset. Each page carries the `revision` it was read
  at, so the two surfaces can be ordered as well as merged.

  Contacts and groups now project instead of only being recorded: the runtime
  subscribes `contact` and `group`, a conversation sync's contacts and its group
  chats' subjects and rosters become mirror records, and a contact merges rather
  than replaces so a presence observation cannot blank a name. A receipt still
  has no current projection, but remains retained in the accepted source log.

  Durable last-seen and account connection timestamps arrive with ADR-0020,
  amending ADR-0014: the runtime derives an `ObservedInstant` from an ephemeral
  signal and accepts _that_, so `ContactRecord.lastSeenAt` and
  `AccountRecord.lastConnectedAt` / `lastDisconnectedAt` survive a restart while
  the `online` and `typing` statuses they came from remain unstorable. The
  instants advance monotonically, so a replayed or late older observation takes no
  revision. Connection Freshness is unchanged — a live connection frame still
  expires and is never hydrated as startup truth.

  A last-seen updates a contact and never creates one because presence supplies no
  equivalence evidence. When a later contact, sync, or message explicitly links
  PN and LID forms, ADR-0022 consolidates redundant Current Mirror contacts while
  the Accepted Source Batches remain intact. A live group rename
  reaches the chat summary as well as the group record, so one Snapshot Window
  never carries two names for the same group.

  `unavailable` is deliberately the one presence kind that stamps nothing: it says
  the address is gone rather than present, and the mapping stamps its `at` with
  receipt time, so recording it would date a week-old last-seen to now and the
  monotonic advance would make that permanent. The final disconnection is stamped
  by teardown, because stopping unsubscribes before the session reaches
  `disconnected` and the handler would otherwise never see it. A contact is
  matched through any of its `nativeIds`, so a LID-keyed update naming its PN
  joins the existing record instead of opening a second one.

### Patch Changes

- 6dfe47a: `fileStore()` recreates its directory on every write instead of once at
  creation. A store whose directory disappeared underneath it — a cleanup job, a
  tmpfs, an operator — used to fail every subsequent credential save with
  `ENOENT` until the process restarted, which is the save that loses the session.
- 2ba1b10: Censor message content, addresses, and credentials in the default logger.
  Errors raised by Baileys or the socket can carry the outbound payload or
  request headers, so logging them wrote message bodies, phone numbers, and auth
  tokens in full. Sessions given an explicit `logger` are unaffected and still
  configure their own redaction.
- 446772f: Stabilize runtime teardown, lease renewal, session failure precedence, and
  credential-file safety. Durable updates now remain in bounded accepted-source
  pages, client watches close terminally, memory values are owned by the store,
  and WhatsApp-delivered PN/LID equivalence consolidates contacts without deleting
  source evidence. Accepted media edits retain restart-safe metadata without their
  live download closure, credential clear removes migrated and untouched legacy
  files across processes, and terminal-frame wrappers are isolated per observer.

## 0.2.2

### Patch Changes

- Wait for socket readiness before requesting pairing codes, and document that
  `phase: "online"`—not conversation-sync batches—is the readiness signal.
- Use WhatsApp's canonical Chrome companion identity for pairing codes and pin
  Baileys 7.0.0-rc14.

## 0.2.1

### Patch Changes

- Start channel-backed sessions without blocking adapter startup, while ensuring
  a stop during socket startup still tears down the late-opened socket.

## 0.2.0

### Minor Changes

- 35eca09: Add callback registrars and in-chat replies to the session surface.

  `session.onStatus/onMessage/onUpdate/onConversationSync/onContact/onGroup/onPresence`
  register a handler and return an unsubscribe; any number of listeners receive
  each event, and a listener that throws or rejects is isolated (logged, never
  fatal). Messages delivered to `onMessage` carry a bound `reply` —
  `m.reply("pong")` takes a string or an `Outbound` and quotes the message by
  default.

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-08

Initial release.

### Added

- WhatsApp session engine over Baileys: a narrow, fully-typed surface
  (`createSession`) with status, inbound, update, contact, group, and presence
  streams, plus `send`/`markRead`/`setTyping` commands. No protocol types cross
  the public surface.
- Pluggable credential stores: `memoryStore`, `fileStore`, and an optional
  `libsqlStore` (via the `whatsappd/stores/libsql` subpath).
- QR and pairing-code auth strategies (`qrAuth`, `pairingAuth`).
- Framework-agnostic channel adapter (`createChannelAdapter`) and eight
  plug-and-play agent tools (`whatsappd/tools`).
- HTTP sidecar (`whatsappd/sidecar`, and the `whatsappd` CLI):
  one process per WhatsApp number, forwarding inbound events and serving media
  on demand.
- Eve framework adapter (`whatsappd/adapters/eve`).

[Unreleased]: https://github.com/AaronAbuUsama/whatsappd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AaronAbuUsama/whatsappd/releases/tag/v0.1.0
