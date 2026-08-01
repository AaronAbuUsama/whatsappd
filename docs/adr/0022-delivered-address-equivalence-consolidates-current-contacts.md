---
status: accepted
---

# Delivered address equivalence consolidates current contacts

WhatsApp may name one address by phone-number JID, LID, or both. Every contact
and message adapter retains only equivalence forms WhatsApp actually delivered.
The current mirror exposes `contactAliases`, mapping each delivered native form
to the contact record that owns it.

When a new observation reaches one existing record, that record keeps its
identity. When it explicitly links two existing records, the record reached by
the observation's primary form survives, all fields and native forms merge into
it, and the patch deletes the redundant current-mirror contact. The accepted
source batches remain append-only: consolidation removes a projection artifact,
not evidence.

## Considered options

- **Keep both records and expose aliases only**: rejected because a snapshot
  would still claim two contacts while its resolver claimed one.
- **Choose a synthetic person id**: rejected because ADR-0001 models delivered
  WhatsApp addresses, not inferred people.
- **Rewrite accepted source**: rejected because ADR-0014 requires observations
  to remain durable and followable.

## Consequences

- `WhatsAppPatch.deletes` exists only for an explicitly consolidated contact.
  Revocation and authoritative replacement remain separate decisions.
- A message carrying `sender.alt` can establish the same resolver link as a
  contact event; no equivalent address is invented.
- Consumers apply contact deletes and upserts at one patch revision, or replace
  state from a snapshot after a revision gap.

This amends ADR-0019's temporary upsert-only restriction.
