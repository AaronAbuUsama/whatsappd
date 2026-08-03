---
"whatsappd": minor
---

Deliver live and durable frames on separate registrations, and rewrite the
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
