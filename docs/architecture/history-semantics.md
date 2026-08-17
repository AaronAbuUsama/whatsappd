# WhatsApp history semantics — what a linked device can honestly promise

Status: proven on the live account in issue #18 and reviewed in PR #51.
Protocol-level facts are cited against Baileys 7.0.0-rc14 sources. This file is
the single prose home for the live observations. Historical run artifacts
remain available in issue/PR discussion and git history; they are not current
source artifacts. The issue #9 initial-sync measurement predates the receipt
discipline and is labelled indicative where it appears.

## What initial sync delivers (the linked-device cap)

Pairing a linked device does **not** deliver full account history. An
informal one-off measurement on the proof account (issue #9, fresh QR
pairing, before this proof's receipt discipline existed — indicative only,
no retained receipt): WhatsApp delivered roughly the last three months
densely (7,065 of 7,665 messages in the prior three months) plus sparse
fragments reaching further back. A consumer watching thousands of messages
arrive at pairing has no protocol signal that this is everything — because
it is not.

The request for a full history sync can be made **once, at Pairing, and never
again**. It rides in `companion.requireFullSync` on the registration node
(Baileys `validate-connection.js`), and Baileys sends that node only while
`creds.me` is absent (`socket.js`); every later connect is a login node, which
has no such field. `syncFullHistory` also decides a second thing on every
connect — `webInfo.webSubPlatform` upgrades from `WEB_BROWSER` to `DARWIN` only
when it is true _and_ the browser is `["Mac OS"|"Windows", "Desktop", …]`, and
**WhatsApp refuses a registration node carrying `DARWIN`**. Measured on
2026-08-17: with `macOS("Desktop")` the socket never reached a QR at all
(`connection_lost`, reconnect, repeat); with a non-`Desktop` browser it paired in
about a second and delivered a full sync. `"Desktop"` was therefore only ever
survivable while full history was switched off, and whatsappd now announces
`Browsers.macOS("Chrome")` — Baileys' own default.

