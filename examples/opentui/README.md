# OpenTUI WhatsApp example

Private proof consumer for the public `whatsappd` Client, `@whatsappd/react`,
and the byte-identical source installed from `registry/opentui`. The shared
package owns React store and Client subscription lifetime; OpenTUI owns the
terminal tree, projection, selection, focus, keyboard input, layout and scroll
anchoring.

## Run

```sh
WHATSAPPD_ACCOUNT_ID=... \
WHATSAPPD_PROFILE_DIR="..." \
pnpm --filter @whatsappd/example-opentui dev
```

Sending is disabled unless the selected exact chat id appears in the external `send-allowlist.json` described by `docs/runbooks/development/real-account-testing.md`. Missing or malformed allowlist data means no sends.

Keys: `↑/↓` or `j/k` select a chat, `Enter` opens it in a narrow terminal, `Tab` changes focus, `o` loads an older saved page while preserving the first visible message, `i` focuses the composer, `Escape` goes back, and `q` exits.

The Client exposes pairing state but not the protected application challenge-consumption capability. Per the closed/wontfix #109 owner decision, this example reports connection state and does not surface QR/code secrets or invent a second pairing API.
