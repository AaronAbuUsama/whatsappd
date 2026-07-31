---
"whatsappd": patch
---

`fileStore()` recreates its directory on every write instead of once at
creation. A store whose directory disappeared underneath it — a cleanup job, a
tmpfs, an operator — used to fail every subsequent credential save with
`ENOENT` until the process restarted, which is the save that loses the session.
