# Runbooks

Procedures for developing, releasing, and operating whatsappd.

These are written for whoever is holding the pager for an application that
embeds whatsappd — the library runs in-process inside an application-owned
worker (ADR-0006), so the failing thing is always _your_ worker, and these
describe what the library does underneath it.

| Group                          | Contents                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| [`development/`](development/) | Domain language, issue triage, and safe real-account testing                        |
| [`delivery/`](delivery/)       | Publishing and recovering a release                                                 |
| [`operations/`](operations/)   | Session faults, account leases, libSQL recovery, credential rotation, and CI alerts |

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
