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
- The slice that models a contact's live availability owns the reverse
  question — whether a client should ever _derive_ presence from `lastSeenAt` —
  and the answer this decision assumes is no.
