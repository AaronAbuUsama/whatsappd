# Runbook: libSQL recovery

**Symptom:** the database is locked, corrupt, moved, or a restart came back with
missing data.

## Move the three files together

A local `file:` database is opened in WAL mode, so `whatsapp.db` has
`whatsapp.db-wal` and `whatsapp.db-shm` beside it. **Move, copy, back up, and
restore all three together.** Copying only `whatsapp.db` from a running system
gives you a database missing every commit still in the WAL — it will open
cleanly and be silently out of date, which is worse than a file that fails to
open.

The safest copy is from a stopped worker. If you must copy live, use
`sqlite3 whatsapp.db ".backup restored.db"` rather than `cp`.

## "Database is locked" / writers blocked

WAL is what lets a long `read()` hold its transaction open without blocking
writers. If writers _are_ blocking, the database is almost certainly not in WAL
mode — a filesystem with no shared memory (many network mounts: NFS, SMB, some
container volume drivers) silently keeps the rollback journal instead, where one
open read blocks every writer on the file.

```bash
sqlite3 whatsapp.db "PRAGMA journal_mode;"   # expect: wal
```

If this says `delete` or `truncate`, the fix is the storage, not the database.
Move it to a local volume. This is a deployment problem that only shows up under
concurrent load, so it typically appears first as unexplained write timeouts.

## What is recoverable after corruption

Reopening a backend on the same URL reconstructs the accepted source, the
current mirror, stored pages, and attachment references. The accepted-source
feed is the durable record; the mirror is a projection of it.

Media bytes are **not** in the database. `fileMediaStore()` writes them as
private immutable objects on disk and libSQL stores only the opaque reference
plus its `stored` or typed `failed` state. A restored database with a lost media
directory gives you messages whose media references resolve to nothing — back up
both, or accept that media is best-effort.

Credentials live in `wa_auth`. Losing them means re-pairing; see
[`credential-rotation.md`](credential-rotation.md).

## Integrity check

```bash
sqlite3 whatsapp.db "PRAGMA integrity_check;"   # expect: ok
```

If it reports errors, restore from backup rather than repairing in place. The
schema is written by `packages/whatsappd/src/runtime/libsql.ts` with `CREATE TABLE IF NOT EXISTS`
and tracked in `wa_schema_migrations`, so a fresh database is created
automatically on next open — but a fresh database is an empty one, and the
account will re-pair and re-sync from WhatsApp rather than resume.

## Before deleting anything

An account whose database you delete loses its accepted source, its mirror, and
its credentials. It will pair again as a new link and backfill only what
WhatsApp still offers — an exhausted cursor means nothing older is _stored_,
never that WhatsApp has more to give. Deleting the database is not a way to
"reset" an account cheaply; it is data loss with a re-pair attached.