Until 2026-08-16 whatsappd gated this on `creds.registered`, a field upstream
writes only in the pairing-code companion-finish handler. At the Pairing connect
that field is always absent, so the request was never sent, by either method,
and the companion announced a macOS Desktop identity in three fields while
asking like a browser in the two that gate history (#203). It is now on by
default, and `syncFullHistory: false` on the session config is how a caller
declines — a permanent choice for that credential.

**Every history depth recorded in this document was measured with the request
off.** That includes the issue #9 figures above and both P4 runs below.

A returning device whose `accountSyncCounter` proves initial sync already
completed receives no history redelivery at all — only messages queued while
it was offline (ADR-0002: connection readiness is separate from history
bootstrap).

## The three read paths (ADR-0010 — never collapse them)

| Path                       | What it is                                     | Contacts WhatsApp?                     |
| -------------------------- | ---------------------------------------------- | -------------------------------------- |
| Initial/reconnect sync     | Connection-driven protocol delivery            | Implicitly, on connect                 |
| `messages()` stored paging | Deterministic reads of the durable mirror      | Never                                  |
| `requestHistory()`         | Explicit, per-chat request to the linked phone | Yes — submission of a protocol request |

## `session.requestHistory(anchor, opts?)`

Submits an on-demand history request for one chat, anchored at the oldest
known message (`ref` + timestamp in epoch **milliseconds**; the protocol field
is `oldestMsgTimestampMs`). `count` defaults to 50, the conventional protocol
request size — it is a request parameter, not a database-page guarantee and
not evidence that more messages exist.

### What the receipt means

`requestHistory` resolves with `{ requestId }`, where `requestId` is the id of
the **outgoing request message** (a `PeerDataOperationRequestMessage` relayed
to your own account; Baileys `messages-recv.js` `fetchMessageHistory`).
Resolution proves only that the request stanza was handed to the transport —
it does not await server acceptance (the relay ack arrives separately, as
observed in the matrix below), and it does **not** prove the phone received
it, will answer it, or that any older messages exist.

### How returned history arrives

If the phone answers, messages arrive later as ordinary `conversationSync`
batches with `context.source === "on_demand"` and
`context.requestSessionId` set. Delivered messages carry `live: false` and
flow through the same subscription pipeline as every other non-live message.

### Correlation

`context.requestSessionId` on an on-demand batch is the only correlation
signal. It carries the phone's `peerDataRequestSessionId` from the history
notification, and **it echoes the submission `requestId`** — verified live on
2026-08-17 across two runs and twelve answered batches, every one naming a
request this library had submitted. Empty answers carry it too, which is what
makes them readable as answers rather than noise.

It is therefore the correlation contract it was designed to be: it says which
request a batch answers. It still says nothing about whether more history
exists.

## What is NOT promised (explicitly unsupported claims)

- **No completion signal.** Nothing marks a request "fully answered". A batch
  may arrive seconds later, much later, or never (phone offline, phone declines).
- **No exhaustion signal.** For on-demand syncs Baileys forces
  `isLatest: undefined` (`process-message.js`, ON_DEMAND branch), so the one
  candidate exhaustion flag is structurally absent. An empty result cannot
  distinguish "no older messages exist" from "the phone did not answer".
- **No delivered-count contract.** The number of returned messages relates to
  `count` only loosely; chunking is the phone's choice.

UI language may therefore say "no older saved messages" and "request sent";
it may not say "all history loaded", "no more WhatsApp messages", or report a
delivered count tied to the request (ADR-0010 consequence).

## Paging to exhaustion (2026-08-17)

Run on the `android` proof profile — an established link, resumed without a
scan, whose Pairing predates #204 and so took the short sync. Each request
anchored on the oldest message the previous answer returned, so no window was
requested twice.

| Request | Anchor age | Answer                    |
| ------- | ---------- | ------------------------- |
| 1       | 24 days    | 50 messages, reaching 27d |
| 2       | 27 days    | 49 messages, reaching 30d |
| 3       | 30 days    | 48 messages, reaching 36d |
| 4       | 36 days    | 19 messages, reaching 37d |
| 5       | 37 days    | **empty — nothing older** |
| 6       | 37 days    | **empty — nothing older** |

Six of six answered, none silent, 166 messages in 15 seconds. Full pages while
history remained, one short page at the tail, then an explicit nothing. That is
what paging to exhaustion looks like, and it is legible only because #207
stopped discarding the empty reply.

An earlier run the same day reused a single anchor for all six requests, so its
four empty answers meant "you already have that" and proved nothing about
exhaustion. Recorded because the distinction is the point: an empty answer is
informative only for a window that was not already served.

Neither run says the account holds nothing older than 37 days. It says the
phone offered nothing older for that anchor.

## The observed reality (P4, live linked phone, 2026-07-30)

The central live finding: **the phone acknowledges receipt of every on-demand
request, and no answer was ever observed.** The full chain was observed on a
real account (primary: iPhone) with Baileys 7.0.0-rc14, the newest release at
the time (published 2026-07-29):

| Step           | Signal                                                 | Receipted evidence                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission     | `requestHistory` resolves with the request message id  | ✅ all 7 attempts — both receipts carry every request (incl. run 1's offline submission)                                                                                                                                                                                                                                                            |
| Phone delivery | `peer_msg` receipt from the phone's own JID, ~2s later | ✅ **receipted for run 2's 2 requests** (`deliveryAcksAt`, from the run's own transport log). Run 1 predates ack embedding: its receipt substantiates only the offline row's 4m16s-late ack (operator notes); the remaining run-1 delivery and server-relay acks were observed in that run's transport trace and are quoted, unreceipted, on PR #51 |
| Response       | `HISTORY_SYNC_NOTIFICATION` → `on_demand` batch        | ❌ **none observed** — 0 of 7 (0/5 run1-b06fa2f, 0/2 run2-ea53648)                                                                                                                                                                                                                                                                                  |

One seam caveat sharpens, rather than weakens, the verdict: at the time of this
run whatsappd's normalization (`toMessagingHistoryEvents`,
`packages/whatsappd/src/baileys/socket.ts`) emitted no batch for a history
payload whose normalized chats, contacts, and messages were all empty — so an
entirely-empty response was indistinguishable from silence at this seam. "0 of
7" is therefore a claim about _observable_ batches.

That seam is now open (#207): a payload carrying `requestSessionId`, or typed
`ON_DEMAND`, emits a batch whether or not it has rows. Every run recorded in
this document predates that change, so none of them could have seen an empty
answer, and each "no response" reading includes "answered with nothing" as an
unexcluded possibility. Whether WhatsApp ever sends one remains unobserved —
the change makes it reachable, not proven.

Conditions varied without effect: phone idle vs. WhatsApp foregrounded during
an active conversation, personal DM vs. self-chat, `count` 50/25/10, anchors
minutes old. This matches the unresolved upstream report
[WhiskeySockets/Baileys#2452](https://github.com/WhiskeySockets/Baileys/issues/2452)
(request succeeds, no response; closed stale). The `fetchMessageHistory` code
path in Baileys master was last touched 2026-05; no fix exists to adopt.

The #2452 thread splits by primary-phone platform: one reporter reproduces
the silence cleanly on rc-13, while another reports it **working on rc-13
with an Android primary** — including third-party confirmation that
`peerDataRequestSessionId` in the response equals the id returned by
`fetchMessageHistory`, and that responses arrive chunked. That report also
notes official WhatsApp Web itself caps deep history ("check your phone to
see older messages"), so even a working on-demand path does not promise
unbounded backfill. The iOS-vs-Android split is the leading hypothesis for
the observed silence (tracked with an experiment matrix in issue #50).

Because the failing decision runs inside the closed-source phone app after
confirmed delivery, no client-side change is known to unblock it. Candidate
follow-up spikes (own research node, not this proof): the companion's
registered device-props/capabilities, the untried `FULL_HISTORY_SYNC_ON_DEMAND`
request type, and a request-metadata diff against an official client.

### Proof matrix

| Scenario                          | Observed                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request/result correlation        | Receipt id is real (outgoing request message id); zero responses arrived in this run, so id-echo was unverifiable here. **Verified live 2026-08-17**: twelve answered batches across two runs, every `peerDataRequestSessionId` matching a submitted `requestId`                                                                                                                  |
| Protocol request limit (count=50) | Submission accepts 50 and 10 alike; no response either way — no delivered-count evidence exists                                                                                                                                                                                                                                                                                   |
| Boundary inclusivity              | Unobservable without a response; explicitly unproven                                                                                                                                                                                                                                                                                                                              |
| Empty result                      | Indistinguishable from an unanswered request **at the time of this run**, because the seam dropped it. Delivered since #207, and observed live 2026-08-17 as an explicit "nothing older" answer                                                                                                                                                                                   |
| Multiple chunks                   | Unobservable without a response                                                                                                                                                                                                                                                                                                                                                   |
| Repeated requests                 | Re-submission is accepted and re-delivered (fresh receipt each time); no response to any                                                                                                                                                                                                                                                                                          |
| Phone offline                     | Directly observed (airplane mode + Wi-Fi off): submission resolves identically to the online case with no delivery ack; the queued request's `peer_msg` ack arrived 4m16s later when the phone reconnected (22:06:57 → 22:11:13Z). The submission receipt therefore proves nothing about the phone; only the delivery ack does — and even confirmed delivery produced no response |

Sanitized observations (opaque identity aliases, counts, and digests) were
reviewed with issue #18 and PR #51; raw observation stores remain private. The
database-oracle cross-check covered the store digest, counts, ordered ids, and
per-request correlation. **No P2 rung is claimed**: the observation store was a
disposable capture tool, and product durability had no store to prove until
issue #20 (see PR #51, "P2 disposition").

Scenario provenance: the phone-offline row, count variation (50/25/10), and
the DM/self-chat spread are run 1 (`run1-b06fa2f`); the embedded per-request
delivery acks and the repeated-request-on-one-anchor row are run 2
(`run2-ea53648`). Run 1 predates the ack-embedding receipt writer, so its
delivery evidence is the operator-note timeline in the historical receipt plus
the transport-log excerpt on PR #51. Historical receipts remain in git history;
current and future runs salt identities per run at capture time.
