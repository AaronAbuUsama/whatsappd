# WhatsApp history semantics — what a linked device can honestly promise

Status: proven on the live account in issue #18 and reviewed in PR #51, then
amended on 2026-08-16 (issue #199) after a second live run on the same profile
answered requests the P4 run recorded as unanswered. Both runs are kept below;
neither is deleted, and the conclusions the first one carried are now marked
conditional.
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

whatsappd deliberately pairs light and requests full history only once pairing
has completed (`shouldRequestFullHistoryOnOpen`, `packages/whatsappd/src/baileys/socket.ts`).
The two pairing methods prove completion with different fields — pairing-code
by `creds.registered`, QR by `creds.me` — because upstream writes `registered`
only in the pairing-code companion-finish handler. Until 2026-08-16 both were
gated on `registered`, so **every QR-paired account silently received the short
sync instead** (#203). Any history depth measured before that fix was measured
with `syncFullHistory` off, whatever the run intended.

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
notification; whether that echoes the submission `requestId` is the intended
protocol design, and a third-party report on an Android primary says it does
(Baileys#2452, below). whatsappd has still not receipted the echo itself: the
P4 runs had no response to correlate, and the 2026-08-16 run that received
nine on-demand batches did not record the field. It remains an unverified
assumption here — now for want of a measurement rather than for want of a
response.

## What is NOT promised (explicitly unsupported claims)

- **No completion signal.** Nothing marks a request "fully answered". A batch
  may arrive seconds later, much later, or never (phone offline, phone declines).
- **No exhaustion signal.** For on-demand syncs Baileys forces
  `isLatest: undefined` (`process-message.js`, ON_DEMAND branch), so the one
  candidate exhaustion flag is structurally absent. An empty result cannot
  distinguish "no older messages exist" from "the phone did not answer". The
  2026-08-16 run walked into exactly that: eight consecutive requests returned
  nothing while the chat demonstrably still held older history.
- **No delivered-count contract.** The number of returned messages relates to
  `count` only loosely; chunking is the phone's choice.

UI language may therefore say "no older saved messages" and "request sent";
it may not say "all history loaded", "no more WhatsApp messages", or report a
delivered count tied to the request (ADR-0010 consequence).

## The observed reality (P4, live linked phone, 2026-07-30)

This run is preserved exactly as observed and reported — it was both. It is no
longer the whole picture: a run on the same profile and the same Baileys
answered on 2026-08-16, and that section follows this one. Read both before
concluding anything about whether the phone answers.

The central live finding: **the phone acknowledges receipt of every on-demand
request, and no answer was ever observed.** The full chain was observed on a
real account (primary: iPhone) with Baileys 7.0.0-rc14, the newest release at
the time (published 2026-07-29):

| Step           | Signal                                                 | Receipted evidence                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission     | `requestHistory` resolves with the request message id  | ✅ all 7 attempts — both receipts carry every request (incl. run 1's offline submission)                                                                                                                                                                                                                                                            |
| Phone delivery | `peer_msg` receipt from the phone's own JID, ~2s later | ✅ **receipted for run 2's 2 requests** (`deliveryAcksAt`, from the run's own transport log). Run 1 predates ack embedding: its receipt substantiates only the offline row's 4m16s-late ack (operator notes); the remaining run-1 delivery and server-relay acks were observed in that run's transport trace and are quoted, unreceipted, on PR #51 |
| Response       | `HISTORY_SYNC_NOTIFICATION` → `on_demand` batch        | ❌ **none observed** — 0 of 7 (0/5 run1-b06fa2f, 0/2 run2-ea53648)                                                                                                                                                                                                                                                                                  |

One seam caveat sharpens, rather than weakens, the verdict: whatsappd's
normalization (`toMessagingHistoryEvents`, `packages/whatsappd/src/baileys/socket.ts`) emits no
batch for a history payload whose normalized chats, contacts, and messages
are all empty — so a hypothetical entirely-empty response is
indistinguishable from silence at this seam. "0 of 7" is therefore a claim
about _observable_ batches, and one more reason no empty-result or
exhaustion signal can honestly be offered.

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
unbounded backfill. The iOS-vs-Android split was the leading hypothesis for the
observed silence. It no longer accounts for it on its own: the 2026-08-16 run
answered on the same iPhone primary, so platform cannot be what separates
answer from silence. Issue #50 carries the re-planned matrix.

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

## The contradicting run (same profile, same Baileys, 2026-08-16)

On 2026-08-16 a downstream spike ran against the `.proof-private/ios` profile —
the same account behind the P4 runs, the same Baileys 7.0.0-rc14,
`creds.platform === "iphone"` — and the phone answered.

| Signal                                    | P4 (2026-07-30) | This run (2026-08-16)        |
| ----------------------------------------- | --------------- | ---------------------------- |
| Requests submitted                        | 7               | 17                           |
| Answered                                  | **0**           | **9**                        |
| Messages delivered as `on_demand` batches | 0               | **419**, in one chat         |
| Depth reached                             | —               | ~5 weeks back, then 8 silent |
| Wall clock                                | —               | 251s                         |
| Baileys                                   | 7.0.0-rc14      | 7.0.0-rc14 (identical)       |
| Primary phone                             | iPhone          | iPhone (the same account)    |

So neither the library version nor the account is the variable.

### What differed — candidates, not causes

One run, one chat, three variables that moved together. This isolates nothing;
it only shows the silence is not unconditional on iOS. The untested variables,
stated plainly:

- **Chat type.** The answered chat was a **group** (`…@g.us`). P4 varied only
  personal DM vs. self-chat — a group anchor appears never to have been tried.
- **Anchor depth.** P4 anchored minutes old. This run anchored on the oldest
  message held and paged backwards over weeks.
- **Credential age.** The device link was created the same day, the previous
  credential having been revoked server-side. The P4 runs used an older link.

Which of the three matters is the open question, and issue #50 is re-planned
around it rather than around the falsified platform premise. The profile
resumes without a scan, so a controlled matrix is cheap.

### What this changes, and what it does not

| Claim                                          | Before                          | After                                                                        |
| ---------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| The phone never answers on an iPhone primary   | settled from 0 of 7             | **false as an unconditional claim** — 9 of 17 answered on the same profile   |
| iOS-vs-Android is the leading hypothesis       | leading                         | **necessary at best, not sufficient** — silence and answer share a platform  |
| `peerDataRequestSessionId` id-echo             | unverified: no response existed | still unverified: responses exist now, but this run did not record the field |
| No completion signal                           | settled                         | unchanged — nine answers arrived, none marking a request finished            |
| No exhaustion signal                           | settled                         | **unchanged, and now evidenced rather than assumed** — see below             |
| Delivered counts, boundary inclusivity, chunks | unobservable without a response | observable in principle now, still unmeasured                                |

**The empty-result seam is the strongest result of the run.** Requests 10–17
returned nothing while the chat demonstrably still held older history in the
durable mirror, and the anchor stopped advancing. A consumer watching the seam
sees one identical picture across three genuinely different worlds: the phone
exhausted what it will serve, the phone declined to answer, or the phone
answered with an empty payload that `toMessagingHistoryEvents` correctly emits
no batch for. Nothing in the protocol separates them. Every "no completion
signal" and "no exhaustion signal" claim above therefore stands, and now rests
on an observation instead of on an absence of observations.

Depth is bounded in any case: 419 messages reached about five weeks into a chat
whose stored history runs to 2022 — consistent with the #2452 note that
official WhatsApp Web also caps deep history behind "check your phone".

Provenance, stated so it is not mistaken for a P4 rung: this was a downstream
spike that copied the profile out and left the baseline byte-identical. It
carries no sanitized receipt at a git head in this repository; the evidence
table lives on issue #50 (comment, 2026-08-16) and issue #199. It is strong
enough to falsify a claim built on absence, and not the same currency as the
receipted P4 chain above.
