---
status: accepted
---

# Capability observations are independent

The SDK capability catalogue separates three kinds of fact:

1. a capability records the upstream, current, and target product shape;
2. an implementation slice records one exact current outcome and optional
   source anchors;
3. an observation records one exact scenario, surface, environment, lifecycle,
   and immutable git receipt.

A source anchor establishes that named code existed at the catalogue audit
commit. It is not a behavioral observation. Deterministic, durability,
native-backend, live-WhatsApp, browser, OpenTUI, and packed-consumer
observations are independent facts. One never implies another, and absence
means not observed rather than failed.

The machine-readable catalogue is canonical and generates the engineering
Markdown view. It contains no global `supported`, `requiredRung`, `provenRung`,
or combined implemented-and-proven verdict. P0-P6 labels may classify work
requested by a ticket, but they are not accumulated on product capabilities.

Every observation covers named implementation slices and keeps its own exact
receipt. Public exports and closed public variants are derived from TypeScript
and must be present, mapped, or explicitly excluded. Historical anchors and
receipts must resolve at their named commits. Evidence never transfers across
surfaces, variants, adapters, lifecycles, renderers, or environments.

## Consequences

- A passing unit test supports only its recorded deterministic scenario; it
  does not create a live-account or browser observation.
- Zero live-WhatsApp or React observations is a valid, explicit catalogue
  state and does not require building a new harness.
- Generated docs can summarize current availability and recorded observations
  without inventing a confidence score.
- Database queries remain supporting oracles after assertions through the
  product seam, not behavioral observations by themselves.
