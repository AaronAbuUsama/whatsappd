# WhatsApp web example

This is the working Next.js client used to prove the public `WhatsAppClient`
before reusable behavior and shadcn-compatible source are extracted. Its
acceptance contract is
[`docs/architecture/web-client-feature-contract.md`](../../docs/architecture/web-client-feature-contract.md).

## Run locally

Set the saved account profile and its account id, then start the long-lived
local Node process:

```bash
WHATSAPPD_PROFILE_DIR=/absolute/path/to/profile \
WHATSAPPD_ACCOUNT_ID=account-id \
pnpm example:web
```

Open <http://127.0.0.1:3000>. The profile directory must contain
`whatsapp.db`; file-backed media is reopened from its `.whatsappd-media`
directory.

The application reads its send allowlist from
`WHATSAPPD_SEND_ALLOWLIST` or the machine-local proof configuration documented
in the
[`real-account-testing` runbook](../../docs/runbooks/development/real-account-testing.md).
A missing or invalid allowlist disables sends. Never infer a destination from
chat order or display text.

## Verify

```bash
pnpm --filter @whatsappd/example-web test
pnpm --filter @whatsappd/example-web build
```

Deterministic tests use privacy-safe invented records and do not open a linked
account. Browser evidence is retained only beneath ignored `.artifacts` as
specified by WC-01 and WC-02.
