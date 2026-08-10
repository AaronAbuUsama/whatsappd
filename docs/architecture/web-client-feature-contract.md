---
status: accepted
---

# Web client feature contract

This is the stable acceptance contract for the working web example and the web
source-registry extraction that follows it. GitHub Issues remain the execution
graph; this document records requirements and proof, never task status or the
next task.

The governing decisions are [ADR-0017](../adr/0017-proof-claims-climb-an-explicit-ladder.md),
[ADR-0033](../adr/0033-headless-react-is-packaged-renderers-are-source-registry-items.md),
and [ADR-0034](../adr/0034-working-examples-precede-the-0-4-extraction.md).

## Product boundary

The deliverable is a working WhatsApp web client under `examples/web`, built
against the public `WhatsAppClient` surface and the vendored shadcn registry
source. It proves the product before reusable behavior is extracted.

- The example owns Next.js transport, local application authorization, routes,
  responsive layout, formatting, and proof configuration.
- `@whatsappd/react` later owns renderer-neutral Provider, hooks, subscription
  lifetime, selectors, and stateful primitives. It renders no DOM or CSS.
- Web components and complete blocks are editable shadcn-compatible registry
  source. The completed example must consume the extracted registry source;
  there must not be a second hand-rolled copy.
- Storybook may use deterministic privacy-safe fixtures to make every state
  reachable. The working client uses the real SDK and never commits data from a
  real account.
- Calls and further Updates/Status work are outside this contract. Their
  placeholders may remain disabled and clearly labelled.
- OpenTUI implementation, docs-site publishing, and npm publishing are outside
  this contract. They follow the working example and registry proof.

## Proof rules

Each feature below has an identifier that issues and tests may cite. A feature
is done only when every listed test is green and its Definition of Done holds.
The proof ladder has its ADR-0017 meaning:

| Rung | Required evidence here                                                            |
| ---- | --------------------------------------------------------------------------------- |
| P0   | Types, formatting, exports, package graph, production build.                      |
| P1   | Deterministic tests through the public SDK or rendered component seam.            |
| P2   | libSQL/file-media restart, rollback, and durability where persistence is claimed. |
| P4   | Bounded linked-account check only when the feature claims live WhatsApp behavior. |
| P5   | Browser assertions, interactions, console/network health, screenshots, and video. |
| P6   | Clean consumer installs the packed packages and registry items and runs them.     |

Screenshot-only evidence is never P5. Tests involving a linked account must
first follow the [real-account testing runbook](../runbooks/development/real-account-testing.md).
No phone number, JID, group id, message id, message body, media byte,
credential, QR, or pairing code may enter logs, commits, screenshots, videos,
or the evidence report.

## Foundation and evidence

### WC-01 — Deterministic state lab

**Concrete tests**

1. Storybook renders desktop and mobile stories for every connection phase,
   chat shape, message kind, media state, receipt state, paging state, and
   operation state named elsewhere in this contract.
2. Story play tests exercise search, selection, transcript actions, paging,
   composer state, and responsive navigation without console exceptions or
   accessibility violations.
3. A repository scan proves that no fixture contains a native WhatsApp id,
   real message text, account media, credential, or pairing material.

**Definition of Done**

The state lab is deterministic, privacy-safe, and sufficient to reproduce
every visual and interaction state without a linked account.

### WC-02 — Browser proof and evidence report

**Concrete tests**

1. Browser tests run the client at fixed desktop, tablet, and mobile viewports;
   each assertion records its feature id.
2. Every run fails on uncaught page errors, unexpected console errors, failed
   application requests, missing media resources, or horizontal overflow.
3. The run writes videos, screenshots, and machine-readable results beneath
   ignored `.artifacts`, then builds one local HTML report linking each WC id to
   its assertions and media.
4. The report opens from disk in Chrome and contains no private account data.

**Definition of Done**

One command regenerates a self-contained local evidence report, and the report
proves behavior rather than merely displaying screenshots.

## SDK semantics exposed by the client

### WC-10 — Contact identity and directory membership

**Concrete tests**

1. A deterministic Baileys/history input containing direct contacts, unsaved
   direct addresses, groups, broadcasts, and system addresses proves that
   `client.contacts.list()` contains only contact records and never group rows.
