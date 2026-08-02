# SDK capability catalogue

This generated inventory answers what Baileys exposes, what whatsappd exposes today, and what friendly interface is planned. It is a roadmap and documentation source, not a claim that every row has been exercised against a live account.

Audit versions: whatsappd `0.2.2`; Baileys `7.0.0-rc14`.

## Verification status

- Automated repository checks: **available**
- Live WhatsApp account: **not run**
- Browser React: **not run**
- OpenTUI: **not run**

Automated tests do not establish real-account or rendered behavior.

## Target Client shape

Selected interface: `namespaces-plus-opened-conversation` (ADR-0023).

```ts
const conversation = await client.chats.open(chatId, { signal });
await conversation.send.text("Hello");
await conversation.send.document(bytes, { fileName: "invoice.pdf", mimetype: "application/pdf" });
await conversation.messages.react(messageId, "👍");
await conversation.markRead();
await conversation.loadOlder(); // saved database rows only
await conversation.requestPhoneHistory(); // distinct phone request
conversation.close();
await client.close();
```

### Namespaces

| Namespace | Scope |
| --- | --- |
| `account` | state, identity, pairing, unlink, profile, privacy, blocklist |
| `chats` | list, get, open, archive, mute, pin, clear, delete |
| `contacts` | synced WhatsApp contacts and registration lookup |
| `groups` | metadata, participants, invites, approvals, settings |
| `communities` | communities and linked groups |
| `channels` | WhatsApp channels/newsletters |
| `calls` | call events, reject, and call links |
| `business` | profile, catalog, products, orders, labels, quick replies |
| `operations` | durable side-effect receipts and outcomes |
| `media` | authorized reads of injected durable media |

Opened conversation: `state`, `subscribe`, `loadOlder`, `requestPhoneHistory`, `send`, `messages`, `markRead`, `typing`, `recording`.

### Operation semantics

- Durable side effects accept an optional idempotency key and return an account-scoped operation receipt.
- Receipts distinguish queued, claimed, executing, succeeded, failed, and outcome_unknown.
- An execution that may have reached WhatsApp is never retried under the same operation identity.
- An AbortSignal cancels the caller wait, not an already durable operation.

### Resource ownership

- client.close releases Client subscriptions and opened conversations.
- client.close does not stop an application-owned Runtime or close an application-owned Backend.
- Closing an opened conversation cancels its page reads and subscriptions without deleting messages or leaving the chat.

## Capability inventory

