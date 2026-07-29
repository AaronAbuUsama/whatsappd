---
status: accepted
---

# Account lifecycle rides the command queue

Pair and unlink are WhatsApp commands carried on the durable command queue,
not worker-local-only APIs. The pairing command carries its method and, for
pairing-code flows, the phone number supplied at command time.

Durable runtime state contains only challenge metadata: identifier, method,
state, and expiry. The raw QR or pairing code is published through a separate,
authorized, short-lived challenge capability; it never enters ordinary mirror
snapshots, subscriptions, backups, or diagnostic dumps.

This gives linking — the most privileged account operation — the same
application-authorization surface as every other command without making its
secret ordinary application data. Unlink performs a Baileys logout, clears only
that account’s credentials, and leaves the mirror intact. The worker-local
`runtime.pair()` remains for trusted bootstrap composition.

## Considered options

- **Worker-local lifecycle only**: rejected because browser-driven pairing would
  require bespoke application-to-worker glue.
- **Raw challenge in `runtime_state`**: rejected because expiry does not remove
  the secret from backups, admin surfaces, or already-delivered snapshots.