2. `client.contacts.resolve(id)` can still resolve a known direct address that
   is not a saved directory entry.
3. Display, profile, verified, and username fields survive ingestion and a
   libSQL restart without being collapsed into a numeric fallback.

**Definition of Done**

The SDK has one explicit rule for directory membership, contact resolution is
not weakened, and the UI never guesses that a group is a contact.

### WC-11 — Group identity and membership knowledge

**Concrete tests**

1. A history group whose participant roster was not delivered is represented
   as unknown, not as zero participants.
2. An authoritative empty roster remains distinguishable from an unknown
   roster; a later metadata event hydrates the same group without duplication.
3. The meaning survives memory/libSQL parity and restart tests.

**Definition of Done**

The public model can express unknown, known-empty, and known-nonempty group
membership, and every client count/label preserves that distinction.

### WC-12 — Control envelopes and unsupported content

**Concrete tests**

1. Reaction, edit, revoke, and protocol/control envelopes update their target
   record and do not create transcript rows labelled “unsupported”.
2. A genuinely unknown content envelope remains a durable unsupported record
   with enough safe metadata for a truthful fallback.
3. History and live delivery produce the same public result through restart.

**Definition of Done**

Known WhatsApp control traffic is normalized into its domain effect; only
content the SDK truly cannot represent reaches the unsupported renderer.

### WC-13 — Receipts and operation truth

**Concrete tests**

1. Historical outbound status and live receipt updates map to the public
   pending, server-acknowledged, delivered, read, played, and error states.
2. Group participant receipts produce the correct aggregate without claiming
   every participant read a message when only one did.
3. Durable sends render queued, claimed, executing, succeeded, failed, and
   outcome-unknown states; restart preserves the terminal result.

**Definition of Done**

The UI can derive receipt and operation presentation entirely from public
records, without database inspection or optimistic invention.

### WC-14 — Public media delivery

**Concrete tests**

1. Stored image, video, audio, document, and sticker records reopen through the
   injected `MediaStore` after restart with identical bytes and safe metadata.
2. Missing and failed media states remain distinguishable and do not produce a
   broken browser request loop.
3. The web media route authorizes an opaque per-process token, supports the
   range behavior required by browser audio/video seeking, sends `private,
no-store`, and never exposes a native ref in a URL or log.

**Definition of Done**

Every public media state has a truthful browser result; working media plays or
renders, and unavailable media fails safely and accessibly.

## Client shell and directories

### WC-20 — Responsive application shell

**Concrete tests**

1. Desktop shows navigation, list, and selected detail without overlap.
2. Tablet keeps a usable master/detail layout without clipped rows or composer.
3. Mobile shows one full-width screen at a time; selecting a row opens detail,
   Back returns to the same list position, and no content is hidden behind
   navigation.
4. Pointer hover, keyboard focus, and touch selection all expose the same
   actions with at least 44-pixel touch targets.

**Definition of Done**

The shell has no horizontal overflow or unreachable control at the agreed
viewports, and responsive behavior is structural rather than a shrunken desktop
layout.

### WC-21 — Chat list

**Concrete tests**

1. Chats are ordered by real `lastMessageAt`; search filters by resolved name
   and safe preview text without changing the underlying order.
2. Each row renders the best available avatar, title, last-message preview,
   direction/receipt marker, and relative or absolute time supported by the
   public model.
3. Missing unread, pinned, muted, archived, or draft data is omitted or labelled
   as a capability gap; it is never fabricated.
4. Hover/focus/selected states and truncation are proven with short, long,
   numeric, direct, and group names.

**Definition of Done**

The list is dense, responsive, truthful, keyboard accessible, and selecting a
row always opens the corresponding conversation.

### WC-22 — Avatar pipeline

**Concrete tests**

1. A valid `ContactRecord.imgUrl` renders; absent, null, expired, and failing
   URLs fall back to deterministic initials without a broken image icon.
2. Avatar loading is lazy, de-duplicated, and negatively cached for the browser
   session so scrolling does not repeatedly request known failures.
3. Browser proof records zero unexpected avatar request failures.

**Definition of Done**

Real pictures appear when the public record provides them, fallbacks are stable,
and a missing picture cannot destabilize a list or transcript.

### WC-23 — Contacts directory and details

**Concrete tests**