| ID | Area | Caller outcome | Baileys | whatsappd now | Current note | Planned friendly interface | Planning note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ACC-01` | accounts | Observe disconnected, connecting, pairing, authenticated, online, backoff, logged-out, and suspended states. | available: `available-in-baileys` (`B:events connection.update`) | implemented | Current whatsappd implements this capability. | `account.state`, `account.subscribe`; `useAccount`, `useConnection` | Volatile live state plus durable observed instants; no public terminal-state observation recorded |
| `ACC-02` | accounts | Pair by QR and observe expiring challenge state. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `account.pair({ method: "qr" })`; `usePairing` | Commands + protected challenge + trusted worker; #23, 0.3 target |
| `ACC-03` | accounts | Pair by validated phone number and pairing code. | available: `available-in-baileys` (`requestPairingCode`) | implemented | Current whatsappd implements this capability. | `account.pair({ method: "code", phoneNumber })`; `usePairing` | Commands + protected challenge; #23, 0.3 target |
| `ACC-04` | accounts | Unlink WhatsApp while retaining saved chats and other accounts. | available: `available-in-baileys` (`logout`) | not-implemented | `deferred`; credential clear exists but no authorized lifecycle operation | `account.unlink()`; `useUnlink` only if shared workflow emerges | Commands + credentials; trusted worker; #23 |
| `ACC-05` | accounts | Start and stop the application-owned live worker. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `runtime.start/stop`; `client.close` releases Client resources | Credentials + lease + data + media; shipped lower-level |
| `ACC-06` | accounts | Read the connected account identity. | available: `available-in-baileys` (`socket.user`) | implemented | Current whatsappd implements this capability. | `account.identity()` / `useAccount` | Live trusted worker; shipped lower-level |
| `ACC-07` | accounts | Read a profile picture URL. | available: `available-in-baileys` (`profilePictureUrl`) | implemented | Current whatsappd implements this capability. | `account.profile.picture(jid)` | Live trusted worker; release undecided |
| `ACC-08` | accounts | Set or remove a profile picture. | available: `available-in-baileys` (`updateProfilePicture`, `removeProfilePicture`) | not-implemented | `available-in-baileys` | `account.profile.setPicture/removePicture` | Durable command; deferred |
| `ACC-09` | accounts | Read or update profile about/status and display name. | available: `available-in-baileys` (`fetchStatus`, `updateProfileStatus`, `updateProfileName`) | not-implemented | `available-in-baileys` | `account.profile.about/setAbout/setName` | Durable command for writes; deferred |
| `ACC-10` | accounts | Read privacy settings. | available: `available-in-baileys` (`fetchPrivacySettings`) | not-implemented | `available-in-baileys` | `account.privacy.get()` | Live trusted worker; deferred |
| `ACC-11` | accounts | Update last-seen, online, photo, about, receipt, group-add, call, message, link-preview, and default-disappearing privacy. | available: `available-in-baileys` (`B:chat update*Privacy`, `updateDefaultDisappearingMode`) | not-implemented | `available-in-baileys` | `account.privacy.update(patch)` | Durable command; defer atomically until native semantics are proven |
| `ACC-12` | accounts | Read the blocklist. | available: `available-in-baileys` (`fetchBlocklist`, `blocklist.set/update`) | not-implemented | `available-in-baileys` | `account.blocklist.list/subscribe` | Current mirror + command; deferred |
| `ACC-13` | accounts | Block or unblock one WhatsApp address. | available: `available-in-baileys` (`updateBlockStatus`) | not-implemented | `available-in-baileys` | `account.blocklist.block/unblock` | Durable command; deferred |
| `ACC-14` | accounts | Authenticate an application user and decide which WhatsApp accounts they may access. | unsupported: `unsupported-upstream` | application-owned | `application-owned` (ADR-0007) | Not a Client login namespace | Host auth/routes or native backend rules; application-owned |
| `ACC-15` | accounts | Access raw credentials, signal keys, pairing secrets, prekeys, or crypto operations. | available: `available-in-baileys` | internal | `intentionally-internal` | No friendly Client operation | Credential/protected-challenge capabilities only; never consumer data |
| `CHAT-01` | chats | List current chat summaries. | available: `available-in-baileys` (`B:events chats.*`, history sync) | implemented | Current whatsappd implements this capability. | `chats.list()`; `useChats` | Data mirror; owner to be assigned by #68 |
| `CHAT-02` | chats | Read one current chat. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `chats.get(chatId)`; `useChat` | Data mirror; friendly DX |
| `CHAT-03` | chats | Open one synchronized conversation. | not-applicable: n/a product composition | not-implemented | `deferred`; consumers currently combine `watch()` and `messages()` themselves | `chats.open(chatId)`; `useConversation` | Client-owned state per ADR-0023; friendly DX |
| `CHAT-04` | chats | Page older messages already saved in the backend. | not-applicable: n/a storage read | implemented | Current whatsappd implements this capability. | `conversation.loadOlder()`; `useConversation` | Data store; shipped low-level, friendly DX deferred |
| `CHAT-05` | chats | Ask the phone for older messages and receive a submission receipt only. | partial: `partial-or-unstable` (`fetchMessageHistory`); behavior is unresolved (#18/#50) | implemented | Current whatsappd implements this capability. | `conversation.requestPhoneHistory()`; `usePhoneHistoryRequest` if UI needs shared status | Live worker; #50 research, #25 scheduler blocked |
| `CHAT-06` | chats | Automatically and fairly backfill every eligible chat without claiming completeness. | research-required: `research-required` because responses were not observed | not-implemented | `deferred` | `account.history.state/pause/resume`; `useHistoryBackfill` | Durable progress + commands; #25/#50 |
| `CHAT-07` | chats | Observe initial, recent, full, on-demand, and unlabeled conversation-sync batches. | available: `available-in-baileys` (`messaging-history.set/status`) | implemented | Current whatsappd implements this capability. | Internal Client ingestion, not a UI event | Accepted data; no on-demand integration observation recorded |
| `CHAT-08` | chats | Mark real message references read. | available: `available-in-baileys` (`readMessages`) | implemented | Current whatsappd implements this capability. | `conversation.markRead()` | Durable command target #22 |
| `CHAT-09` | chats | Archive or unarchive a chat. | available: `available-in-baileys` (`chatModify archive`) | not-implemented | `available-in-baileys` | `chats.archive/unarchive` | Durable command + mirror; deferred |
| `CHAT-10` | chats | Mute or unmute a chat. | available: `available-in-baileys` (`chatModify mute`) | not-implemented | `available-in-baileys` | `chats.mute/unmute` | Durable command + mirror; deferred |
| `CHAT-11` | chats | Pin or unpin a chat. | available: `available-in-baileys` (`chatModify pin`) | not-implemented | `available-in-baileys` | `chats.pin/unpin` | Durable command + mirror; deferred |
| `CHAT-12` | chats | Clear messages from a chat locally. | available: `available-in-baileys` (`chatModify clear`) | not-implemented | `available-in-baileys` | `chats.clear` | Durable command + scoped mirror deletion; deferred |
| `CHAT-13` | chats | Delete a chat locally. | available: `available-in-baileys` (`chatModify delete`) | not-implemented | `available-in-baileys` | `chats.delete` | Durable command + scoped mirror deletion; deferred |
| `CHAT-14` | chats | Configure per-chat disappearing messages. | available: `available-in-baileys` (`disappearingMessagesInChat`, `groupToggleEphemeral`) | not-implemented | `available-in-baileys` | `conversation.disappearing.set` | Durable command; deferred |
| `CHAT-15` | chats | Treat saved paging as proof that all phone history is loaded. | unsupported: `unsupported-upstream` | unsupported | `unsupported-upstream`: explicitly prohibited by ADR-0010 and #18 | No operation | No backend can infer this from silence |
| `CHAT-16` | chats | Mark a chat unread. | available: `available-in-baileys` (`chatModify markRead:false`) | partial | `available-in-baileys`; current `markRead` only marks real references read | `chats.markUnread(chatId)` | Durable command + mirror; deferred |
| `CHAT-17` | chats | Observe upstream chat upserts, updates, and deletions. | available: `available-in-baileys` (`B:events chats.upsert/update/delete`) | partial | `available-in-baileys`; the current adapter derives chats from messages/history/groups | Transparent `chats` state | Data projection with scoped deletion; deferred |
| `MSG-IN-01` | inbound-messages | Receive text, including extended text. | available: `available-in-baileys` (`B:messages`) | implemented | Current whatsappd implements this capability. | `conversation.state.messages`; `useConversation` | Data mirror; shipped |
| `MSG-IN-02` | inbound-messages | Receive image metadata and downloadable bytes. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same; attachment render slot may expose metadata/actions | Data + injected media; shipped |
| `MSG-IN-03` | inbound-messages | Receive video or GIF metadata and bytes. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same attachment behavior | Data + injected media; capture shipped, no process-replacement byte observation |
| `MSG-IN-04` | inbound-messages | Receive audio or voice-note metadata and bytes. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same attachment behavior | Data + injected media; shipped |
| `MSG-IN-05` | inbound-messages | Receive document metadata and bytes. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same attachment behavior | Data + injected media; capture shipped, no process-replacement byte observation |
| `MSG-IN-06` | inbound-messages | Receive sticker metadata and bytes. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same attachment behavior | Data + injected media; capture shipped, no process-replacement byte observation |
| `MSG-IN-07` | inbound-messages | Receive static location. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.state.messages` | Data projection required; owner to be assigned by #68 |
| `MSG-IN-08` | inbound-messages | Receive one or many contact cards. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same; contact-card render slot only if behavior repeats | Data projection required; owner to be assigned by #68 |
| `MSG-IN-09` | inbound-messages | Receive poll creation. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same; poll module only with shared voting behavior | Data projection required; owner to be assigned by #68 |
| `MSG-IN-10` | inbound-messages | Preserve view-once, ephemeral, and edited wrappers as flags. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Message metadata | Data schema expansion deferred |
| `MSG-IN-11` | inbound-messages | Preserve quotes and mentions. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Message metadata | Data schema expansion deferred |
| `MSG-IN-12` | inbound-messages | Receive live location. | available: `available-in-baileys` (`liveLocationMessage`) | partial | The generic unsupported fallback preserves the raw live-location type, but no normalized live-location contract exists. | `conversation.state.messages` | Modeling and data projection; deferred |
| `MSG-IN-13` | inbound-messages | Receive buttons, list, template, interactive, or native-flow replies/messages. | available: `available-in-baileys` (`B:messages`) | partial | The generic unsupported fallback preserves these raw message types, but no normalized interactive reply/message contracts exist. | Message union after upstream-contract proof | Modeling/data; deferred |
| `MSG-IN-14` | inbound-messages | Receive product, order, payment, or invoice messages. | available: `available-in-baileys` | partial | The generic unsupported fallback preserves these raw message types, but no normalized commerce message contracts exist. | `business` plus conversation message model | Business/data; deferred |
| `MSG-IN-15` | inbound-messages | Receive group or newsletter invite messages. | available: `available-in-baileys` | partial | The generic unsupported fallback preserves these raw invite types, but no normalized invite contracts or actions exist. | Conversation message plus target domain action | Data; deferred |
| `MSG-IN-16` | inbound-messages | Receive events, albums, sticker packs, poll results, or protocol notices. | available: `available-in-baileys` | partial | The generic unsupported fallback preserves these raw message types, but no normalized user-visible family contracts exist. | Model each user-visible family; protocol-only notices stay internal | Data; deferred |
| `MSG-IN-17` | inbound-messages | Never silently drop an unknown addressable message type. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Internal compatibility behavior | Data modeling required before durable acceptance |
| `MSG-OUT-01` | outbound-messages | Send text. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.text(text, options)` | Durable commands #22 |
| `MSG-OUT-02` | outbound-messages | Send image with optional caption. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.image(input, options)` | Durable commands #22; media input is caller-owned |
| `MSG-OUT-03` | outbound-messages | Send video or GIF. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.video(input, options)` | Durable commands #22 |
| `MSG-OUT-04` | outbound-messages | Send audio or voice note. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.audio(input, options)` | Durable commands #22 |
| `MSG-OUT-05` | outbound-messages | Send document with filename and MIME type. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.document(input, options)` | Durable commands #22 |
| `MSG-OUT-06` | outbound-messages | Send sticker. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.sticker(input)` | Durable commands #22 |
| `MSG-OUT-07` | outbound-messages | Send static location. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.location(location)` | Durable commands #22 |
| `MSG-OUT-08` | outbound-messages | Send one or many vCard contacts. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.send.contacts(cards)` | Durable commands #22 |
| `MSG-OUT-09` | outbound-messages | Reply/quote a real message reference. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Every send accepts `{ replyTo }` | Durable commands #22 |
| `MSG-OUT-10` | outbound-messages | Mention selected WhatsApp addresses. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Text/media send option `{ mentions }` | Durable commands #22 |
| `MSG-OUT-11` | outbound-messages | React or remove a reaction. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.messages.react/unreact` | Durable commands #22 |
| `MSG-OUT-12` | outbound-messages | Edit a sent text message. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.messages.edit` | Durable commands + mirror reconciliation #22 |
| `MSG-OUT-13` | outbound-messages | Delete a message for everyone. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | `conversation.messages.revoke` | Durable commands + deletion semantics #22/new issue |
| `MSG-OUT-14` | outbound-messages | Forward a message. | available: `available-in-baileys` (`forward`) | not-implemented | `available-in-baileys` | `conversation.messages.forward(targets)` | Durable command; deferred |
| `MSG-OUT-15` | outbound-messages | Create a poll. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `conversation.send.poll` | Durable command/data; deferred |
| `MSG-OUT-16` | outbound-messages | Send an album. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `conversation.send.album` | Durable command/media; deferred |
| `MSG-OUT-17` | outbound-messages | Send event, group invite, product, button/list reply, phone-number request/share, or PTV. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | Separate typed send operations only when each product outcome is selected | Deferred; business/group domains where applicable |
| `MSG-OUT-18` | outbound-messages | Send as view-once, set disappearing expiration, or limit forwarding/sharing. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | Typed send options after semantics proof | Deferred |
| `MSG-OUT-19` | outbound-messages | Supply or suppress a link preview on text. | available: `available-in-baileys` (`linkPreview`) | partial | `available-in-baileys`; current text outbound has no preview option | `conversation.send.text(text, { linkPreview })` | Durable command; deferred |
| `MSG-ACT-01` | outbound-messages | Observe pending/server-ack/delivery/read/played/error receipts, including group participant. | available: `available-in-baileys` (`messages.update`, `message-receipt.update`) | implemented | Current whatsappd implements this capability. | `conversation.messages` authoritative state and operation result | Data projection/reconciliation; #22/new issue |
| `MSG-ACT-02` | outbound-messages | Observe reactions and removals. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same | Data projection/reconciliation; owner assigned by #68 |
| `MSG-ACT-03` | outbound-messages | Observe edits. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same | Data projection parity; owner to be assigned by #68 |
| `MSG-ACT-04` | outbound-messages | Observe revocation. | available: `available-in-baileys` | internal | Current whatsappd uses this internally but does not expose it as an application capability. | Same | Deletion/tombstone owner to be assigned by #68 |
| `MSG-ACT-05` | outbound-messages | Delete a message only for this linked account. | available: `available-in-baileys` (`deleteForMe`/chat modification) | not-implemented | `available-in-baileys` | `conversation.messages.deleteLocal` | Durable command + scoped mirror deletion; deferred |
| `MSG-ACT-06` | outbound-messages | Star or unstar a message. | available: `available-in-baileys` (`star`) | not-implemented | `available-in-baileys` | `conversation.messages.star/unstar` | Durable command + mirror; deferred |
| `MSG-ACT-07` | outbound-messages | Pin or unpin a message. | available: `available-in-baileys` (`pin` content) | not-implemented | `available-in-baileys` | `conversation.messages.pin/unpin` | Durable command + mirror; deferred |
| `MSG-ACT-08` | outbound-messages | Reconcile one optimistic send with its authoritative WhatsApp echo. | not-applicable: n/a product behavior | not-implemented | `deferred` | Built into `conversation.send.*` state | Commands + data transaction identities; #22 |
| `MSG-ACT-09` | outbound-messages | Observe key-scoped or whole-chat message deletion events. | available: `available-in-baileys` (`B:events messages.delete`) | partial | `available-in-baileys`; current socket does not subscribe and no deletion projection exists | Transparent conversation state | Explicit deletion/tombstone scope; deferred |
| `STATUS-01` | status-messages | Send a text or media WhatsApp status to an explicit audience. | available: `available-in-baileys` (`broadcast`, `statusJidList`, background/font options) | partial | `available-in-baileys`; current Session send has no status audience/options | `account.statuses.publish` | Durable command/media; deferred |
| `STATUS-02` | status-messages | Observe and page status messages as a distinct expiring product surface. | available: `available-in-baileys` through status broadcast messages | partial | `available-in-baileys`; the current catch-all is not a distinct status-message implementation | `account.statuses.list/subscribe`; hook TBD | Data/expiry semantics; deferred |
| `LIVE-01` | presence | Observe typing. | available: `available-in-baileys` (`presence.update`) | implemented | Current whatsappd implements this capability. | `conversation.state.presence`; `usePresence` | Volatile Client state; shipped low-level |
| `LIVE-02` | presence | Observe recording. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same | Volatile Client state |
| `LIVE-03` | presence | Observe available, idle, and unavailable. | available: `available-in-baileys` | implemented | Current whatsappd implements this capability. | Same | Volatile state; only delivered last-seen instants are durable |
| `LIVE-04` | presence | Show or clear this account's typing indicator. | available: `available-in-baileys` (`sendPresenceUpdate composing/paused`) | implemented | Current whatsappd implements this capability. | `conversation.typing.start/stop` | Durable command only if product needs result; #22 owns typing |
| `LIVE-05` | presence | Show or clear recording state. | available: `available-in-baileys` (`recording/paused`) | partial | `available-in-baileys`; current boolean method exposes typing only | `conversation.recording.start/stop` | Command/live worker; deferred |
| `LIVE-06` | presence | Subscribe to another address's presence. | available: `available-in-baileys` (`presenceSubscribe`) | not-implemented | `available-in-baileys` | Internal demand management behind opened conversations | Live worker; deferred |
| `CALL-01` | presence | Observe incoming, accepted, ended, rejected, timeout, and offer call events. | available: `available-in-baileys` (`B:events call`/`Types/Call.d.ts`) | not-implemented | `available-in-baileys` | `calls.subscribe`; `useCalls` | Volatile event, optional accepted source; deferred |
| `CALL-02` | presence | Reject an incoming call. | available: `available-in-baileys` (`rejectCall`) | not-implemented | `available-in-baileys` | `calls.reject(callId)` | Durable command with ambiguity semantics; deferred |
| `CALL-03` | presence | Create an audio or video call link. | available: `available-in-baileys` (`createCallLink`) | not-implemented | `available-in-baileys` | `calls.createLink` | Durable command; deferred |
| `CALL-04` | presence | Place or answer a WhatsApp call through a stable public socket API. | unsupported: `unsupported-upstream` in the pinned public high-level socket | unsupported | `unsupported-upstream` | No operation | Revisit only after upstream contract exists |
| `CONTACT-01` | contacts | Observe synced WhatsApp contact upserts/updates. | available: `available-in-baileys` (`contacts.upsert/update`) | implemented | Current whatsappd implements this capability. | `contacts.list/get/subscribe`; `useContacts` | Data mirror; shipped low-level |
| `CONTACT-02` | contacts | Consolidate PN and LID forms only when WhatsApp delivers equivalence. | available: `available-in-baileys` through delivered addressing data | implemented | Current whatsappd implements this capability. | Transparent in `contacts` and message sender lookup | Data mirror; shipped |
| `CONTACT-03` | contacts | Look up whether phone numbers are registered on WhatsApp. | available: `available-in-baileys` (`onWhatsApp`) | not-implemented | `available-in-baileys` | `contacts.lookupRegistration(numbers)` | Live trusted worker; deferred |
| `CONTACT-04` | contacts | Save or edit a contact in WhatsApp's synced contact list. | available: `available-in-baileys` (`addOrEditContact`) | not-implemented | `available-in-baileys` | `contacts.save({ address, name })` | Durable command; deferred |
| `CONTACT-05` | contacts | Remove a contact from WhatsApp's synced contact list. | available: `available-in-baileys` (`removeContact`) | not-implemented | `available-in-baileys` | `contacts.remove(address)` | Durable command; deferred |
| `CONTACT-06` | contacts | Read a contact's about/status, picture, or disappearing duration. | available: `available-in-baileys` (`fetchStatus`, `profilePictureUrl`, `fetchDisappearingDuration`) | partial | The Session reads a profile-picture URL only; about/status and disappearing duration are absent. | `contacts.profile(address)` | Live worker; deferred |
| `CONTACT-07` | contacts | Create or update an operating-system contact. | unsupported: `unsupported-upstream` | application-owned | `application-owned` | No whatsappd Client operation | OS permission/API owned by host application |
| `CONTACT-08` | contacts | Merge WhatsApp addresses into a CRM/person/address-book identity. | not-applicable: n/a | application-owned | `application-owned`; ADR-0001 forbids inferred persons | Host repository, not `client.contacts` | Application database and policy |
| `CONTACT-09` | contacts | Observe a standalone LID-to-PN mapping update. | available: `available-in-baileys` (`B:events lid-mapping.update`) | partial | `available-in-baileys`; current aliases arise only from contact/message evidence | Transparent contact alias resolution | Data projection; deferred |
| `GROUP-01` | groups | Read normalized metadata and observe subject, add, remove, promote, demote, and modify changes. | available: `available-in-baileys` (`groups.*`, `group-participants.update`) | implemented | Current whatsappd implements this capability. | `groups.get/subscribe`; `useGroup` | Data mirror; exact adapter coverage lives in the atomic claims |
| `GROUP-02` | groups | List participating groups. | available: `available-in-baileys` (`groupFetchAllParticipating`) | not-implemented | `available-in-baileys`; snapshots list groups already observed | `groups.list()` | Data mirror/live refresh; deferred |
| `GROUP-03` | groups | Create a group. | available: `available-in-baileys` (`groupCreate`) | not-implemented | `available-in-baileys` | `groups.create` | Durable command; deferred |
| `GROUP-04` | groups | Leave a group. | available: `available-in-baileys` (`groupLeave`) | not-implemented | `available-in-baileys` | `groups.leave` | Durable command; deferred |
| `GROUP-05` | groups | Update group subject or description. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `groups.update({ subject, description })` | Durable command; deferred |
| `GROUP-06` | groups | Add, remove, promote, or demote participants. | available: `available-in-baileys` (`groupParticipantsUpdate`) | not-implemented | `available-in-baileys` for actions; observe-only normalization exists | `groups.participants.add/remove/promote/demote` | Durable commands; deferred |
| `GROUP-07` | groups | List, approve, or reject join requests. | available: `available-in-baileys` (`groupRequestParticipantsList/Update`) | not-implemented | `available-in-baileys` | `groups.joinRequests.list/approve/reject` | Durable command/data; deferred |
| `GROUP-08` | groups | Read, revoke, inspect, or accept a group invite. | available: `available-in-baileys` (`groupInviteCode`, revoke/accept/info and v4 forms) | not-implemented | `available-in-baileys` | `groups.invites.*` | Durable commands; protected invite handling where needed; deferred |
| `GROUP-09` | groups | Configure announcement/edit-lock, member-add, and join-approval modes. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `groups.settings.update` | Durable command; deferred |
| `GROUP-10` | groups | Configure group disappearing messages. | available: `available-in-baileys` (`groupToggleEphemeral`) | not-implemented | `available-in-baileys` | `groups.disappearing.set` | Durable command; deferred |
| `GROUP-11` | groups | Read every rich upstream metadata field as a stable normalized contract. | available: `available-in-baileys` (`GroupMetadata.d.ts`) | partial | Current normalized metadata contains group id, subject, participants, and participant roles only; richer upstream fields remain deferred. | Extend `groups.get` only per consumer need | Data model; deferred |
| `GROUP-12` | groups | Observe join requests and member-tag events. | available: `available-in-baileys` (`B:events group.join-request`, `group.member-tag`) | not-implemented | `available-in-baileys` | `groups.joinRequests.subscribe`, `groups.memberTags.subscribe` if selected | Data/events; deferred |
| `GROUP-13` | groups | Assign or update a member label/tag. | available: `available-in-baileys` (`updateMemberLabel`) | not-implemented | `available-in-baileys` | `groups.memberTags.update` | Durable command; deferred |
| `GROUP-14` | groups | Fetch live normalized metadata for one group. | available: `available-in-baileys` (`groupMetadata`) | implemented | Current whatsappd implements this capability. | `groups.refresh(groupId)` or an internal refresh behind `groups.get` | Live trusted worker; release undecided |
| `COMM-01` | communities | Read community metadata. | available: `available-in-baileys` (`communityMetadata`) | not-implemented | `available-in-baileys` | `communities.get`; `useCommunity` | Data model; deferred |
| `COMM-02` | communities | Create or leave a community. | available: `available-in-baileys` (`communityCreate/Leave`) | not-implemented | `available-in-baileys` | `communities.create/leave` | Durable command; deferred |
| `COMM-03` | communities | Update community subject or description. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `communities.update` | Durable command; deferred |
| `COMM-04` | communities | Link a group to, or unlink it from, a community. | available: `available-in-baileys` (`communityLinkGroup`, `communityUnlinkGroup`) | not-implemented | `available-in-baileys` | `communities.groups.link/unlink` | Durable command; deferred |
| `COMM-05` | communities | List linked groups. | available: `available-in-baileys` (`communityFetchLinkedGroups`) | not-implemented | `available-in-baileys` | `communities.groups.list` | Data/live worker; deferred |
| `COMM-06` | communities | Manage participants, join requests, invites, disappearing settings, announcement/edit-lock, member-add, and join-approval modes. | available: `available-in-baileys` in `B:communities` | not-implemented | `available-in-baileys` | Mirror the typed `groups` subnamespaces under one community | Durable commands/data; owner to be assigned by #68 |
| `COMM-07` | communities | Create a linked group or list participating communities. | available: `available-in-baileys` (`communityCreateGroup`, `communityFetchAllParticipating`) | not-implemented | `available-in-baileys` | `communities.groups.create`, `communities.list` | Durable command/data; deferred |
| `CHAN-01` | channels | Read channel metadata and subscriber/admin counts. | available: `available-in-baileys` (`newsletterMetadata/Subscribers/AdminCount`) | not-implemented | `available-in-baileys` | `channels.get/stats`; `useChannel` | Data/live worker; deferred |
| `CHAN-02` | channels | Create, update, or delete a channel. | available: `available-in-baileys` (`newsletterCreate/Update/Delete`) | not-implemented | `available-in-baileys` | `channels.create/update/delete` | Durable commands; deferred |
| `CHAN-03` | channels | Follow or unfollow a channel. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `channels.follow/unfollow` | Durable command; deferred |
| `CHAN-04` | channels | Mute or unmute a channel. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `channels.mute/unmute` | Durable command; deferred |
| `CHAN-05` | channels | Update/remove channel name, description, or picture. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `channels.profile.*` | Durable command/media input; deferred |
| `CHAN-06` | channels | Fetch channel messages. | available: `available-in-baileys` (`newsletterFetchMessages`) | not-implemented | `available-in-baileys` | `channels.messages.page` | Separate channel data model/paging; deferred |
| `CHAN-07` | channels | React to a channel message. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `channels.messages.react` | Durable command; deferred |
| `CHAN-08` | channels | Subscribe to channel updates. | available: `available-in-baileys` (`subscribeNewsletterUpdates`, newsletter events) | not-implemented | `available-in-baileys` | `channels.subscribe`; `useChannels` | Live events/data; deferred |
| `CHAN-09` | channels | Change owner or demote an admin. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `channels.admin.changeOwner/demote` | High-risk durable command; deferred |
| `CHAN-10` | channels | Observe channel reactions, view counts, participant roles, and settings updates. | available: `available-in-baileys` (`B:events newsletter.*`) | not-implemented | `available-in-baileys` | `channels.subscribe` and message state | Data/events; deferred |
| `BIZ-01` | business | Read a business profile. | available: `available-in-baileys` (`getBusinessProfile`) | not-implemented | `available-in-baileys` | `business.profile.get` | Live worker/data cache; deferred |
| `BIZ-02` | business | Update business profile or cover photo. | available: `available-in-baileys` (`updateBussinesProfile`, cover-photo methods) | not-implemented | `available-in-baileys` | `business.profile.update/setCover/removeCover` | Durable command/media input; deferred |
| `BIZ-03` | business | Page a catalog and list collections. | available: `available-in-baileys` (`getCatalog`, `getCollections`) | not-implemented | `available-in-baileys` | `business.catalog.page/collections` | Data/live worker; deferred |
| `BIZ-04` | business | Create, update, or delete products. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `business.products.create/update/delete` | Durable command/media; deferred |
| `BIZ-05` | business | Read order details. | available: `available-in-baileys` (`getOrderDetails`) | not-implemented | `available-in-baileys` | `business.orders.get` | Live worker/data; deferred |
| `BIZ-06` | business | Create/update labels and add/remove chat labels. | available: `available-in-baileys` (`addLabel`, chat-label methods) | not-implemented | `available-in-baileys` | `business.labels.*`, `chats.labels.*` | Durable commands/data; deferred |
| `BIZ-07` | business | Add/remove message labels. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `conversation.messages.labels.*` | Durable command/data; deferred |
| `BIZ-08` | business | Add/edit/remove quick replies. | available: `available-in-baileys` | not-implemented | `available-in-baileys` | `business.quickReplies.*` | Durable command/data; deferred |
| `BIZ-09` | business | Observe label definitions and chat/message label associations. | available: `available-in-baileys` (`B:events labels.edit/association`) | not-implemented | `available-in-baileys` | `business.labels.subscribe` | Data/events; deferred |
| `DATA-01` | durability | Persist credentials and signal keys and clear only that account's credentials. | not-applicable: Baileys requires auth state; not an application API | implemented | Current whatsappd implements this capability. | Internal Runtime composition | Credentials capability; shipped |
| `DATA-02` | durability | Atomically append accepted normalized source and update the current mirror. | not-applicable: n/a product architecture | implemented | Current whatsappd implements this capability. | Internal Runtime ingestion | Data capability; shipped |
| `DATA-03` | durability | Follow accepted source independently from mirror revisions. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Not friendly Client state; advanced backend consumer only | Data capability; shipped low-level |
| `DATA-04` | durability | Read a consistent account snapshot and revision. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Internal Client hydration | Data capability; shipped low-level |
| `DATA-05` | durability | Apply only contiguous patches and replace state after a gap. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Friendly Client owns it completely | Data + live Runtime; owner to be assigned by #68 |
| `DATA-06` | durability | Isolate accounts in shared storage. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Transparent | Every capability is account-scoped; shipped |
| `DATA-07` | durability | Enforce one database-time account holder with monotonic fencing after release/expiry. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Internal Runtime ownership | Lease capability; shipped |
| `DATA-08` | durability | Persist all currently normalized message kinds in the Current Mirror. | not-applicable: n/a | partial | Text, image, video, audio, document, and sticker reach the Current Mirror; location, contacts, poll, and unsupported are normalized by the Session but rejected at durable acceptance. | Transparent message state | Projection coverage for location, contacts, poll, and unsupported; owner to be assigned by #68 |
| `DATA-09` | durability | Delete/tombstone current chats, messages, groups, or contacts when WhatsApp semantics require it. | not-applicable: Upstream emits deletion/update families | partial | Current projection deletes only a duplicate contact during PN/LID consolidation; chat, message, and group tombstones are absent. | Transparent domain state | Per-domain owners to be assigned by #68 |
| `DATA-10` | durability | Expose raw protocol nodes, app-state patches, retry plumbing, signal sessions, prekeys, socket mutexes, or crypto primitives. | available: `available-in-baileys` | internal | `intentionally-internal` | No Client namespace | Adapter internals; never promoted by catalogue coverage |
| `MEDIA-01` | durability | Capture inbound image/video/audio/document/sticker bytes before publishing accepted state. | not-applicable: Baileys download/reupload is available | implemented | Current whatsappd implements this capability. | Transparent message media state | Injected Media Store; replacement gaps are explicit in the atomic claims |
| `MEDIA-02` | durability | Read durable bytes later by opaque account-scoped reference. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | `client.media.read(ref)` or an authorized application URL | Media capability; shipped trusted read |
| `MEDIA-03` | durability | Reuse immutable content-addressed media and preserve old bytes after edits. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Transparent | Media capability shipped; no file-backed edit/restart observation recorded |
| `MEDIA-04` | durability | Record explicit download/store failure without blocking later messages. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Message attachment failure state | Data + media; shipped current boundary |
| `MEDIA-05` | durability | Queue pending capture, resume after restart, and sweep crash-created orphans. | not-applicable: n/a | not-implemented | `deferred` | Message attachment lifecycle state | Durable media jobs; #68 will replace or rewrite #39 |
| `MEDIA-06` | durability | Store attachment bytes inside libSQL. | not-applicable: n/a | application-owned | `application-owned`: whatsappd requires an injected Media Store rather than promising SQL blobs | No operation | Pair libSQL structured state with file/S3 media |
| `MEDIA-07` | durability | Decide browser URL signing, authorization, range responses, caching, and download headers. | not-applicable: n/a | application-owned | `application-owned` | React receives application-safe media access, not filesystem refs | Browser delivery adapter/host policy |
| `MEDIA-08` | durability | Recover an expired upstream media reference before reading bytes. | available: `available-in-baileys` (`updateMediaMessage`, media-update event) | implemented | Current whatsappd implements this capability. | Transparent media read; failures remain explicit | Live worker plus injected media; live observation deferred |
| `MEDIA-09` | durability | Derive a voice transcript without replacing or downgrading the retained PTT audio. | not-applicable: n/a application derivation | application-owned | `application-owned` (ADR-0015); whatsappd stores the raw source, not a transcript pipeline | A host may attach a separate artifact or observation | Transcription/model policy; failure cannot alter raw audio |
| `OPS-01` | durability | Submit an idempotent account-scoped durable side effect and observe its result. | not-applicable: n/a product architecture | not-implemented | `deferred`; current Session commands are immediate promises | `client.operations.get/subscribe`, typed namespace methods | Commands capability; #22/#23 and successor issues |
| `OPS-02` | durability | Distinguish queued, claimed, executing, succeeded, failed, and `outcome_unknown`. | not-applicable: n/a | not-implemented | `deferred` | `WhatsAppOperation<T>`; `useOperation` | Commands capability; #22 correction |
| `OPS-03` | durability | Protect pairing challenges from ordinary snapshots and consume them once before expiry. | not-applicable: n/a | not-implemented | `deferred` | `account.pair`, protected application route | Challenge capability; #23 |
| `TEST-01` | durability | Construct a deterministic text message with correct sender semantics. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Test-only subpath | Shipped |
| `TEST-02` | durability | Emit any normalized current session event through an awaited deterministic subscription. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Test-only driver | Shipped |
| `TEST-03` | durability | Record sends, reads, typing, and history submissions through the Session seam. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Test-only driver | Shipped |
| `TEST-04` | durability | Construct every inbound message family and drive the friendly Client/operation lifecycle deterministically. | not-applicable: n/a | partial | The testing subpath constructs text and drives the low-level Session; other message constructors and the friendly Client/operation lifecycle are absent. | Extend the testing subpath in the same vertical issue as each capability | No separate verification harness; successor DX/capability issues |
| `OBS-01` | observability | Count or time connection transitions, inbound message/update/contact/group/presence, sends, and reconnects without parsing logs. | not-applicable: n/a product seam | implemented | Current whatsappd implements this capability. | Keep a composition-level metrics hook; do not put telemetry in React | Application-owned metrics sink; shipped |
| `OBS-02` | observability | Prevent a failing metrics sink from disrupting WhatsApp processing. | not-applicable: n/a | implemented | Current whatsappd implements this capability. | Transparent | Application-owned sink; shipped |
| `OBS-03` | observability | Collect product analytics, traces, alerts, or message-content search. | not-applicable: n/a | application-owned | `application-owned` | No required Client namespace | Host observability/search systems; never ingest private content by default |

