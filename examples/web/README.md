# Web interface prototype

Three fixture-driven WhatsApp application layouts, switchable with
`?variant=dense`, `?variant=control`, and `?variant=pocket`. This is the design
laboratory for issue #159; it does not connect to a real account or send.

## Getting Started

From the repository root:

```bash
pnpm example:web
```

Open <http://localhost:3000>. The fixture covers pairing, connection, message,
attachment, reaction, receipt, paging, and durable-operation states. Real
Runtime/Client transport is deliberately the next step after a layout wins.
