# SDK capability catalogue

This is the canonical inventory of what an application can read, do, observe,
persist, test, and render through whatsappd. It records the shipped surface and
the target surface separately. It is not a promise that every row is available.

Audit baseline: whatsappd `0.2.2` at `b27d3641a46935248ca414b4ec9bfd801ce88850`,
with the exact dependency `baileys@7.0.0-rc14`. Re-audit upstream evidence when
that pin changes.

## How to read the catalogue

The broad records below keep stable product capability IDs. Their **whatsappd**
cell does exactly one of two things:

- links to that capability's atomic records in the
  [current evidence ledger](sdk-capability-evidence.md); or
- states a non-current disposition such as upstream-only, deferred, internal,
  unsupported, research-gated, or application-owned.

Broad records never carry proof rungs. Each atomic current record names one
exact outcome, surface, variant, Adapter, lifecycle, required rung, proven rung,
receipt, and gap. Its implementation/support fields map to the required status
vocabulary as follows:

- `implemented` + `supported` → `implemented-and-proven`;
- `implemented` + `unproven` → `implemented-unproven`;
- `implemented` + `internal` → `intentionally-internal`.

The remaining non-current status values are:

- `available-in-baileys`: present in the pinned public Baileys types, not in the
  whatsappd product surface;
- `research-required`: the product cannot yet state a correct contract;
- `unsupported-upstream`: absent from the pinned public upstream surface;
- `intentionally-internal`: necessary plumbing that is not an SDK capability;
- `application-owned`: outside the WhatsApp substrate boundary;
- `deferred`: a valid target with no current implementation commitment.

`P0` through `P6` are the proof rungs in ADR-0017. `live: none` in the
**Upstream** column means the type exists but this repository has no real-account
proof for the operation. Consumer documentation may call only an atomic
`supported` claim available; callable `unproven` claims must retain that label.
Every receipt names its exact `gitHead`. Evidence never transfers between
variants, layers, Adapters, lifecycles, or heads.

### Source indexes (not proof receipts)

These keys locate the broad implementation and upstream declarations used by
the inventory. They do not establish behavior. Exact behavioral receipts live
only in the atomic evidence ledger.

| Key             | Evidence                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| `W:exports`     | `src/index.ts` and the `./testing` export in `package.json`                                  |
| `W:session`     | `src/session.ts`, `src/subscription.ts`                                                      |
| `W:model`       | `src/model/*.ts`, especially `message.ts`, `outbound.ts`, `update.ts`                        |
| `W:runtime`     | `src/runtime/runtime.ts`, `src/runtime/contracts.ts`                                         |
| `W:projection`  | `src/runtime/projection.ts`                                                                  |
| `W:backends`    | `src/runtime/memory.ts`, `libsql.ts`, `file-media.ts`                                        |
| `W:test`        | `src/testing.ts` and the public-seam tests under `tests/`                                    |
| `B:socket`      | `node_modules/baileys/lib/Socket/index.d.ts` and its composed socket declarations            |
| `B:messages`    | `node_modules/baileys/lib/Types/Message.d.ts`                                                |
| `B:events`      | `node_modules/baileys/lib/Types/Events.d.ts`                                                 |
| `B:chat`        | `node_modules/baileys/lib/Types/Chat.d.ts`, `Socket/chats.d.ts`                              |
| `B:groups`      | `node_modules/baileys/lib/Types/GroupMetadata.d.ts`, `Socket/groups.d.ts`                    |
| `B:communities` | `node_modules/baileys/lib/Socket/communities.d.ts`                                           |
| `B:channels`    | `node_modules/baileys/lib/Socket/newsletter.d.ts`                                            |
| `B:business`    | `node_modules/baileys/lib/Socket/business.d.ts`, `Types/Bussines.d.ts`, `Types/Product.d.ts` |

The retained durability receipts are concentrated in four suites:

- `tests/libsql-backend.test.ts` proves process replacement through Runtime,
  Data Store, and Client; image/audio byte restart; SQL rollback; and
  database-time lease fencing;
- the libSQL run of `tests/data-store-conformance.ts` proves accepted/current
  codecs, revisions, account isolation, aliases, and keyset paging against a
  real database, but does not by itself prove a Runtime/Client or byte-capture
  path;
- `tests/media-store.test.ts` proves filesystem-media restart and immutable
  content-addressed reads;
- store conformance and libSQL migration tests prove credential persistence and
  scoped clearing.

## Current public structural surface

This table prevents a capability audit from quietly omitting a public export.
It inventories the structure; the behavioral rows below record what each part
can actually establish.

| Surface                      | Current public symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Catalogue coverage                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Session construction         | `createSession`, `WhatsAppSession`, `SessionConfig`, `qrAuth`, `pairingAuth`, `AuthStrategy`, `CredentialStore`                                                                                                                                                                                                                                                                                                                                                                                                         | `ACC-*`, `LIVE-*`, `CHAT-08`, `MSG-OUT-*`, `MSG-ACT-*`                           |
| Subscription                 | `WhatsAppSessionHandlers`, `MessageHandlerContext`, `Awaitable`, `Unsubscribe`                                                                                                                                                                                                                                                                                                                                                                                                                                          | `ACC-01`, `CHAT-07`, `MSG-IN-*`, `MSG-ACT-*`, `LIVE-*`, `CONTACT-01`, `GROUP-01` |
| Credential stores            | `memoryStore`, `fileStore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `DATA-01`; backend matrix                                                        |
| Pure model                   | `Status`, `PairingState`, `SyncState`, `WaIdentity`, `InboundMessage`, `MessageContext`, `WhatsAppAddress`, `MessageFlags`, `MediaMeta`, `MediaHandle`, `ContactUpdate`, `Outbound`, `BinaryInput`, `MessageRef`, `SendOptions`, `GroupMetadata`, `GroupParticipant`, `GroupParticipantAction`, `GroupUpdate`, `PresenceKind`, `PresenceUpdate`, `Update`, `ReceiptStatus`, `MetricEvent`, `MetricsHook`, `ConversationSyncBatch`, `ConversationSyncContext`, `ConversationSyncSource`, `HistoryChat`, `HistoryContact` | `ACC-*` through `GROUP-*`, `MEDIA-*`, `DATA-*`                                   |
| Pure helpers                 | `isTerminal`, `isOnline`, `refOf`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `ACC-01`, `MSG-OUT-09`, `MSG-OUT-11` through `MSG-OUT-13`                        |
| Runtime and low-level Client | `createWhatsAppRuntime`, `createInProcessWhatsAppClient`, `RuntimeSession`, `WhatsAppRuntime`, `WhatsAppRuntimeConfig`, `WhatsAppClient`                                                                                                                                                                                                                                                                                                                                                                                | `DATA-*`, `OPS-*`; selected interface and current-path sections                  |
| Backend contracts            | `WhatsAppBackend`, `WhatsAppDataStore`, `AccountLeaseStore`, `MediaStore`, `AcceptedWhatsAppBatch`, `AccountLease`, `AccountRecord`, `ChatRecord`, `ContactRecord`, `DurableInboundMessage`, `DurableMedia`, `DurableUpdate`, `GroupRecord`, `MessageRecord`, `MirrorRecord`, `ObservedInstant`, `StoredMessageCursor`, `StoredMessagePage`, `StoredMessagePageOptions`, `WhatsAppClientConnectionState`, `WhatsAppClientFrame`, `WhatsAppDataEvent`, `WhatsAppDurableEvent`, `WhatsAppPatch`, `WhatsAppSnapshot`       | `DATA-*`, `MEDIA-*`, `OPS-*`; backend matrix                                     |
| Backend implementations      | `memoryBackend`, `memoryDataStore`, `memoryLeaseStore`, `memoryMediaStore`, `libsqlBackend`, `LibsqlBackend`, `LibsqlBackendOptions`, `fileMediaStore`, `FileMediaStoreOptions`                                                                                                                                                                                                                                                                                                                                         | Backend matrix                                                                   |
| Errors                       | `PairingError`, `classifyDisconnect`, `isRetryable`, `dispositionFor`, `assertE164`, `FaultReason`, `WhatsAppFault`, `Disposition`, `AccountAlreadyClaimedError`, `AccountNotHeldError`, `StaleAccountClaimError`, `UnsupportedDurableEventError`                                                                                                                                                                                                                                                                       | `ACC-02`, `ACC-03`, `DATA-07`, `OPS-02`                                          |
| Testing subpath              | `textMessage`, `createTestWhatsAppSession`, `TextMessageInput`, `TestWhatsAppEvent`, `RecordedSessionCommands`, `TestWhatsAppSessionDriver`                                                                                                                                                                                                                                                                                                                                                                             | `TEST-*`                                                                         |

## Selected application interface

ADR-0023 selects a framework-independent, namespaced Client with an opened
conversation. This is the target DX that vertical issues build against:

```ts
const runtime = createWhatsAppRuntime({ accountId, backend, openSession });
const client = createWhatsAppClient(runtime);
await runtime.start();

