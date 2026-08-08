---
status: accepted
---

# Redaction is the consumer's concern

The default logger is an ordinary `pino` logger. It uses `WA_LOG_LEVEL`, falling
back to `warn`, and writes to stderr. It does not redact its output.

Applications that route logs to a shared or third-party sink must pass
`SessionConfig.logger` configured for their own policy. Pino's `redact` option
is the intended mechanism. The library cannot know a consumer's compliance
regime, retention policy, or destinations, and it must not imply that it does.

## Reversal

The library previously built a censor into the default logger. It began with
explicit paths for message content, addresses, credentials, and error fields,
then added a recursive formatter for Baileys message envelopes.

That approach was removed after it proved unable to make an honest guarantee.
The object graph belongs to WhatsApp's wire protocol and changes without this
library's involvement. Each new message subtype introduces another possible
field: document filenames, contact cards and names, locations, poll names, and
button or list response labels were among the shapes missed while the censor
was already documented as protection. Chasing that graph is unwinnable, and a
partial redaction promise is worse than none because consumers may rely on it.

The default destination also matters. Stderr is on the consumer's own machine;
it is not a transport and does not itself exfiltrate data. The consumer decides
whether those bytes remain in a terminal, go to a file, or enter an aggregator.
That decision is where the applicable redaction policy belongs.

## Consequences

The ordinary logger preserves standard error serialization, including
`err.stack`, because stack traces are useful developer diagnostics. Consumers
must assume protocol errors may contain private or identifying values.

The `logger` option remains the policy seam. A supplied logger is used exactly
as configured, and the README shows a minimal redacting `pino` example.
