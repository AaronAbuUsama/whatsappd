# WhatsApp history semantics — what a linked device can honestly promise

Status: proven on the live proof account, issue #18. Protocol-level facts are
cited against Baileys 7.0.0-rc14 sources; behavioral claims come from the
recorded proof matrix (`.proof-receipts/issue18-p4.json`).

## What initial sync delivers (the linked-device cap)

Pairing a linked device does **not** deliver full account history. Measured on
the proof account (issue #9, fresh QR pairing): WhatsApp delivers roughly the
last three months densely (7,065 of 7,665 messages in the prior three months)
plus sparse fragments reaching further back. A consumer watching thousands of
messages arrive at pairing has no protocol signal that this is everything —
because it is not.

whatsappd deliberately pairs light and requests full history only on a
registered reconnect (`shouldRequestFullHistoryOnOpen`, `src/baileys/socket.ts`).
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
Resolution proves the request was accepted by the server for relay. It does
**not** prove the phone received it, will answer it, or that any older
messages exist.

### How returned history arrives

If the phone answers, messages arrive later as ordinary `conversationSync`
batches with `context.source === "on_demand"` and
`context.requestSessionId` set. Delivered messages carry `live: false` and
flow through the same subscription pipeline as every other non-live message.

### Correlation

`context.requestSessionId` on an on-demand batch is the only correlation
signal. It carries the phone's `peerDataRequestSessionId` from the history
notification; whether that echoes the submission `requestId` is the intended
protocol design but — because no response has ever been observed live (see
below) — remains an unverified assumption, not a proven contract.

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

## The observed reality (P4, live linked phone, 2026-07-30)

The central live finding: **the phone acknowledges receipt of every on-demand
request and answers none of them.** The full chain was observed on a real
account (primary: iPhone) with Baileys 7.0.0-rc14, the newest release at the
time (published 2026-07-29):

| Step           | Signal                                                 | Observed                       |
| -------------- | ------------------------------------------------------ | ------------------------------ |
| Submission     | `requestHistory` resolves with the request message id  | ✅ every attempt               |
| Server relay   | ack for the outgoing peer message                      | ✅ every attempt               |
| Phone delivery | `peer_msg` receipt from the phone's own JID, ~2s later | ✅ every attempt               |
| Response       | `HISTORY_SYNC_NOTIFICATION` → `on_demand` batch        | ❌ **never** (0 of 4 requests) |

Conditions varied without effect: phone idle vs. WhatsApp foregrounded during
an active conversation, personal DM vs. self-chat, `count` 50 vs. 10, anchors
minutes old. This matches the unresolved upstream report
[WhiskeySockets/Baileys#2452](https://github.com/WhiskeySockets/Baileys/issues/2452)
(request succeeds, no response; closed stale). The `fetchMessageHistory` code
path in Baileys master was last touched 2026-05; no fix exists to adopt. iOS
primaries are the platform most frequently reported as silent.

Because the failing decision runs inside the closed-source phone app after
confirmed delivery, no client-side change is known to unblock it. Candidate
follow-up spikes (own research node, not this proof): the companion's
registered device-props/capabilities, the untried `FULL_HISTORY_SYNC_ON_DEMAND`
request type, and a request-metadata diff against an official client.

### Proof matrix

| Scenario                          | Observed                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request/result correlation        | Receipt id is real (outgoing request message id); zero responses arrived, so id-echo in `peerDataRequestSessionId` remains **unverified live** — it is the documented correlation design, not a proven behavior |
| Protocol request limit (count=50) | Submission accepts 50 and 10 alike; no response either way — no delivered-count evidence exists                                                                                                                 |
| Boundary inclusivity              | Unobservable without a response; explicitly unproven                                                                                                                                                            |
| Empty result                      | Indistinguishable from an unanswered request — this is the strongest argument for never claiming exhaustion                                                                                                     |
| Multiple chunks                   | Unobservable without a response                                                                                                                                                                                 |
| Repeated requests                 | Re-submission is accepted and re-delivered (fresh receipt each time); no response to any                                                                                                                        |
| Phone offline                     | Submission still succeeds; the `peer_msg` delivery ack is the only signal distinguishing delivered from undelivered                                                                                             |

Sanitized observations (hashed identities, counts, digests) are committed as
`.proof-receipts/issue18-p4.json` / `issue18-p2.json`; the raw observation
stores stay private.
