---
status: accepted
---

# The capability guide and verification status are separate

The human-maintained SDK capability guide records two different things:

1. capability rows compare Baileys, current whatsappd, and the target Client;
2. verification status says which environments have actually been run.

Automated tests do not imply a live-account, browser, or terminal result. A
`not-run` status means only that the environment has not been exercised; it does
not mean the capability failed or is unsupported.

The guide is edited directly in `docs/sdk-capabilities.md`. It is planning
documentation, not a product authority, generated artifact, or merge gate.
Accepted ADRs and issue contracts govern decisions; runtime interfaces and
their proof establish shipped behavior.

## Consequences

- Zero live-WhatsApp, browser React, or OpenTUI runs is a valid catalogue state
  and does not require building a harness for this planning issue.
- The guide has no machine-readable twin, renderer, schema validator, public
  export inventory check, or fact-locking test.
- A real verification status is added only after that environment is actually
  run.
- Database queries remain supporting oracles after public behavior is asserted;
  they do not promote the verification status by themselves.
