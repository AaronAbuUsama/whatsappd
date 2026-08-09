# Runbooks

Operational procedures for a whatsappd account worker in production.

These are written for whoever is holding the pager for an application that
embeds whatsappd — the library runs in-process inside an application-owned
worker (ADR-0006), so the failing thing is always _your_ worker, and these
describe what the library does underneath it.

| Runbook                                              | When you need it                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`session-faults.md`](session-faults.md)             | A session disconnected, keeps reconnecting, or went quiet                      |
| [`stuck-account-lease.md`](stuck-account-lease.md)   | `AccountAlreadyClaimedError` on a worker that should own it                    |
| [`libsql-recovery.md`](libsql-recovery.md)           | The libSQL database is corrupt, locked, or moved                               |
| [`credential-rotation.md`](credential-rotation.md)   | Credentials are dead, leaked, or an account must be re-paired                  |
| [`release.md`](release.md)                           | Publishing a version, or a release that failed halfway                         |
| [`ci-alerts.md`](ci-alerts.md)                       | A `scheduled-failure` issue, or a nightly or weekly job is red                 |
| [`real-account-testing.md`](real-account-testing.md) | Driving the linked test accounts — **read before writing anything that sends** |

## The one thing to check first

Whatever the symptom, get the fault reason before acting. Every disconnect is
classified into a closed union in `packages/whatsappd/src/errors.ts` and lands in one of three
dispositions, which decides the whole response:

| Disposition  | What it means             | What to do               |
| ------------ | ------------------------- | ------------------------ |
| `retryable`  | Transport problem         | Nothing — it reconnects  |
| `logged_out` | Credentials are dead      | Wipe and re-pair         |
| `suspended`  | Account or device problem | Re-pairing will not help |

Acting against the disposition is the most common way to make an incident
worse: wiping credentials on a `retryable` fault turns a 30-second reconnect
into a QR scan, and retrying a `suspended` account forever hides that a human
has to intervene.
