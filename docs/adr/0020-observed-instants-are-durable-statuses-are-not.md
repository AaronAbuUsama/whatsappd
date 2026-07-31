---
status: accepted
---

# Observed instants are durable, the statuses they came from are not

ADR-0014 states that presence and connection state "are not appended because
replaying stale typing, availability, `online`, or pairing status would
manufacture current state". Building the Snapshot Window revealed that this one
sentence bans two different things, and only one of them is dangerous. A
historical last-seen timestamp has to survive a restart — an application shows
"last seen yesterday" on a chat it has never had a live presence frame for —
and there is nowhere for it to survive if every trace of presence is barred
from storage. This decision amends that clause; everything else in ADR-0014
stands, including that the ephemeral frames themselves remain undurable and
Connection Freshness unchanged.

## A status decays, an instant does not

Two facts arrive on the same event and age in opposite directions:

- **The status.** "This address is `typing`." "This account is `online`." True
  for seconds. Restoring one at startup asserts something about _now_ from
  evidence about _then_, which is the defect ADR-0014 named.
- **The instant.** "This address was present at 14:02." "This account was last
  connected at 09:31." True for ever, and the older it gets the more obviously
  it is history rather than a claim about now.

The runtime therefore derives an `ObservedInstant` from each ephemeral event and
accepts that, while the event itself stays untypeable as a durable one:

```ts
type ObservedInstant =
  | { type: "last_seen"; contactId: string; at: number }
  | { type: "account_connection"; kind: "connected" | "disconnected"; at: number };
```

It carries no `PresenceKind` and no `Status`, so there is no status in the
source log or the mirror for a replay to restore. `ContactRecord.lastSeenAt`
and `AccountRecord.lastConnectedAt` / `lastDisconnectedAt` are the projections;
each advances monotonically, so a replayed or late-arriving older observation
changes no record and takes no revision.

`unavailable` is the one presence kind that produces no instant, and excluding
it is the difference between keeping history and destroying it. It does not say
"present now"; it says the address is gone. WhatsApp does not send its own
last-seen with it either — `src/baileys/presence.ts` stamps `at` with _receipt_
time — and Baileys reports `unavailable` for a peer that has been offline for
days, notably right after a presence subscription. Recording it would therefore
date a week-old last-seen to this instant, and the monotonic advance would make
that permanent. Every other kind — typing, recording, available, idle — is
evidence the address was there.

Only the two ends of the connection lifecycle produce an instant. `connecting`,
`pairing` and `authenticated` are transitions in which the account is neither
reachable nor known to be gone, and stamping either timestamp from one would
report a reconnect attempt as a disconnection. `backing_off` is a disconnection
and not a transition: a dropped socket enters it directly rather than passing
through `disconnected`, so reading the literal phase alone would leave the
commonest disconnection there is unrecorded.

## Considered options

- **A second durable write path outside acceptance**: rejected. Stamping a
  revision and publishing a patch from a store method that does not append to
  the source log gives an account two acceptance boundaries with two orderings,
  which is the thing ADR-0014's one transaction exists to prevent.
- **Keep last-seen in memory only**: rejected because it is not a last-seen at
  all. A restarted worker would show every chat as never seen until the peer
  next happened to be observed, so the field would read as "seen since this
  process started", which no UI wants and no application can correct.
- **Store the presence event and filter it on read**: rejected. A stored
  `typing` is one careless `snapshot()` away from being served as current, and
  the filter that prevents it is exactly the runtime filter ADR-0014 refused in
  favour of making the mistake untypeable.

The final disconnection is stamped by teardown rather than by the connection
handler. Stopping unsubscribes and gives the claim back before the session
reaches `disconnected`, so that handler can never observe the instant the
runtime actually stopped consuming the account. A crash is a disconnection too,
so the stamp is not conditional on stopping cleanly — and it must not mask the
failure that killed the session, so a store that cannot take this last write is
reported only when nothing worse happened.

## Consequences

- `WhatsAppDurableEvent` is no longer a subset of `WhatsAppEvent`. It is the
  live events that project plus the instants a runtime derives, and a raw
  `connection` or `presence` event is still impossible to hand to a store.
- An Accepted Source Batch may contain an observation with no live event behind
  it. A source consumer reading `last_seen` learns when an address was present
  and cannot learn what it was doing, which is deliberate.
- Presence traffic now takes revisions. A chat whose peer is repeatedly present
  advances the account revision without any message changing; clients apply
  those patches as contact upserts.
- A contact is matched through any of its `nativeIds`, not through whichever
  native form an observation happened to be keyed by. Without that a LID-keyed
  update naming its PN would open a second record and strand the name on one
  snapshot entry and the last-seen on another.
- A last-seen updates a contact and never creates one, which is what keeps that
  matching sound. A presence observation knows one native form of an address and
  nothing that links it to the others, so a creating one would let a PN ping and
  a LID ping open two records for a single WhatsApp Address — and a later
  contact event naming both could then only reconcile them by _removing_ a
  record, which ADR-0019 does not permit a mirror to do. Contact and
  conversation-sync observations always carry the full `nativeIds` set, so a
  record only they create can always be found again and never needs merging
  away. The cost is deliberate and bounded: an address WhatsApp has never named
  in a contact or sync batch keeps no last-seen, and WhatsApp only sends
  presence for addresses a session subscribed to, which its own sync delivered.
  The slice that earns record removal may revisit this.
- The slice that models a contact's live availability owns the reverse
  question — whether a client should ever _derive_ presence from `lastSeenAt` —
  and the answer this decision assumes is no.