1. The directory contains only contact entries, sorts names locale-aware, and
   searches every public name field.
2. Selecting a row opens contact details; an explicit Message action opens or
   creates the direct chat instead of treating the directory row as a chat.
3. Details render public names, avatar, about, historical last-seen wording,
   and common groups only when those facts are known.

**Definition of Done**

Contacts and chats are different screens with different selection semantics;
no group or unknown group fact is presented as contact data.

### WC-24 — Groups directory and details

**Concrete tests**

1. The directory contains only group records and sorts/searches their subjects.
2. Unknown membership displays “participants not loaded”; known membership
   displays the exact roster and roles, including a legitimate zero.
3. Selecting a group may request metadata, then updates the same detail view
   when public Client state changes.

**Definition of Done**

The groups screen never equates missing metadata with an empty group and never
reads group data from the contacts directory.

### WC-25 — Settings and disabled capabilities

**Concrete tests**

1. Settings shows only real application/SDK facts and executable controls.
2. Calls and deferred Updates work are disabled and labelled; activating a
   placeholder cannot issue a command or navigation to a fake feature.
3. Theme and responsive preferences survive a reload without storing account
   content.

**Definition of Done**

No placeholder claims an implemented capability, and no decorative control has
a hidden or unsafe side effect.

### WC-26 — Connection and transient presence

**Concrete tests**

1. Every public account phase renders a distinct accessible state, including
   pairing challenge, connecting, authenticated/syncing, online, backoff,
   logged-out, suspended, stale, and closed outcomes exposed by the Client.
2. Composer availability follows the durable-send contract rather than a green
   “online” badge: phases that accept queued work remain usable and terminal
   phases explain why they are disabled.
3. Typing and presence frames update the selected conversation while live,
   expire at their public deadline, and are never reconstructed as current
   state from a saved mirror.

**Definition of Done**

Connection state is truthful, transient presence cannot become durable fiction,
and every disabled or queued action explains the actual Client capability.

## Conversation

### WC-30 — Transcript, anchoring, and saved paging

**Concrete tests**

1. Opening a chat places the viewport at the latest message and permits normal
   scrolling in both directions.
2. Calling `client.messages.older(chatId)` while subscribed prepends the next
   stored page without changing the visible anchor.
3. Stored, loading, exhausted, and error states have separate controls and
   assertions; local exhaustion never claims the phone has no older history.
4. “Ask phone for older messages” is a separate explicit action using the
   oldest loaded anchor and `requestPhoneHistory`, with pending/failure state.
5. A visibility observer batches only visible authoritative incoming refs into
   `markRead`; it neither marks optimistic rows nor repeats an unchanged batch.

**Definition of Done**

Saved paging and phone backfill are visibly distinct, scroll position is stable,
and history can neither lock nor silently replace the transcript.

### WC-31 — Message rendering

**Concrete tests**

1. Table-driven stories and browser assertions render incoming/outgoing and
   direct/group forms of text, image, video, audio, document, sticker,
   location, contacts, poll, revoked, and unsupported records.
2. Quoted references, mentions, sender identity, edited state, timestamps,
   reactions, and receipts render only when present in the public record.
3. Consecutive grouping, date separators, long unbroken text, RTL text, and
   empty/unsupported fallbacks preserve layout and accessible names.

**Definition of Done**

Every `MessageRecord` variant has one truthful renderer and no known variant
falls through to a generic unsupported card.

### WC-32 — Message actions and reactions

**Concrete tests**

1. Hover or keyboard focus on both own and incoming messages reveals a compact
   action trigger adjacent to that message.
2. React/unreact, reply, edit, revoke, copy, and details are enabled only when
   their public command and message direction permit them.
3. Reaction chips aggregate identical emoji, expose participants accessibly,
   and invoke the exact target `MessageRef`.
4. A forged browser action is independently rejected by server-side
   application authorization.

**Definition of Done**

All supported message actions are reachable by pointer and keyboard, target the
selected message exactly, and cannot bypass the application authorization seam.

### WC-33 — Composer and outbound commands

**Concrete tests**

1. Text send handles Enter, Shift+Enter, multiline drafts, empty input, disabled
   connection phases, accepted durable queueing, and surfaced failures.
2. Image, video, audio, document, sticker, location, and contacts invoke the
   corresponding `client.messages.send` method with exact metadata and no
   duplicate submission.
