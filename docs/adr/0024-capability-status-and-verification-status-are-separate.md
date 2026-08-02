---
status: accepted
---

# Capability status and verification status are separate

The SDK capability catalogue records two different things:

1. capability rows compare Baileys, current whatsappd, and the target Client;
2. verification status says which environments have actually been run.

Automated tests do not imply a live-account, browser, or terminal result. A
`not-run` status means only that the environment has not been exercised; it does
not mean the capability failed or is unsupported.

The machine-readable catalogue is canonical and generates the engineering
Markdown view. It validates the inventory shape, unique capability IDs, pinned
package versions, public export coverage, and generated-file drift. It does not
store a per-test receipt ledger, historical Git anchors, public-variant graph,
or combined implemented-and-proven score.

## Consequences

- Zero live-WhatsApp, browser React, or OpenTUI runs is a valid catalogue state
  and does not require building a harness for this planning issue.
- A real verification status is added only after that environment is actually
  run.
- Database queries remain supporting oracles after public behavior is asserted;
  they do not promote the verification status by themselves.
