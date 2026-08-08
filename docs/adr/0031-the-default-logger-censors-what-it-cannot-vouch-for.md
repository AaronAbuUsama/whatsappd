---
status: accepted
---

# The default logger censors what it cannot vouch for

Every deliberate log call in this library already hands the logger a
purpose-built object. `connectionUpdateTelemetry` reports `qrChars` — the
length of the QR — and never the QR. `historySetTelemetry` reports how many
chats arrived and how many carried inline messages, and never a chat. That
discipline is real, and it is why the obvious answer to "does this library log
private data?" was, for most of its surface, no.

It left one gap, and the gap is structural rather than careless. Two sites log
an error object: the metrics-hook guard, and the session's own run failure.
Those errors originate in Baileys or in the socket beneath it, so their shape
is not this library's to choose. A failed send can arrive carrying the payload
it failed to send. An HTTP-shaped failure can arrive carrying the request
headers, including the authorization header.

This was measured before it was fixed. An error carrying a message body, a
recipient's phone number, and a bearer token serialized all three in full.

## The default logger redacts; a supplied logger does not

`createSession` builds a `pino` logger only when the caller supplies none. That
fallback now carries a `redact` list covering message content, addresses, and
credentials.

A caller who passes their own `logger` gets exactly what they passed. That
asymmetry is deliberate: an application with its own logging stack has its own
redaction policy, its own destinations, and its own compliance story, and
silently rewriting its configuration would be a worse surprise than the one
being fixed. The library defends the logger it owns.

## Explicit paths, plus value-aware message envelopes

Most redaction remains an explicit path list because a full recursive sweep is
walked on every log call, including the overwhelming majority that carry
nothing sensitive, and this library logs on a connection's hot path.

The cost of that choice is that the list must name the shapes that matter, and
naming them is fallible. A first version used only nested wildcards — `*.token`
and the like — and read as complete. It was not: `*.token` matches a token one
level down and not a `token` on the logged object itself. A test caught it. The
top-level duplicates in the list exist because of that, and the tests assert on
the bytes written rather than on the configuration, because a `redact` list can
be present and still miss the path that carries the secret.

Baileys message envelopes are the exception. A property literally named
`message` can appear at more than one depth, so the default logger applies a
value-aware formatter before serialization. Once it reaches a property named
`message`, it censors that entire envelope subtree. This is structural rather
than an allowlist of protocol subtype names: document filenames, contacts,
locations, response labels, polls, nested view-once or ephemeral wrappers, and
future message subtypes are all covered without waiting for the protocol list
to be updated. A real `Error` still serializes its diagnostic `message`
verbatim. This distinction is tested as a positive control, because restoring
a generic `*.message` path would hide the leak but also blind operators to every
error diagnostic.

## Consequences

Anyone relying on the default logger to print a full error object for debugging
will see censored fields. The error's own `message` and the log line's `msg`
survive, which preserves the diagnostic value that made those two call sites
worth having; the payload that a debugger might have wanted is the payload this
decision exists to withhold. Passing an explicit `logger` opts out entirely.

The explicit path list remains a maintenance burden as new non-message wire
fields appear. Message subtype growth is deliberately not part of that burden:
the envelope rule is protocol-shape independent. The formatter still avoids
pattern-scanning every value on every log call, and its byte-level tests fail
loudly rather than leaving this boundary to a comment asking for care.
