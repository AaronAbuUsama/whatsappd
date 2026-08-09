# QR pairing CLI

From the repository root:

```bash
pnpm example:qr
```

On the first run, scan the QR in WhatsApp under **Linked devices → Link a
device**. The example keeps its credentials and media in the gitignored
`examples/qr-cli/.data/` directory, so later runs resume without another scan.

The example sends nothing and never unlinks the account. Press `Ctrl+C` to stop
the Session cleanly.