## Backend inventory

| adapter | credentials | data | leases | commands | media | trustedWorker | browser | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Memory | yes | yes | yes | no | yes | yes | no durability claim | shipped |
| File credential store | yes | no | no | no | no | yes | no | shipped; legacy migration residual #63 |
| libSQL backend | yes | yes | yes | no | injected only | Node/application worker | no: credentials, leases, and writer access are trusted | shipped |
| Filesystem media | no | no | no | no | yes | Node/application worker | no direct path exposure | shipped |
| Postgres structured adapter | target | target | target using database time | target | injected only | server/worker | no direct credential/writer access | `deferred`; concrete need, issue to be created by #68 |
| S3-compatible media | no | no | no | no | target, including immutable put/read | server/worker or scoped signer | only through application authorization and signed/proxied delivery | `deferred`; issue to be created by #68 |
| PocketBase | target | target | target/worker ownership | target | target/protected files | worker plus native rules | application-authorized reads/realtime | `deferred`; #26-#29 require DAG repair |
| Convex | target | target | target/worker ownership | target | target/protected storage | worker/actions | application-authorized queries/subscriptions | `deferred`; #33-#37 require DAG repair |
| Browser-safe delivery | no live WhatsApp credentials | authorized current state | no lease mutation | authorized submission only | authorized URL/stream policy | server owns worker | yes | `deferred`; separate delivery/auth lane from React |