const stop = client.subscribe((state) => render(state), { signal });
const conversation = await client.chats.open(chatId, { signal });

await conversation.send.text("Hello");
await conversation.send.document(bytes, {
  fileName: "invoice.pdf",
  mimetype: "application/pdf",
});
await conversation.messages.react(messageId, "👍");
await conversation.markRead();
await conversation.loadOlder(); // saved database rows only
await conversation.requestPhoneHistory(); // a distinct, fallible phone request

conversation.close();
stop();
await client.close();
await runtime.stop();
await backend.close();
```

The namespace inventory is concrete even when its capabilities are deferred:

```ts
client.account; // status, identity, pairing, unlink, profile, privacy, blocklist
client.chats; // list, get, open, archive, mute, pin, clear, delete
client.contacts; // synced WhatsApp contacts and registration lookup
client.groups; // metadata, participants, invites, approvals, settings
client.communities; // communities and linked groups
client.channels; // WhatsApp channels/newsletters
client.calls; // call events, reject, and call links
client.business; // profile, catalog, products, orders, labels, quick replies
client.operations; // durable side-effect receipts and outcomes
client.media; // authorized reads of injected durable media
```

An opened conversation owns `state`, `subscribe`, `loadOlder`,
`requestPhoneHistory`, `send`, `messages`, `markRead`, `typing`, and `recording`.
It reconciles live upserts and saved pages by `(chatId, messageId)`. Runtime
frames, mirror revisions, cursors, accepted-source sequence numbers, leases,
credentials, protocol nodes, and crypto never cross this friendly surface.

Reads return domain values. A durable side effect accepts an optional
`idempotencyKey` and returns `WhatsAppOperation<T>`. The operation progresses
through `queued`, `claimed`, `executing`, then `succeeded`, `failed`, or
`outcome_unknown`. Callers may `get` or `subscribe` through `client.operations`.
An ambiguous execution is never automatically submitted again. `AbortSignal`
cancels the caller's wait, not an already durable operation.

`client.close()` closes the Client's subscriptions and conversations. It does
not stop or close an application-created Runtime or Backend. The composition
root owns those resources and closes them explicitly.

### Interface alternatives graded

Scores are 1 (poor) to 5 (strong).

| Option                              | Floor-first | Reversible | Blast radius | Correctness/integrity | Parallelizable | Fit | Decision                                                                              |
| ----------------------------------- | ----------: | ---------: | -----------: | --------------------: | -------------: | --: | ------------------------------------------------------------------------------------- |
| Flat method collection              |           4 |          3 |            2 |                     3 |              2 |   2 | Reject: cheap initially, degrades discovery and ownership as domains grow.            |
| Universal `execute(name, payload)`  |           3 |          4 |            3 |                     2 |              4 |   2 | Internal command envelope only; reject as public DX because it erases typed outcomes. |
| Namespaces plus opened conversation |           5 |          4 |            4 |                     5 |              5 |   5 | Selected: one state owner, domain discovery, and vertical implementation seams.       |

## Current Runtime to Client path

The current path was audited rather than inferred from the issue graph:

```text
WhatsAppSession.subscribe(handlers)
  -> createWhatsAppRuntime captures media bytes when required
  -> WhatsAppDataStore.accept(accountId, events, fencingToken)
       always appends Accepted Source and conditionally projects Current Mirror
       in one memory/libSQL transaction; source seq always advances, while mirror
       revision advances only when the projection changes
  -> Runtime publishes a patch only for a changed mirror; ephemeral state is live-only
  -> createInProcessWhatsAppClient.watch()
       yields snapshot, contiguous patches, presence, connection, closure

WhatsAppClient.messages(chatId, cursor)
  -> WhatsAppDataStore.messages(accountId, chatId, cursor)
       reads a stable saved-message keyset page independently of watch()
