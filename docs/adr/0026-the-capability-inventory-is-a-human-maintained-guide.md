---
status: accepted
---

# The capability inventory is a human-maintained guide

The SDK capability inventory is edited directly in
`docs/sdk-capabilities.md`. It is planning documentation, not a product
authority, generated artifact, or merge gate. Accepted ADRs and issue contracts
govern decisions; runtime interfaces and their proof establish shipped
behavior.

This supersedes ADR-0024's decision to make a machine-readable JSON catalogue
canonical. ADR-0024's distinction between capability status and verification
status remains: automated tests never imply a live-account, browser, or
terminal result, and `not-run` means only that an environment was not exercised.

## Consequences

- The guide has no machine-readable twin, renderer, schema validator, public
  export inventory check, or fact-locking test.
- Capability coverage, current status, intended interfaces, planning notes, and
  plain verification status remain together in the human-readable guide.
- A real verification status is recorded only after that environment is run.
- Product changes are proven through their real interfaces and required proof
  rung, not by synchronizing a parallel capability model.
