# WhatsApp history semantics — what a linked device can honestly promise

Status: proven on the live proof account, issue #18. Protocol-level facts are
cited against Baileys 7.0.0-rc14 sources. This file is the single prose home
for the live observations; every quantitative claim below names its backing
receipt — `.proof-receipts/issue18-p4.run1-b06fa2f.json` (the 5-request
matrix) or `.proof-receipts/issue18-p4.run2-ea53648.json` (the post-review
confirmation run). Receipts are per-run and append-only; a receipt is
evidence only for the git head it names (ADR-0017).

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

| Step           | Signal                                                 | Observed                                                                       |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Submission     | `requestHistory` resolves with the request message id  | ✅ all 7 attempts across both runs (incl. with the phone fully offline, run 1) |
| Server relay   | ack for the outgoing peer message                      | ✅ all 7 attempts                                                              |
| Phone delivery | `peer_msg` receipt from the phone's own JID, ~2s later | ✅ every online attempt; run 2 embeds them per request (`deliveryAcksAt`)      |
| Response       | `HISTORY_SYNC_NOTIFICATION` → `on_demand` batch        | ❌ **never** — 0 of 7 (0/5 run1-b06fa2f, 0/2 run2-ea53648)                     |

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
| Request/result correlation        | Receipt id is real (outgoing request message id); zero responses arrived, so id-echo in `peerDataRequestSessionId` remains **unverified live** — it is the documented correlation design, not a proven behavior                                                                                                                                                                   |
| Protocol request limit (count=50) | Submission accepts 50 and 10 alike; no response either way — no delivered-count evidence exists                                                                                                                                                                                                                                                                                   |
| Boundary inclusivity              | Unobservable without a response; explicitly unproven                                                                                                                                                                                                                                                                                                                              |
| Empty result                      | Indistinguishable from an unanswered request — this is the strongest argument for never claiming exhaustion                                                                                                                                                                                                                                                                       |
| Multiple chunks                   | Unobservable without a response                                                                                                                                                                                                                                                                                                                                                   |
| Repeated requests                 | Re-submission is accepted and re-delivered (fresh receipt each time); no response to any                                                                                                                                                                                                                                                                                          |
| Phone offline                     | Directly observed (airplane mode + Wi-Fi off): submission resolves identically to the online case with no delivery ack; the queued request's `peer_msg` ack arrived 4m16s later when the phone reconnected (22:06:57 → 22:11:13Z). The submission receipt therefore proves nothing about the phone; only the delivery ack does — and even confirmed delivery produced no response |

Sanitized observations (hashed identities, counts, digests) are committed as
the per-run receipts named above; the raw observation stores stay private.
The database-oracle cross-check (store SHA-256, counts, ordered-id digest,
close/reopen integrity, per-request correlation counts) is embedded in each
P4 receipt as supporting evidence per ADR-0017. **No P2 rung is claimed**:
the observation store is a disposable capture tool, and product durability
has no store to prove until issue #20 (see PR #51, "P2 disposition").

Scenario provenance: the phone-offline row, count variation (50/25/10), and
the DM/self-chat spread are run 1 (`run1-b06fa2f`); the embedded per-request
delivery acks and the repeated-request-on-one-anchor row are run 2
(`run2-ea53648`). Run 1 predates the ack-embedding receipt writer, so its
delivery evidence is the operator-note timeline in the receipt plus the
transport-log excerpt on PR #51; run 1's committed file is byte-identical to
the historical receipt at commit `f9a77cc` except that operator notes passed
through the writer's redaction (verifiable:
`git show f9a77cc:.proof-receipts/issue18-p4.json`).
