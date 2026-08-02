---
status: accepted
---

> Superseded by ADR-0027. Applications still own their long-running worker
> processes, but those workers create and retain WhatsApp Clients rather than
> constructing public Runtime objects.

# Runtimes are composed by application-owned workers

Applications create `WhatsAppRuntime` inside their own long-running Node code,
which may be a dedicated one-account operating-system process. The current
sidecar is retired, and whatsappd does not initially replace it with a generic
daemon or HTTP transport because separate processes do not require a second
public runtime API.
