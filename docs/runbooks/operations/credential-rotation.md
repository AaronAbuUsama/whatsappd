# Runbook: credential rotation and re-pairing

**When:** a `logged_out` disposition fault, a suspected credential leak, or a
deliberate re-link of an account.

## Confirm you actually need this

Wiping credentials on a `retryable` fault turns a 30-second automatic reconnect
into a QR scan by a human. Check the disposition first — see
[`session-faults.md`](session-faults.md). Only `logged_out_remote` (401),
`connection_replaced` (440), and `pairing_rejected` (400) call for a wipe.

For `connection_replaced`, first rule out a second worker
([`stuck-account-lease.md`](stuck-account-lease.md)). Re-pairing while another
worker holds the account just gets you replaced again.

## Rotating

1. **Stop the worker.** `runtime.stop()` releases the account lease. Clearing
   credentials under a live socket races the session's own writes.

2. **Clear the store.** Call `clear()` on the `CredentialStore`; do not delete
   files by hand.

   `fileStore(dir)` owns only its private `.whatsappd-credentials` child, and
   `clear()` never removes `dir` or anything else in it. It also removes
   recognized pre-0.2.3 credential files — even ones never read — while
   preserving unrelated caller-owned entries. Deleting `dir` yourself destroys
   whatever else you put there; deleting only some files leaves a half-state
   that pairs and then fails.

   For `libsqlBackend()`, the credentials are rows in `wa_auth` scoped to the
   account. Clearing through the store keeps that scoping; hand-editing the
   table does not.

3. **Re-pair.** Start the runtime again. `qrAuth()` prints a QR to scan;
   `pairingAuth()` takes a phone number and prints a code. Expect a
   `restart_required` (515) fault immediately after — that is how WhatsApp
   completes a link, not a failure.

4. **Verify.** Wait for `phase: "online"`, which is the authoritative readiness
   signal for commands, then send one message to confirm the link is real.

## What a re-pair costs

New credentials mean a new device link. WhatsApp backfills what it still offers,
which is not everything: an exhausted paging cursor means nothing older is
_stored_, never that WhatsApp has no more. Durable data already accepted into
the backend survives — the accepted source, mirror, and stored pages are keyed
by account, not by credential.

## Suspected leak

Credentials never travel by environment variable and are never logged by the
library. If they have leaked, the exposure is whatever holds the store:

- `fileStore()` writes a private `0600` state file, replaced atomically. Check
  who can read the directory, and whether it was ever committed — `.wa-auth/`
  is gitignored precisely because it should not be.
- `libsqlBackend()` puts them in `wa_auth`. Check database access and any
  backup copies of the file, including the `-wal` alongside it.

Rotate as above, then treat the linked account as compromised until re-linked:
whoever held the credentials could act as that account.