3. Reply, mentions, typing debounce/expiry, idempotency, cancellation, and
   operation feedback are asserted through public Client state.
4. The composer is a messaging composer: no model picker, AI role, tool call,
   generation state, or AI SDK message conversion appears in its API or UI.

**Definition of Done**

Every outbound kind currently supported by `ClientMessageActions` is usable
from the client, produces truthful durable feedback, and remains accessible.

### WC-34 — Voice notes

**Concrete tests**

1. Browser recording produces an accepted voice-note input; the server converts
   it to bounded Ogg Opus mono before `send.audio(..., { ptt: true })`.
2. Stored compatible voice notes play, pause, seek, and report duration; failed
   or unavailable audio renders a usable fallback.
3. Conversion failure, microphone denial, cancellation, and retry do not publish
   a partial operation or leave a visible recording stuck.
4. One bounded live proof sends only to a runbook-allowlisted destination and
   verifies playback on the other proof device without retaining private media.

**Definition of Done**

Users can record, send, and play voice notes from the client; bytes crossing the
SDK boundary meet its documented PTT contract, and failure is recoverable.

### WC-35 — Optimistic reconciliation and uncertain outcomes

**Concrete tests**

1. Queued, claimed, and executing operations render one optimistic row; a
   matching authoritative echo replaces it without duplication.
2. Succeeded-before-echo, failed, acknowledged failure, and outcome-unknown each
   have distinct UI and accessibility text.
3. Failed may offer an explicit retry; outcome-unknown never auto-retries and
   requires confirmation before a new idempotency identity is submitted.
4. Closing and recreating the client preserves durable work and reconstructs the
   same optimistic/terminal presentation.

**Definition of Done**

The transcript never lies about certainty, duplicates an accepted send, or
silently retries an outcome that may already have reached WhatsApp.

## Extraction and clean-consumer proof

### WC-40 — Web registry extraction

**Concrete tests**

1. Extracted individual items and complete blocks install through the
   shadcn-compatible registry into a clean application with declared
   dependencies and no repository-relative imports.
2. `examples/web` deletes its duplicate implementation and consumes those same
   installed sources while retaining every WC-20 through WC-35 browser proof.
3. Theme-token changes restyle installed source without changing WhatsApp state
   or transport code.
4. Registry source contains no Next.js route, account credential, proof
   allowlist, private id, or application-specific authorization rule.

**Definition of Done**

The example and clean consumer run the same editable registry source; reusable
presentation is extracted only after the complete client proves it.

### WC-41 — Headless React extraction

**Concrete tests**

1. Only behavior demonstrated as shared by complete renderers is moved into
   `@whatsappd/react`; hooks use stable snapshots and subscription cleanup.
2. The web example passes the same behavioral suite before and after extraction
   with only its composition imports changed.
3. The packed package exposes no DOM, CSS, shadcn, Next.js, or browser transport
   dependency.

**Definition of Done**

The package owns WhatsApp state/lifecycle behavior required by a renderer and
nothing renderer-specific. Extraction that only anticipates a future renderer
does not satisfy this feature.

### WC-42 — P6 clean consumer

**Concrete tests**

1. A clean temporary project installs packed `whatsappd` and
   `@whatsappd/react`, installs the registry block at the same version, builds,
   and starts without workspace resolution.
2. The consumer exercises deterministic list, conversation, paging, and
   outbound-operation states through public seams.
3. The generated source and package tarballs contain no fixture, private proof
   data, temporary report, or undeclared dependency.

**Definition of Done**

A consumer can reproduce the working client contract from packed packages and
registry source alone.

## Whole-goal Definition of Done

The web-client goal is complete only when:

1. every WC feature in scope has its stated tests and DoD green;
2. `pnpm check`, `pnpm test`, `pnpm check:docs`, and the production web build
   pass from a clean checkout;
3. the evidence report maps every in-scope WC id to results and privacy-safe
   browser media, and opens locally in Chrome;
4. the capability catalogue describes the shipped surface and retains explicit
   gaps instead of promises;
5. the example consumes the extracted registry source and the P6 clean consumer
   passes; and
6. no deferred call, Updates, OpenTUI, docs-site, or publication work was pulled
   into the cut merely to make the client appear complete.