## Shared React behavior

| Behavior | Shared binding | Renderer-owned work |
| --- | --- | --- |
| Client lifetime and subscription | `WhatsAppProvider`, `useWhatsAppClient`, `useAccount` | Process/server composition and Runtime ownership |
| Chat list and selection state | `useChats`, `useChatSelection` | List markup, keyboard/mouse interaction, terminal focus |
| Opened conversation state and actions | `useConversation` | Transcript rows, bubbles, layout, colors, typography |
| Stored-page request state | `useConversation().loadOlder` | Browser/terminal scroller anchoring and viewport measurement |
| Connection/pairing/operation state | `useConnection`, `usePairing`, `useOperation` | Modal/screen/dialog presentation and secret transport route |
| Reusable behavior-only workflows proven twice | Render-slot Module with state/actions only | DOM elements, CSS, ARIA wiring, OpenTUI nodes, platform effects |

## Current public exports

- `AcceptedWhatsAppBatch`
- `AccountAlreadyClaimedError`
- `AccountLease`
- `AccountLeaseStore`
- `AccountNotHeldError`
- `AccountRecord`
- `AuthStrategy`
- `Awaitable`
- `BinaryInput`
- `ChatRecord`
- `ContactRecord`
- `ContactUpdate`
- `ConversationSyncBatch`
- `ConversationSyncContext`
- `ConversationSyncSource`
- `CredentialStore`
- `Disposition`
- `DurableInboundMessage`
- `DurableMedia`
- `DurableUpdate`
- `FaultReason`
- `FileMediaStoreOptions`
- `GroupMetadata`
- `GroupParticipant`
- `GroupParticipantAction`
- `GroupRecord`
- `GroupUpdate`
- `HistoryChat`
- `HistoryContact`
- `InboundMessage`
- `LibsqlBackend`
- `LibsqlBackendOptions`
- `MediaHandle`
- `MediaMeta`
- `MediaStore`
- `MessageContext`
- `MessageFlags`
- `MessageHandlerContext`
- `MessageRecord`
- `MessageRef`
- `MetricEvent`
- `MetricsHook`
- `MirrorRecord`
- `ObservedInstant`
- `Outbound`
- `PairingError`
- `PairingState`
- `PresenceKind`
- `PresenceUpdate`
- `ReceiptStatus`
- `RecordedSessionCommands`
- `RuntimeSession`
- `SendOptions`
- `SessionConfig`
- `StaleAccountClaimError`
- `Status`
- `StoredMessageCursor`
- `StoredMessagePage`
- `StoredMessagePageOptions`
- `SyncState`
- `TestWhatsAppEvent`
- `TestWhatsAppSessionDriver`
- `TextMessageInput`
- `Unsubscribe`
- `UnsupportedDurableEventError`
- `Update`
- `WaIdentity`
- `WhatsAppAddress`
- `WhatsAppBackend`
- `WhatsAppClient`
- `WhatsAppClientConnectionState`
- `WhatsAppClientFrame`
- `WhatsAppDataEvent`
- `WhatsAppDataStore`
- `WhatsAppDurableEvent`
- `WhatsAppFault`
- `WhatsAppPatch`
- `WhatsAppRuntime`
- `WhatsAppRuntimeConfig`
- `WhatsAppSession`
- `WhatsAppSessionHandlers`
- `WhatsAppSnapshot`
- `assertE164`
- `classifyDisconnect`
- `createInProcessWhatsAppClient`
- `createSession`
- `createTestWhatsAppSession`
- `createWhatsAppRuntime`
- `dispositionFor`
- `fileMediaStore`
- `fileStore`
- `isOnline`
- `isRetryable`
- `isTerminal`
- `libsqlBackend`
- `memoryBackend`
- `memoryDataStore`
- `memoryLeaseStore`
- `memoryMediaStore`
- `memoryStore`
- `pairingAuth`
- `qrAuth`
- `refOf`
- `textMessage`
