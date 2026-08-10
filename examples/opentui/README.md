# OpenTUI WhatsApp example

Working consumer of the public `whatsappd` Client and `@whatsappd/react`, built
as an Agentic TUI Kit workbench. The Kit owns panels, workspaces, typed actions,
the command palette, sidebar pointer states, keyboard routing, and evidence
capture. The example owns only WhatsApp projection and commands.

## Run

```sh
WHATSAPPD_ACCOUNT_ID=... \
WHATSAPPD_PROFILE_DIR="..." \
pnpm --filter @whatsappd/example-opentui dev
```

Sending is disabled unless the selected exact chat id appears in the external `send-allowlist.json` described by `docs/runbooks/development/real-account-testing.md`. Missing or malformed allowlist data means no sends.

Keys: `↑/↓` or `j/k` select, `Enter` opens a narrow conversation, `Tab`
changes focus, `o` loads older saved rows, `i` focuses the composer, `Escape`
goes back, `Ctrl+P` opens discoverable typed actions, and `q` exits. Safe group
metadata reads appear in the palette; the full group mutation surface remains
available to agents as the typed `whatsapp.group.action` action rather than as
one-click writes.

The composer sends plain text. Its path-based commands cover the remaining
public outbound kinds without loading whole files into the terminal process:

```text
/image "/path/image.png" optional caption
/video "/path/video.mp4" optional caption
/audio "/path/audio.ogg" audio/ogg
/voice "/path/voice.ogg" 12
/document "/path/report.pdf" application/pdf report.pdf optional caption
/sticker "/path/sticker.webp"
/location 5.56 -0.20 "Accra" "Ghana"
/contact "Display name" "BEGIN:VCARD..."
/react 👍   /unreact   /edit corrected text   /revoke   /read
/history 50   /typing on   /typing off   /ack
```

`/voice` requires an Ogg Opus mono file; the Client validates but does not
transcode it.

## Test and evidence

```sh
pnpm --filter @whatsappd/example-opentui test
pnpm --filter @whatsappd/example-opentui evidence
pnpm --filter @whatsappd/example-opentui evidence:finalize -- <evidence-directory> "Inspector name"
```

Evidence is deterministic and privacy-safe. Capture writes raw PNG, MP4,
terminal screens, and typed action history. After those visuals are actually
inspected, the separate finalize command writes checksums, the Kit report, and
`index.html`; capture alone never claims an inspection occurred. Its
terminal contract and definition of done live in
`docs/architecture/agentic-tui-feature-contract.md`.

The Client exposes pairing state but not the protected application
challenge-consumption capability. This example reports the safe pairing step
and never logs or renders the QR/code secret. Terminal avatar images, media
playback, and microphone recording are likewise not claimed until a public
terminal-capable Client seam exists.
