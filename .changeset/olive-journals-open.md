---
"whatsappd": minor
---

Run a local libSQL database in WAL, so a read no longer stops every writer on
the file. `lazyLibsqlClient` sets `journal_mode = WAL` on connect for `file:`
URLs and reads back the mode actually reached, because an in-memory database
answers `memory` and a filesystem without shared memory need not reach WAL at
all.

`WhatsAppDataStore.read(accountId, fn)` keeps one read transaction open for the
duration of an application-supplied function. Under the rollback journal that
refused every writer on the database for as long as `fn` ran — across
connections, backends, and worker threads alike, with the runtime's `accept()`
among them — and the native driver's busy wait blocks the event loop while it
waits rather than yielding it.

WAL alone does not finish the job: local clients in one process also share a
write queue, which serialized `accept()` behind an open `read()` no matter what
the storage engine allowed. A `"read"` operation now skips that queue once WAL
is confirmed, and `close()` tracks the reads that are no longer in it so it
cannot return while one is still holding the database open. Writers stay
queued — two of them still contend, and the loser still busy-waits with the
event loop stopped.

The joint-read conformance proof gains the leg it could not have: both stores
now commit writes _while_ the read is open and are held to answering every
question at one revision anyway, rather than the libSQL leg agreeing about a
mirror nothing could write to. A local database now keeps `-wal` and `-shm`
files beside it.
