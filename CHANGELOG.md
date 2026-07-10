# Changelog

## 0.2.0

### Minor Changes

- 35eca09: Add callback registrars and in-chat replies to the session surface.

  `session.onStatus/onMessage/onUpdate/onConversationSync/onContact/onGroup/onPresence`
  register a handler and return an unsubscribe; any number of listeners receive
  each event, and a listener that throws or rejects is isolated (logged, never
  fatal). Messages delivered to `onMessage` carry a bound `reply` —
  `m.reply("pong")` takes a string or an `Outbound` and quotes the message by
  default.

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-08

Initial release.

### Added

- WhatsApp session engine over Baileys: a narrow, fully-typed surface
  (`createSession`) with status, inbound, update, contact, group, and presence
  streams, plus `send`/`markRead`/`setTyping` commands. No protocol types cross
  the public surface.
- Pluggable credential stores: `memoryStore`, `fileStore`, and an optional
  `libsqlStore` (via the `whatsappd/stores/libsql` subpath).
- QR and pairing-code auth strategies (`qrAuth`, `pairingAuth`).
- Framework-agnostic channel adapter (`createChannelAdapter`) and eight
  plug-and-play agent tools (`whatsappd/tools`).
- HTTP sidecar (`whatsappd/sidecar`, and the `whatsappd` CLI):
  one process per WhatsApp number, forwarding inbound events and serving media
  on demand.
- Eve framework adapter (`whatsappd/adapters/eve`).

[Unreleased]: https://github.com/AaronAbuUsama/whatsappd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AaronAbuUsama/whatsappd/releases/tag/v0.1.0
