# Agentic TUI feature contract

This is the durable definition of done for the `examples/opentui` working
example. It adapts the public Client contract to a terminal; it does not create
a second WhatsApp API or claim browser-only rendering features.

## Contract

| ID    | Terminal behaviour                                                                                                                                                                                                          | Concrete proof                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| AT-01 | The real launcher composes `WhatsAppClient` and `@whatsappd/react`; all external writes are rejected unless the target is in the external real-account allowlist.                                                           | Application test exercises allowed and rejected targets.                               |
| AT-02 | Account connection, terminal, and pairing-step state is visible without exposing a QR/pairing secret.                                                                                                                       | Application test projects every safe phase and scans output for the fixture QR secret. |
| AT-10 | Chats are ordered, searchable, selectable by keyboard and pointer, and distinguish groups from direct chats.                                                                                                                | Headless desktop and narrow journeys select and search chats.                          |
| AT-11 | Contacts and groups are separate searchable views; unknown group rosters remain unknown rather than becoming zero participants.                                                                                             | Projection test and headless section journey.                                          |
| AT-20 | The transcript represents text, image, video, audio/voice note, document, sticker, location, contacts, poll, revoked, and unsupported records with context, flags, receipts, reactions, edits, and operation state.         | Table-driven projection test plus captured state-lab transcript.                       |
| AT-21 | Older saved messages and phone-history requests remain separate actions.                                                                                                                                                    | Action test asserts `older()` and `requestPhoneHistory()` independently.               |
| AT-22 | React, unreact, edit, revoke, mark-read, typing, and operation acknowledgement route through typed Kit actions to the public Client.                                                                                        | Action invocation test asserts exact Client calls.                                     |
| AT-23 | Text, image, video, audio, voice note, document, sticker, location, and contact sends route through typed Kit actions. Binary files are streamed from an explicit local path; voice notes require caller-supplied Ogg Opus. | Table-driven command test asserts exact Client calls and rejects malformed commands.   |
| AT-24 | Group metadata and current create/leave/subject/description/participants/settings/invite/picture commands route through one guarded action seam.                                                                            | Table-driven group action test; non-allowlisted group mutation rejects.                |
| AT-30 | Desktop and narrow layouts remain usable by keyboard and pointer, including hover/select rows and a non-AI message composer.                                                                                                | Kit headless journeys at fixed desktop and narrow viewports.                           |
| AT-31 | A single command writes ignored screen text, action history, PNG, MP4, journey record, checksummed evidence report, and a browsable HTML index.                                                                             | `pnpm --filter @whatsappd/example-opentui evidence`.                                   |

## Definition of done

- `agentic-tui-kit` owns the panel, workspace, action registry, command palette,
  sidebar rows, keyboard/pointer routing, headless journey, and visual capture.
- The example owns WhatsApp-specific projection, transcript rows, command
  parsing, and the final allowlist check.
- The real launcher uses only public `whatsappd` and `@whatsappd/react` APIs.
- Deterministic evidence contains no real account identifiers, messages,
  credentials, QR payloads, or media bytes.
- PNG and MP4 are visually inspected before the evidence claim is accepted.
- Avatar image rendering, media playback, microphone recording, calls, status,
  and channels are not claimed. Add them only after the public Client exposes a
  truthful terminal-capable seam.