```

`src/runtime/runtime.ts` publishes no projected state before `accept()` commits.
Source-only batches such as receipts and reactions remain available through
`accepted(afterSeq)` without manufacturing a mirror revision or Client patch.
`src/runtime/projection.ts` is shared by the memory and libSQL adapters and reads
only account/chat/contact/group/message keys touched by the accepted batch. The
libSQL adapter does not hydrate every stored message to project one event.

The current Client already re-snapshots after a revision gap, but it does not
own an application message collection: its public contract instructs every
caller to merge `watch()` upserts and `messages()` pages by identity. Commands
remain on `WhatsAppSession`, not `WhatsAppClient`. Those two facts—not a React
rendering concern—are why ADR-0023 puts synchronized application state and
typed operations in the next framework-independent Client.

## Capability records

### Account, connection, profile, privacy, and blocking

| ID       | Caller-facing outcome                                                                                                      | Upstream                                                                                       | whatsappd now                                                             | Target Client / React                                               | Backend, execution, owner                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ACC-01` | Observe disconnected, connecting, pairing, authenticated, online, backoff, logged-out, and suspended states.               | `available-in-baileys` (`B:events connection.update`); live: none                              | See [atomic current claims](sdk-capability-evidence.md#acc-01).           | `account.state`, `account.subscribe`; `useAccount`, `useConnection` | Volatile live state plus durable observed instants; public terminal-state proof remains open |
| `ACC-02` | Pair by QR and observe expiring challenge state.                                                                           | `available-in-baileys`; live: none                                                             | See [atomic current claims](sdk-capability-evidence.md#acc-02).           | `account.pair({ method: "qr" })`; `usePairing`                      | Commands + protected challenge + trusted worker; #23, 0.3 target                             |
| `ACC-03` | Pair by validated phone number and pairing code.                                                                           | `available-in-baileys` (`requestPairingCode`); live: none                                      | See [atomic current claims](sdk-capability-evidence.md#acc-03).           | `account.pair({ method: "code", phoneNumber })`; `usePairing`       | Commands + protected challenge; #23, 0.3 target                                              |
| `ACC-04` | Unlink WhatsApp while retaining saved chats and other accounts.                                                            | `available-in-baileys` (`logout`); live: none                                                  | `deferred`; credential clear exists but no authorized lifecycle operation | `account.unlink()`; `useUnlink` only if shared workflow emerges     | Commands + credentials; trusted worker; #23                                                  |
| `ACC-05` | Start and stop the application-owned live worker.                                                                          | `available-in-baileys`; live: none                                                             | See [atomic current claims](sdk-capability-evidence.md#acc-05).           | `runtime.start/stop`; `client.close` releases Client resources      | Credentials + lease + data + media; shipped lower-level                                      |
| `ACC-06` | Read the connected account identity.                                                                                       | `available-in-baileys` (`socket.user`); live: none                                             | See [atomic current claims](sdk-capability-evidence.md#acc-06).           | `account.identity()` / `useAccount`                                 | Live trusted worker; shipped lower-level                                                     |
| `ACC-07` | Read a profile picture URL.                                                                                                | `available-in-baileys` (`profilePictureUrl`); live: none                                       | See [atomic current claims](sdk-capability-evidence.md#acc-07).           | `account.profile.picture(jid)`                                      | Live trusted worker; release undecided                                                       |
| `ACC-08` | Set or remove a profile picture.                                                                                           | `available-in-baileys` (`updateProfilePicture`, `removeProfilePicture`); live: none            | `available-in-baileys`                                                    | `account.profile.setPicture/removePicture`                          | Durable command; deferred                                                                    |
| `ACC-09` | Read or update profile about/status and display name.                                                                      | `available-in-baileys` (`fetchStatus`, `updateProfileStatus`, `updateProfileName`); live: none | `available-in-baileys`                                                    | `account.profile.about/setAbout/setName`                            | Durable command for writes; deferred                                                         |
| `ACC-10` | Read privacy settings.                                                                                                     | `available-in-baileys` (`fetchPrivacySettings`); live: none                                    | `available-in-baileys`                                                    | `account.privacy.get()`                                             | Live trusted worker; deferred                                                                |
| `ACC-11` | Update last-seen, online, photo, about, receipt, group-add, call, message, link-preview, and default-disappearing privacy. | `available-in-baileys` (`B:chat update*Privacy`, `updateDefaultDisappearingMode`); live: none  | `available-in-baileys`                                                    | `account.privacy.update(patch)`                                     | Durable command; defer atomically until native semantics are proven                          |
| `ACC-12` | Read the blocklist.                                                                                                        | `available-in-baileys` (`fetchBlocklist`, `blocklist.set/update`); live: none                  | `available-in-baileys`                                                    | `account.blocklist.list/subscribe`                                  | Current mirror + command; deferred                                                           |
| `ACC-13` | Block or unblock one WhatsApp address.                                                                                     | `available-in-baileys` (`updateBlockStatus`); live: none                                       | `available-in-baileys`                                                    | `account.blocklist.block/unblock`                                   | Durable command; deferred                                                                    |
| `ACC-14` | Authenticate an application user and decide which WhatsApp accounts they may access.                                       | `unsupported-upstream`                                                                         | `application-owned` (ADR-0007)                                            | Not a Client login namespace                                        | Host auth/routes or native backend rules; application-owned                                  |
| `ACC-15` | Access raw credentials, signal keys, pairing secrets, prekeys, or crypto operations.                                       | `available-in-baileys`                                                                         | `intentionally-internal`                                                  | No friendly Client operation                                        | Credential/protected-challenge capabilities only; never consumer data                        |

### Chats, saved paging, and phone history

| ID        | Caller-facing outcome                                                                | Upstream                                                                                                               | whatsappd now                                                                          | Target Client / React                                                                    | Backend, execution, owner                               |
| --------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `CHAT-01` | List current chat summaries.                                                         | `available-in-baileys` (`B:events chats.*`, history sync); live: partial                                               | See [atomic current claims](sdk-capability-evidence.md#chat-01).                       | `chats.list()`; `useChats`                                                               | Data mirror; owner to be assigned by #68                |
| `CHAT-02` | Read one current chat.                                                               | `available-in-baileys`                                                                                                 | See [atomic current claims](sdk-capability-evidence.md#chat-02).                       | `chats.get(chatId)`; `useChat`                                                           | Data mirror; friendly DX                                |
| `CHAT-03` | Open one synchronized conversation.                                                  | n/a product composition                                                                                                | `deferred`; consumers currently combine `watch()` and `messages()` themselves          | `chats.open(chatId)`; `useConversation`                                                  | Client-owned state per ADR-0023; friendly DX            |
| `CHAT-04` | Page older messages already saved in the backend.                                    | n/a storage read                                                                                                       | See [atomic current claims](sdk-capability-evidence.md#chat-04).                       | `conversation.loadOlder()`; `useConversation`                                            | Data store; shipped low-level, friendly DX deferred     |
| `CHAT-05` | Ask the phone for older messages and receive a submission receipt only.              | `partial-or-unstable` (`fetchMessageHistory`); a historical live receipt proved phone delivery but no answer (#18/#50) | See [atomic current claims](sdk-capability-evidence.md#chat-05).                       | `conversation.requestPhoneHistory()`; `usePhoneHistoryRequest` if UI needs shared status | Live worker; #50 research, #25 scheduler blocked        |
| `CHAT-06` | Automatically and fairly backfill every eligible chat without claiming completeness. | `research-required` because responses were not observed                                                                | `deferred`                                                                             | `account.history.state/pause/resume`; `useHistoryBackfill`                               | Durable progress + commands; #25/#50                    |
| `CHAT-07` | Observe initial/reconnect/on-demand conversation-sync batches.                       | `available-in-baileys` (`messaging-history.set/status`); live: indicative observation only                             | See [atomic current claims](sdk-capability-evidence.md#chat-07).                       | Internal Client ingestion, not a UI event                                                | Accepted data; on-demand integration proof remains open |
| `CHAT-08` | Mark real message references read.                                                   | `available-in-baileys` (`readMessages`); live: none                                                                    | See [atomic current claims](sdk-capability-evidence.md#chat-08).                       | `conversation.markRead()`                                                                | Durable command target #22                              |
| `CHAT-09` | Archive or unarchive a chat.                                                         | `available-in-baileys` (`chatModify archive`); live: none                                                              | `available-in-baileys`                                                                 | `chats.archive/unarchive`                                                                | Durable command + mirror; deferred                      |
| `CHAT-10` | Mute or unmute a chat.                                                               | `available-in-baileys` (`chatModify mute`); live: none                                                                 | `available-in-baileys`                                                                 | `chats.mute/unmute`                                                                      | Durable command + mirror; deferred                      |
| `CHAT-11` | Pin or unpin a chat.                                                                 | `available-in-baileys` (`chatModify pin`); live: none                                                                  | `available-in-baileys`                                                                 | `chats.pin/unpin`                                                                        | Durable command + mirror; deferred                      |
| `CHAT-12` | Clear messages from a chat locally.                                                  | `available-in-baileys` (`chatModify clear`); live: none                                                                | `available-in-baileys`                                                                 | `chats.clear`                                                                            | Durable command + scoped mirror deletion; deferred      |
| `CHAT-13` | Delete a chat locally.                                                               | `available-in-baileys` (`chatModify delete`); live: none                                                               | `available-in-baileys`                                                                 | `chats.delete`                                                                           | Durable command + scoped mirror deletion; deferred      |
| `CHAT-14` | Configure per-chat disappearing messages.                                            | `available-in-baileys` (`disappearingMessagesInChat`, `groupToggleEphemeral`); live: none                              | `available-in-baileys`                                                                 | `conversation.disappearing.set`                                                          | Durable command; deferred                               |
| `CHAT-15` | Treat saved paging as proof that all phone history is loaded.                        | `unsupported-upstream`                                                                                                 | `unsupported-upstream`: explicitly prohibited by ADR-0010 and #18                      | No operation                                                                             | No backend can infer this from silence                  |
| `CHAT-16` | Mark a chat unread.                                                                  | `available-in-baileys` (`chatModify markRead:false`); live: none                                                       | `available-in-baileys`; current `markRead` only marks real references read             | `chats.markUnread(chatId)`                                                               | Durable command + mirror; deferred                      |
| `CHAT-17` | Observe upstream chat upserts, updates, and deletions.                               | `available-in-baileys` (`B:events chats.upsert/update/delete`); live: none                                             | `available-in-baileys`; the current adapter derives chats from messages/history/groups | Transparent `chats` state                                                                | Data projection with scoped deletion; deferred          |

The historical `CHAT-05` P4 receipt names
`ea536484f61d21fb3baad53b5f36158666e3827a`; it is not proof for this audit
baseline.

### Inbound message families

| ID          | Caller-facing outcome                                                          | Upstream                                                   | whatsappd now                                                      | Target Client / React                                               | Backend, execution, owner                                         |
| ----------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `MSG-IN-01` | Receive text, including extended text.                                         | `available-in-baileys` (`B:messages`); live: none          | See [atomic current claims](sdk-capability-evidence.md#msg-in-01). | `conversation.state.messages`; `useConversation`                    | Data mirror; shipped                                              |
| `MSG-IN-02` | Receive image metadata and downloadable bytes.                                 | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-02). | Same; attachment render slot may expose metadata/actions            | Data + injected media; shipped                                    |
| `MSG-IN-03` | Receive video or GIF metadata and bytes.                                       | `available-in-baileys`; live: no dedicated proof           | See [atomic current claims](sdk-capability-evidence.md#msg-in-03). | Same attachment behavior                                            | Data + injected media; capture shipped, byte replacement unproven |
| `MSG-IN-04` | Receive audio or voice-note metadata and bytes.                                | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-04). | Same attachment behavior                                            | Data + injected media; shipped                                    |
| `MSG-IN-05` | Receive document metadata and bytes.                                           | `available-in-baileys`; live: no dedicated proof           | See [atomic current claims](sdk-capability-evidence.md#msg-in-05). | Same attachment behavior                                            | Data + injected media; capture shipped, byte replacement unproven |
| `MSG-IN-06` | Receive sticker metadata and bytes.                                            | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-06). | Same attachment behavior                                            | Data + injected media; capture shipped, byte replacement unproven |
| `MSG-IN-07` | Receive static location.                                                       | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-07). | `conversation.state.messages`                                       | Data projection required; owner to be assigned by #68             |
| `MSG-IN-08` | Receive one or many contact cards.                                             | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-08). | Same; contact-card render slot only if behavior repeats             | Data projection required; owner to be assigned by #68             |
| `MSG-IN-09` | Receive poll creation.                                                         | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-09). | Same; poll module only with shared voting behavior                  | Data projection required; owner to be assigned by #68             |
| `MSG-IN-10` | Preserve view-once, ephemeral, and edited wrappers as flags.                   | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-10). | Message metadata                                                    | Data schema expansion deferred                                    |
| `MSG-IN-11` | Preserve quotes and mentions.                                                  | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-11). | Message metadata                                                    | Data schema expansion deferred                                    |
| `MSG-IN-12` | Receive live location.                                                         | `available-in-baileys` (`liveLocationMessage`); live: none | See [atomic current claims](sdk-capability-evidence.md#msg-in-12). | `conversation.state.messages`                                       | Modeling and data projection; deferred                            |
| `MSG-IN-13` | Receive buttons, list, template, interactive, or native-flow replies/messages. | `available-in-baileys` (`B:messages`); live: none          | See [atomic current claims](sdk-capability-evidence.md#msg-in-13). | Message union after upstream-contract proof                         | Modeling/data; deferred                                           |
| `MSG-IN-14` | Receive product, order, payment, or invoice messages.                          | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-14). | `business` plus conversation message model                          | Business/data; deferred                                           |
| `MSG-IN-15` | Receive group or newsletter invite messages.                                   | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-15). | Conversation message plus target domain action                      | Data; deferred                                                    |
| `MSG-IN-16` | Receive events, albums, sticker packs, poll results, or protocol notices.      | `available-in-baileys`; live: none                         | See [atomic current claims](sdk-capability-evidence.md#msg-in-16). | Model each user-visible family; protocol-only notices stay internal | Data; deferred                                                    |
| `MSG-IN-17` | Never silently drop an unknown addressable message type.                       | n/a                                                        | See [atomic current claims](sdk-capability-evidence.md#msg-in-17). | Internal compatibility behavior                                     | Data modeling required before durable acceptance                  |

### Outbound messages and message actions

| ID           | Caller-facing outcome                                                                     | Upstream                                                                         | whatsappd now                                                                               | Target Client / React                                                     | Backend, execution, owner                             |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `MSG-OUT-01` | Send text.                                                                                | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-01).                         | `conversation.send.text(text, options)`                                   | Durable commands #22                                  |
| `MSG-OUT-02` | Send image with optional caption.                                                         | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-02).                         | `conversation.send.image(input, options)`                                 | Durable commands #22; media input is caller-owned     |
| `MSG-OUT-03` | Send video or GIF.                                                                        | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-03).                         | `conversation.send.video(input, options)`                                 | Durable commands #22                                  |
| `MSG-OUT-04` | Send audio or voice note.                                                                 | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-04).                         | `conversation.send.audio(input, options)`                                 | Durable commands #22                                  |
| `MSG-OUT-05` | Send document with filename and MIME type.                                                | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-05).                         | `conversation.send.document(input, options)`                              | Durable commands #22                                  |
| `MSG-OUT-06` | Send sticker.                                                                             | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-06).                         | `conversation.send.sticker(input)`                                        | Durable commands #22                                  |
| `MSG-OUT-07` | Send static location.                                                                     | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-07).                         | `conversation.send.location(location)`                                    | Durable commands #22                                  |
| `MSG-OUT-08` | Send one or many vCard contacts.                                                          | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-08).                         | `conversation.send.contacts(cards)`                                       | Durable commands #22                                  |
| `MSG-OUT-09` | Reply/quote a real message reference.                                                     | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-09).                         | Every send accepts `{ replyTo }`                                          | Durable commands #22                                  |
| `MSG-OUT-10` | Mention selected WhatsApp addresses.                                                      | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-10).                         | Text/media send option `{ mentions }`                                     | Durable commands #22                                  |
| `MSG-OUT-11` | React or remove a reaction.                                                               | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-11).                         | `conversation.messages.react/unreact`                                     | Durable commands #22                                  |
| `MSG-OUT-12` | Edit a sent text message.                                                                 | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-12).                         | `conversation.messages.edit`                                              | Durable commands + mirror reconciliation #22          |
| `MSG-OUT-13` | Delete a message for everyone.                                                            | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-out-13).                         | `conversation.messages.revoke`                                            | Durable commands + deletion semantics #22/new issue   |
| `MSG-OUT-14` | Forward a message.                                                                        | `available-in-baileys` (`forward`); live: none                                   | `available-in-baileys`                                                                      | `conversation.messages.forward(targets)`                                  | Durable command; deferred                             |
| `MSG-OUT-15` | Create a poll.                                                                            | `available-in-baileys`; live: none                                               | `available-in-baileys`                                                                      | `conversation.send.poll`                                                  | Durable command/data; deferred                        |
| `MSG-OUT-16` | Send an album.                                                                            | `available-in-baileys`; live: none                                               | `available-in-baileys`                                                                      | `conversation.send.album`                                                 | Durable command/media; deferred                       |
| `MSG-OUT-17` | Send event, group invite, product, button/list reply, phone-number request/share, or PTV. | `available-in-baileys`; live: none                                               | `available-in-baileys`                                                                      | Separate typed send operations only when each product outcome is selected | Deferred; business/group domains where applicable     |
| `MSG-OUT-18` | Send as view-once, set disappearing expiration, or limit forwarding/sharing.              | `available-in-baileys`; live: none                                               | `available-in-baileys`                                                                      | Typed send options after semantics proof                                  | Deferred                                              |
| `MSG-OUT-19` | Supply or suppress a link preview on text.                                                | `available-in-baileys` (`linkPreview`); live: none                               | `available-in-baileys`; current text outbound has no preview option                         | `conversation.send.text(text, { linkPreview })`                           | Durable command; deferred                             |
| `MSG-ACT-01` | Observe delivery/read/played/error receipts, including group participant.                 | `available-in-baileys` (`messages.update`, `message-receipt.update`); live: none | See [atomic current claims](sdk-capability-evidence.md#msg-act-01).                         | `conversation.messages` authoritative state and operation result          | Data projection/reconciliation; #22/new issue         |
| `MSG-ACT-02` | Observe reactions and removals.                                                           | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-act-02).                         | Same                                                                      | Data projection/reconciliation; owner assigned by #68 |
| `MSG-ACT-03` | Observe edits.                                                                            | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-act-03).                         | Same                                                                      | Data projection parity; owner to be assigned by #68   |
| `MSG-ACT-04` | Observe revocation.                                                                       | `available-in-baileys`; live: none                                               | See [atomic current claims](sdk-capability-evidence.md#msg-act-04).                         | Same                                                                      | Deletion/tombstone owner to be assigned by #68        |
| `MSG-ACT-05` | Delete a message only for this linked account.                                            | `available-in-baileys` (`deleteForMe`/chat modification); live: none             | `available-in-baileys`                                                                      | `conversation.messages.deleteLocal`                                       | Durable command + scoped mirror deletion; deferred    |
| `MSG-ACT-06` | Star or unstar a message.                                                                 | `available-in-baileys` (`star`); live: none                                      | `available-in-baileys`                                                                      | `conversation.messages.star/unstar`                                       | Durable command + mirror; deferred                    |
| `MSG-ACT-07` | Pin or unpin a message.                                                                   | `available-in-baileys` (`pin` content); live: none                               | `available-in-baileys`                                                                      | `conversation.messages.pin/unpin`                                         | Durable command + mirror; deferred                    |
| `MSG-ACT-08` | Reconcile one optimistic send with its authoritative WhatsApp echo.                       | n/a product behavior                                                             | `deferred`                                                                                  | Built into `conversation.send.*` state                                    | Commands + data transaction identities; #22           |
| `MSG-ACT-09` | Observe key-scoped or whole-chat message deletion events.                                 | `available-in-baileys` (`B:events messages.delete`); live: none                  | `available-in-baileys`; current socket does not subscribe and no deletion projection exists | Transparent conversation state                                            | Explicit deletion/tombstone scope; deferred           |

### Status / story messages

| ID          | Caller-facing outcome                                                    | Upstream                                                                                   | whatsappd now                                                                                 | Target Client / React                       | Backend, execution, owner       |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------- |
| `STATUS-01` | Send a text or media WhatsApp status to an explicit audience.            | `available-in-baileys` (`broadcast`, `statusJidList`, background/font options); live: none | `available-in-baileys`; current Session send has no status audience/options                   | `account.statuses.publish`                  | Durable command/media; deferred |
| `STATUS-02` | Observe and page status messages as a distinct expiring product surface. | `available-in-baileys` through status broadcast messages; live: none                       | `available-in-baileys`; the current catch-all is not a distinct status-message implementation | `account.statuses.list/subscribe`; hook TBD | Data/expiry semantics; deferred |

### Presence, calls, and ephemeral interaction

| ID        | Caller-facing outcome                                                        | Upstream                                                                   | whatsappd now                                                      | Target Client / React                                  | Backend, execution, owner                                     |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| `LIVE-01` | Observe typing.                                                              | `available-in-baileys` (`presence.update`); live: none                     | See [atomic current claims](sdk-capability-evidence.md#live-01).   | `conversation.state.presence`; `usePresence`           | Volatile Client state; shipped low-level                      |
| `LIVE-02` | Observe recording.                                                           | `available-in-baileys`; live: none                                         | See [atomic current claims](sdk-capability-evidence.md#live-02).   | Same                                                   | Volatile Client state                                         |
| `LIVE-03` | Observe available, idle, and unavailable.                                    | `available-in-baileys`; live: none                                         | See [atomic current claims](sdk-capability-evidence.md#live-03).   | Same                                                   | Volatile state; only delivered last-seen instants are durable |
| `LIVE-04` | Show or clear this account's typing indicator.                               | `available-in-baileys` (`sendPresenceUpdate composing/paused`); live: none | See [atomic current claims](sdk-capability-evidence.md#live-04).   | `conversation.typing.start/stop`                       | Durable command only if product needs result; #22 owns typing |
| `LIVE-05` | Show or clear recording state.                                               | `available-in-baileys` (`recording/paused`); live: none                    | `available-in-baileys`; current boolean method exposes typing only | `conversation.recording.start/stop`                    | Command/live worker; deferred                                 |
| `LIVE-06` | Subscribe to another address's presence.                                     | `available-in-baileys` (`presenceSubscribe`); live: none                   | `available-in-baileys`                                             | Internal demand management behind opened conversations | Live worker; deferred                                         |
| `CALL-01` | Observe incoming, accepted, ended, rejected, timeout, and offer call events. | `available-in-baileys` (`B:events call`/`Types/Call.d.ts`); live: none     | `available-in-baileys`                                             | `calls.subscribe`; `useCalls`                          | Volatile event, optional accepted source; deferred            |
| `CALL-02` | Reject an incoming call.                                                     | `available-in-baileys` (`rejectCall`); live: none                          | `available-in-baileys`                                             | `calls.reject(callId)`                                 | Durable command with ambiguity semantics; deferred            |
| `CALL-03` | Create an audio or video call link.                                          | `available-in-baileys` (`createCallLink`); live: none                      | `available-in-baileys`                                             | `calls.createLink`                                     | Durable command; deferred                                     |
| `CALL-04` | Place or answer a WhatsApp call through a stable public socket API.          | `unsupported-upstream` in the pinned public high-level socket              | `unsupported-upstream`                                             | No operation                                           | Revisit only after upstream contract exists                   |

### Contacts and address books

| ID           | Caller-facing outcome                                                 | Upstream                                                                                             | whatsappd now                                                                    | Target Client / React                               | Backend, execution, owner                   |
| ------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `CONTACT-01` | Observe synced WhatsApp contact upserts/updates.                      | `available-in-baileys` (`contacts.upsert/update`); live: none                                        | See [atomic current claims](sdk-capability-evidence.md#contact-01).              | `contacts.list/get/subscribe`; `useContacts`        | Data mirror; shipped low-level              |
| `CONTACT-02` | Consolidate PN and LID forms only when WhatsApp delivers equivalence. | `available-in-baileys` through delivered addressing data; live: none                                 | See [atomic current claims](sdk-capability-evidence.md#contact-02).              | Transparent in `contacts` and message sender lookup | Data mirror; shipped                        |
| `CONTACT-03` | Look up whether phone numbers are registered on WhatsApp.             | `available-in-baileys` (`onWhatsApp`); live: none                                                    | `available-in-baileys`                                                           | `contacts.lookupRegistration(numbers)`              | Live trusted worker; deferred               |
| `CONTACT-04` | Save or edit a contact in WhatsApp's synced contact list.             | `available-in-baileys` (`addOrEditContact`); live: none                                              | `available-in-baileys`                                                           | `contacts.save({ address, name })`                  | Durable command; deferred                   |
| `CONTACT-05` | Remove a contact from WhatsApp's synced contact list.                 | `available-in-baileys` (`removeContact`); live: none                                                 | `available-in-baileys`                                                           | `contacts.remove(address)`                          | Durable command; deferred                   |
| `CONTACT-06` | Read a contact's about/status, picture, or disappearing duration.     | `available-in-baileys` (`fetchStatus`, `profilePictureUrl`, `fetchDisappearingDuration`); live: none | See [atomic current claims](sdk-capability-evidence.md#contact-06).              | `contacts.profile(address)`                         | Live worker; deferred                       |
| `CONTACT-07` | Create or update an operating-system contact.                         | `unsupported-upstream`                                                                               | `application-owned`                                                              | No whatsappd Client operation                       | OS permission/API owned by host application |
| `CONTACT-08` | Merge WhatsApp addresses into a CRM/person/address-book identity.     | n/a                                                                                                  | `application-owned`; ADR-0001 forbids inferred persons                           | Host repository, not `client.contacts`              | Application database and policy             |
| `CONTACT-09` | Observe a standalone LID-to-PN mapping update.                        | `available-in-baileys` (`B:events lid-mapping.update`); live: none                                   | `available-in-baileys`; current aliases arise only from contact/message evidence | Transparent contact alias resolution                | Data projection; deferred                   |

### Groups

| ID         | Caller-facing outcome                                                    | Upstream                                                                                | whatsappd now                                                         | Target Client / React                                                      | Backend, execution, owner                                          |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GROUP-01` | Read normalized metadata and observe subject/participant changes.        | `available-in-baileys` (`groups.*`, `group-participants.update`); live: none            | See [atomic current claims](sdk-capability-evidence.md#group-01).     | `groups.get/subscribe`; `useGroup`                                         | Data mirror; exact adapter coverage lives in the atomic claims     |
| `GROUP-02` | List participating groups.                                               | `available-in-baileys` (`groupFetchAllParticipating`); live: none                       | `available-in-baileys`; snapshots list groups already observed        | `groups.list()`                                                            | Data mirror/live refresh; deferred                                 |
| `GROUP-03` | Create a group.                                                          | `available-in-baileys` (`groupCreate`); live: none                                      | `available-in-baileys`                                                | `groups.create`                                                            | Durable command; deferred                                          |
| `GROUP-04` | Leave a group.                                                           | `available-in-baileys` (`groupLeave`); live: none                                       | `available-in-baileys`                                                | `groups.leave`                                                             | Durable command; deferred                                          |
| `GROUP-05` | Update group subject or description.                                     | `available-in-baileys`; live: none                                                      | `available-in-baileys`                                                | `groups.update({ subject, description })`                                  | Durable command; deferred                                          |
| `GROUP-06` | Add, remove, promote, or demote participants.                            | `available-in-baileys` (`groupParticipantsUpdate`); live: none                          | `available-in-baileys` for actions; observe-only normalization exists | `groups.participants.add/remove/promote/demote`                            | Durable commands; deferred                                         |
| `GROUP-07` | List, approve, or reject join requests.                                  | `available-in-baileys` (`groupRequestParticipantsList/Update`); live: none              | `available-in-baileys`                                                | `groups.joinRequests.list/approve/reject`                                  | Durable command/data; deferred                                     |
| `GROUP-08` | Read, revoke, inspect, or accept a group invite.                         | `available-in-baileys` (`groupInviteCode`, revoke/accept/info and v4 forms); live: none | `available-in-baileys`                                                | `groups.invites.*`                                                         | Durable commands; protected invite handling where needed; deferred |
| `GROUP-09` | Configure announcement/edit-lock, member-add, and join-approval modes.   | `available-in-baileys`; live: none                                                      | `available-in-baileys`                                                | `groups.settings.update`                                                   | Durable command; deferred                                          |
| `GROUP-10` | Configure group disappearing messages.                                   | `available-in-baileys` (`groupToggleEphemeral`); live: none                             | `available-in-baileys`                                                | `groups.disappearing.set`                                                  | Durable command; deferred                                          |
| `GROUP-11` | Read every rich upstream metadata field as a stable normalized contract. | `available-in-baileys` (`GroupMetadata.d.ts`); live: none                               | See [atomic current claims](sdk-capability-evidence.md#group-11).     | Extend `groups.get` only per consumer need                                 | Data model; deferred                                               |
| `GROUP-12` | Observe join requests and member-tag events.                             | `available-in-baileys` (`B:events group.join-request`, `group.member-tag`)              | `available-in-baileys`                                                | `groups.joinRequests.subscribe`, `groups.memberTags.subscribe` if selected | Data/events; deferred                                              |
| `GROUP-13` | Assign or update a member label/tag.                                     | `available-in-baileys` (`updateMemberLabel`); live: none                                | `available-in-baileys`                                                | `groups.memberTags.update`                                                 | Durable command; deferred                                          |
| `GROUP-14` | Fetch live normalized metadata for one group.                            | `available-in-baileys` (`groupMetadata`); live: none                                    | See [atomic current claims](sdk-capability-evidence.md#group-14).     | `groups.refresh(groupId)` or an internal refresh behind `groups.get`       | Live trusted worker; release undecided                             |

### Communities and linked groups

| ID        | Caller-facing outcome                                                                                                            | Upstream                                                                          | whatsappd now          | Target Client / React                                       | Backend, execution, owner                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `COMM-01` | Read community metadata.                                                                                                         | `available-in-baileys` (`communityMetadata`); live: none                          | `available-in-baileys` | `communities.get`; `useCommunity`                           | Data model; deferred                               |
| `COMM-02` | Create or leave a community.                                                                                                     | `available-in-baileys` (`communityCreate/Leave`); live: none                      | `available-in-baileys` | `communities.create/leave`                                  | Durable command; deferred                          |
| `COMM-03` | Update community subject or description.                                                                                         | `available-in-baileys`; live: none                                                | `available-in-baileys` | `communities.update`                                        | Durable command; deferred                          |
| `COMM-04` | Link a group to, or unlink it from, a community.                                                                                 | `available-in-baileys` (`communityLinkGroup`, `communityUnlinkGroup`); live: none | `available-in-baileys` | `communities.groups.link/unlink`                            | Durable command; deferred                          |
| `COMM-05` | List linked groups.                                                                                                              | `available-in-baileys` (`communityFetchLinkedGroups`); live: none                 | `available-in-baileys` | `communities.groups.list`                                   | Data/live worker; deferred                         |
| `COMM-06` | Manage participants, join requests, invites, disappearing settings, announcement/edit-lock, member-add, and join-approval modes. | `available-in-baileys` in `B:communities`; live: none                             | `available-in-baileys` | Mirror the typed `groups` subnamespaces under one community | Durable commands/data; owner to be assigned by #68 |
| `COMM-07` | Create a linked group or list participating communities.                                                                         | `available-in-baileys` (`communityCreateGroup`, `communityFetchAllParticipating`) | `available-in-baileys` | `communities.groups.create`, `communities.list`             | Durable command/data; deferred                     |

### Channels / newsletters

| ID        | Caller-facing outcome                                                            | Upstream                                                                             | whatsappd now          | Target Client / React                  | Backend, execution, owner                    |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------- | -------------------------------------------- |
| `CHAN-01` | Read channel metadata and subscriber/admin counts.                               | `available-in-baileys` (`newsletterMetadata/Subscribers/AdminCount`); live: none     | `available-in-baileys` | `channels.get/stats`; `useChannel`     | Data/live worker; deferred                   |
| `CHAN-02` | Create, update, or delete a channel.                                             | `available-in-baileys` (`newsletterCreate/Update/Delete`); live: none                | `available-in-baileys` | `channels.create/update/delete`        | Durable commands; deferred                   |
| `CHAN-03` | Follow or unfollow a channel.                                                    | `available-in-baileys`; live: none                                                   | `available-in-baileys` | `channels.follow/unfollow`             | Durable command; deferred                    |
| `CHAN-04` | Mute or unmute a channel.                                                        | `available-in-baileys`; live: none                                                   | `available-in-baileys` | `channels.mute/unmute`                 | Durable command; deferred                    |
| `CHAN-05` | Update/remove channel name, description, or picture.                             | `available-in-baileys`; live: none                                                   | `available-in-baileys` | `channels.profile.*`                   | Durable command/media input; deferred        |
| `CHAN-06` | Fetch channel messages.                                                          | `available-in-baileys` (`newsletterFetchMessages`); live: none                       | `available-in-baileys` | `channels.messages.page`               | Separate channel data model/paging; deferred |
| `CHAN-07` | React to a channel message.                                                      | `available-in-baileys`; live: none                                                   | `available-in-baileys` | `channels.messages.react`              | Durable command; deferred                    |
| `CHAN-08` | Subscribe to channel updates.                                                    | `available-in-baileys` (`subscribeNewsletterUpdates`, newsletter events); live: none | `available-in-baileys` | `channels.subscribe`; `useChannels`    | Live events/data; deferred                   |
| `CHAN-09` | Change owner or demote an admin.                                                 | `available-in-baileys`; live: none                                                   | `available-in-baileys` | `channels.admin.changeOwner/demote`    | High-risk durable command; deferred          |
| `CHAN-10` | Observe channel reactions, view counts, participant roles, and settings updates. | `available-in-baileys` (`B:events newsletter.*`); live: none                         | `available-in-baileys` | `channels.subscribe` and message state | Data/events; deferred                        |

### WhatsApp Business

| ID       | Caller-facing outcome                                          | Upstream                                                                          | whatsappd now          | Target Client / React                          | Backend, execution, owner             |
| -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------- | ------------------------------------- |
| `BIZ-01` | Read a business profile.                                       | `available-in-baileys` (`getBusinessProfile`); live: none                         | `available-in-baileys` | `business.profile.get`                         | Live worker/data cache; deferred      |
| `BIZ-02` | Update business profile or cover photo.                        | `available-in-baileys` (`updateBussinesProfile`, cover-photo methods); live: none | `available-in-baileys` | `business.profile.update/setCover/removeCover` | Durable command/media input; deferred |
| `BIZ-03` | Page a catalog and list collections.                           | `available-in-baileys` (`getCatalog`, `getCollections`); live: none               | `available-in-baileys` | `business.catalog.page/collections`            | Data/live worker; deferred            |
| `BIZ-04` | Create, update, or delete products.                            | `available-in-baileys`; live: none                                                | `available-in-baileys` | `business.products.create/update/delete`       | Durable command/media; deferred       |
| `BIZ-05` | Read order details.                                            | `available-in-baileys` (`getOrderDetails`); live: none                            | `available-in-baileys` | `business.orders.get`                          | Live worker/data; deferred            |
| `BIZ-06` | Create/update labels and add/remove chat labels.               | `available-in-baileys` (`addLabel`, chat-label methods); live: none               | `available-in-baileys` | `business.labels.*`, `chats.labels.*`          | Durable commands/data; deferred       |
| `BIZ-07` | Add/remove message labels.                                     | `available-in-baileys`; live: none                                                | `available-in-baileys` | `conversation.messages.labels.*`               | Durable command/data; deferred        |
| `BIZ-08` | Add/edit/remove quick replies.                                 | `available-in-baileys`; live: none                                                | `available-in-baileys` | `business.quickReplies.*`                      | Durable command/data; deferred        |
| `BIZ-09` | Observe label definitions and chat/message label associations. | `available-in-baileys` (`B:events labels.edit/association`); live: none           | `available-in-baileys` | `business.labels.subscribe`                    | Data/events; deferred                 |

### Durability, media, commands, and testing

| ID         | Caller-facing outcome                                                                                                         | Upstream                                                                      | whatsappd now                                                                                   | Target Client / React                                                    | Backend, execution, owner                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `DATA-01`  | Persist credentials and signal keys and clear only that account's credentials.                                                | Baileys requires auth state; not an application API                           | See [atomic current claims](sdk-capability-evidence.md#data-01).                                | Internal Runtime composition                                             | Credentials capability; shipped                                          |
| `DATA-02`  | Atomically append accepted normalized source and update the current mirror.                                                   | n/a product architecture                                                      | See [atomic current claims](sdk-capability-evidence.md#data-02).                                | Internal Runtime ingestion                                               | Data capability; shipped                                                 |
| `DATA-03`  | Follow accepted source independently from mirror revisions.                                                                   | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#data-03).                                | Not friendly Client state; advanced backend consumer only                | Data capability; shipped low-level                                       |
| `DATA-04`  | Read a consistent account snapshot and revision.                                                                              | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#data-04).                                | Internal Client hydration                                                | Data capability; shipped low-level                                       |
| `DATA-05`  | Apply only contiguous patches and replace state after a gap.                                                                  | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#data-05).                                | Friendly Client owns it completely                                       | Data + live Runtime; owner to be assigned by #68                         |
| `DATA-06`  | Isolate accounts in shared storage.                                                                                           | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#data-06).                                | Transparent                                                              | Every capability is account-scoped; shipped                              |
| `DATA-07`  | Enforce one database-time account holder with monotonic fencing after release/expiry.                                         | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#data-07).                                | Internal Runtime ownership                                               | Lease capability; shipped                                                |
| `DATA-08`  | Persist all currently normalized message kinds in the Current Mirror.                                                         | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#data-08).                                | Transparent message state                                                | Data/projection owner to be assigned by #68                              |
| `DATA-09`  | Delete/tombstone current chats, messages, groups, or contacts when WhatsApp semantics require it.                             | Upstream emits deletion/update families                                       | See [atomic current claims](sdk-capability-evidence.md#data-09).                                | Transparent domain state                                                 | Per-domain owners to be assigned by #68                                  |
| `DATA-10`  | Expose raw protocol nodes, app-state patches, retry plumbing, signal sessions, prekeys, socket mutexes, or crypto primitives. | `available-in-baileys`                                                        | `intentionally-internal`                                                                        | No Client namespace                                                      | Adapter internals; never promoted by catalogue coverage                  |
| `MEDIA-01` | Capture inbound image/video/audio/document/sticker bytes before publishing accepted state.                                    | Baileys download/reupload is available; live: none                            | See [atomic current claims](sdk-capability-evidence.md#media-01).                               | Transparent message media state                                          | Injected Media Store; replacement gaps are explicit in the atomic claims |
| `MEDIA-02` | Read durable bytes later by opaque account-scoped reference.                                                                  | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#media-02).                               | `client.media.read(ref)` or an authorized application URL                | Media capability; shipped trusted read                                   |
| `MEDIA-03` | Reuse immutable content-addressed media and preserve old bytes after edits.                                                   | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#media-03).                               | Transparent                                                              | Media capability shipped; file-backed edit/restart proof remains open    |
| `MEDIA-04` | Record explicit download/store failure without blocking later messages.                                                       | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#media-04).                               | Message attachment failure state                                         | Data + media; shipped current boundary                                   |
| `MEDIA-05` | Queue pending capture, resume after restart, and sweep crash-created orphans.                                                 | n/a                                                                           | `deferred`                                                                                      | Message attachment lifecycle state                                       | Durable media jobs; #68 will replace or rewrite #39                      |
| `MEDIA-06` | Store attachment bytes inside libSQL.                                                                                         | n/a                                                                           | `application-owned`: whatsappd requires an injected Media Store rather than promising SQL blobs | No operation                                                             | Pair libSQL structured state with file/S3 media                          |
| `MEDIA-07` | Decide browser URL signing, authorization, range responses, caching, and download headers.                                    | n/a                                                                           | `application-owned`                                                                             | React receives application-safe media access, not filesystem refs        | Browser delivery adapter/host policy                                     |
| `MEDIA-08` | Recover an expired upstream media reference before reading bytes.                                                             | `available-in-baileys` (`updateMediaMessage`, media-update event); live: none | See [atomic current claims](sdk-capability-evidence.md#media-08).                               | Transparent media read; failures remain explicit                         | Live worker plus injected media; live proof deferred                     |
| `MEDIA-09` | Derive a voice transcript without replacing or downgrading the retained PTT audio.                                            | n/a application derivation                                                    | `application-owned` (ADR-0015); whatsappd stores the raw source, not a transcript pipeline      | A host may attach a separate artifact or observation                     | Transcription/model policy; failure cannot alter raw audio               |
| `OPS-01`   | Submit an idempotent account-scoped durable side effect and observe its result.                                               | n/a product architecture                                                      | `deferred`; current Session commands are immediate promises                                     | `client.operations.get/subscribe`, typed namespace methods               | Commands capability; #22/#23 and successor issues                        |
| `OPS-02`   | Distinguish queued, claimed, executing, succeeded, failed, and `outcome_unknown`.                                             | n/a                                                                           | `deferred`                                                                                      | `WhatsAppOperation<T>`; `useOperation`                                   | Commands capability; #22 correction                                      |
| `OPS-03`   | Protect pairing challenges from ordinary snapshots and consume them once before expiry.                                       | n/a                                                                           | `deferred`                                                                                      | `account.pair`, protected application route                              | Challenge capability; #23                                                |
| `TEST-01`  | Construct a deterministic text message with correct sender semantics.                                                         | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#test-01).                                | Test-only subpath                                                        | Shipped                                                                  |
| `TEST-02`  | Emit any normalized current session event through an awaited deterministic subscription.                                      | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#test-02).                                | Test-only driver                                                         | Shipped                                                                  |
| `TEST-03`  | Record sends, reads, typing, and history submissions through the Session seam.                                                | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#test-03).                                | Test-only driver                                                         | Shipped                                                                  |
| `TEST-04`  | Construct every inbound message family and drive the friendly Client/operation lifecycle deterministically.                   | n/a                                                                           | See [atomic current claims](sdk-capability-evidence.md#test-04).                                | Extend the testing subpath in the same vertical issue as each capability | No separate proof harness; successor DX/capability issues                |

### Observability

| ID       | Caller-facing outcome                                                                                                            | Upstream         | whatsappd now                                                   | Target Client / React                                                | Backend, execution, owner                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `OBS-01` | Count or time connection transitions, inbound message/update/contact/group/presence, sends, and reconnects without parsing logs. | n/a product seam | See [atomic current claims](sdk-capability-evidence.md#obs-01). | Keep a composition-level metrics hook; do not put telemetry in React | Application-owned metrics sink; shipped                                    |
| `OBS-02` | Prevent a failing metrics sink from disrupting WhatsApp processing.                                                              | n/a              | See [atomic current claims](sdk-capability-evidence.md#obs-02). | Transparent                                                          | Application-owned sink; shipped                                            |
| `OBS-03` | Collect product analytics, traces, alerts, or message-content search.                                                            | n/a              | `application-owned`                                             | No required Client namespace                                         | Host observability/search systems; never ingest private content by default |

## Backend capability matrix

Backend capabilities remain independent (ADR-0004). A structured database does
not become an attachment store merely because both are needed by one product.
`shipped` below records implementation availability, not aggregate proof. Exact
proof remains capability-scoped in the linked atomic evidence ledger.

| Adapter / delivery          | Credentials                  | Accepted + current data  | Leases                     | Commands + challenges      | Media bytes                          | Trusted worker                 | Browser-safe direct use                                            | Status / owner                                        |
| --------------------------- | ---------------------------- | ------------------------ | -------------------------- | -------------------------- | ------------------------------------ | ------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Memory                      | yes                          | yes                      | yes                        | no                         | yes                                  | yes                            | no durability claim                                                | shipped; capability-scoped evidence only              |
| File credential store       | yes                          | no                       | no                         | no                         | no                                   | yes                            | no                                                                 | shipped; legacy migration residual #63                |
| libSQL backend              | yes                          | yes                      | yes                        | no                         | injected only                        | Node/application worker        | no: credentials, leases, and writer access are trusted             | shipped; capability-scoped evidence only              |
| Filesystem media            | no                           | no                       | no                         | no                         | yes                                  | Node/application worker        | no direct path exposure                                            | shipped; capability-scoped evidence only              |
| Postgres structured adapter | target                       | target                   | target using database time | target                     | injected only                        | server/worker                  | no direct credential/writer access                                 | `deferred`; concrete need, issue to be created by #68 |
| S3-compatible media         | no                           | no                       | no                         | no                         | target, including immutable put/read | server/worker or scoped signer | only through application authorization and signed/proxied delivery | `deferred`; issue to be created by #68                |
| PocketBase                  | target                       | target                   | target/worker ownership    | target                     | target/protected files               | worker plus native rules       | application-authorized reads/realtime                              | `deferred`; #26-#29 require DAG repair                |
| Convex                      | target                       | target                   | target/worker ownership    | target                     | target/protected storage             | worker/actions                 | application-authorized queries/subscriptions                       | `deferred`; #33-#37 require DAG repair                |
| Browser-safe delivery       | no live WhatsApp credentials | authorized current state | no lease mutation          | authorized submission only | authorized URL/stream policy         | server owns worker             | yes                                                                | `deferred`; separate delivery/auth lane from React    |

`libsqlBackend({ url, accountId, media })` deliberately injects `media`; local
applications normally pair it with `fileMediaStore`. A Postgres application can
pair structured state with an S3-compatible Media Store. Neither pairing
requires one monolithic backend package.

## React and renderer mapping

`@whatsappd/react` is one package for browser React and OpenTUI React. It may
contain only behavior that is shared across renderers:

| Shared React behavior                         | Candidate surface                                     | Renderer-owned behavior                                         |
| --------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Client lifetime and subscription              | `WhatsAppProvider`, `useWhatsAppClient`, `useAccount` | Process/server composition and Runtime ownership                |
| Chat list and selection state                 | `useChats`, `useChatSelection`                        | List markup, keyboard/mouse interaction, terminal focus         |
| Opened conversation state and actions         | `useConversation`                                     | Transcript rows, bubbles, layout, colors, typography            |
| Stored-page request state                     | `useConversation().loadOlder`                         | Browser/terminal scroller anchoring and viewport measurement    |
| Connection/pairing/operation state            | `useConnection`, `usePairing`, `useOperation`         | Modal/screen/dialog presentation and secret transport route     |
| Reusable behavior-only workflows proven twice | Render-slot Module with state/actions only            | DOM elements, CSS, ARIA wiring, OpenTUI nodes, platform effects |

There is no `@whatsappd/opentui` package in the plan. Create one only after two
OpenTUI consumers demonstrate renderer-specific WhatsApp behavior that cannot
live in the application or the shared React package. OpenTUI proof must earn P1
and any claimed P2 independently. Browser support additionally requires browser-safe delivery,
application authorization, P5 semantic/interaction proof, health checks, and
privacy-safe screenshots.

## Explicit exclusions and audit boundary

The pinned socket also exposes low-level methods such as `query`, `sendNode`,
`sendRawMessage`, `relayMessage`, direct proto generation, app-state resync and
patch application, dirty-bit cleanup, retry requests, placeholder resend,
session/prekey upload and rotation, key stores, mutexes, caches, raw event
buffers, device queries, and telemetry buffers. These are all
`intentionally-internal`. They support adapters; they do not become public SDK
capabilities merely because they are typed upstream.

Bot discovery, account reach-out timelocks, new-chat caps, chat-lock/settings
events, and message-capping events are `deferred`: upstream exposes them, but no
accepted whatsappd product outcome currently requires them. Raw payment and
commerce protocol internals remain `partial-or-unstable` until a specific
caller outcome and live proof define a stable normalized contract.

The following stay `application-owned`: application users and roles, OS address
books, CRM/person identity, business databases unrelated to WhatsApp current
state, voice transcription and its derived artifacts, visual components,
browser routes, URL signing and authorization policy, notifications, analytics,
search indexes, and product-specific scheduling.

## Known implementation gaps exposed by this audit

These are catalogue findings, not implementations in this issue:

1. The low-level Client still requires consumers to reconcile frames and pages;
   the friendly Client in ADR-0023 is the next interface floor.
2. Durable message projection covers text and five media families, while the
   live normalized union also covers location, contact cards, and polls.
3. Receipt and reaction updates are source-only; text edits and revokes do not
   authoritatively update the Current Mirror.
4. Dynamic pairing, unlinking, and chat actions need the durable operation
   capability before a friendly Client can promise restart-safe outcomes.
5. On-demand phone history submission is proven, but phone responses are not;
   on-demand conversation-sync context is mapper-only rather than proven through
   the Runtime, and no UI or scheduler may claim completion.
6. Browser React needs an authorized delivery/auth lane. OpenTUI alone cannot
   prove browser compatibility.
7. Postgres structured state and S3-compatible media are separate concrete
   adapter needs and must enter the repaired execution DAG without merging
   their contracts.
8. Immutable filesystem media survives restart, while the
   [`MEDIA-03` atomic claims](sdk-capability-evidence.md#media-03) keep
   replacement-process edit retention explicitly unproven.

Issue #68 owns translating these gaps and the remaining `deferred` rows into a
dependency-correct execution graph. That planning work may consolidate issue
bodies, but it must not weaken the atomic claims or product boundaries recorded
here.
