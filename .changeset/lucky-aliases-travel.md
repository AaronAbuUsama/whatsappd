---
"whatsappd": minor
---

Carry every mutation kind the projection computed on the patch (ADR-0030,
amending ADR-0011). `WhatsAppPatch.aliases` carries the Address Resolution
that changed, and `MirrorDelete.freedNativeIds` names the native ids a
consolidated-away contact record owned.

The projection has always computed all three kinds and the patch shipped two,
so a consumer maintaining state from patches could not keep Address
Resolution coherent at all — it could only discard its state and re-read a
snapshot, which is the gap-recovery path, on an ordinary event. WhatsApp
delivers PN/LID equivalence routinely (ADR-0022), so that was not rare.

Only a native id whose owner actually changed appears in `aliases`:
re-observing a contact re-asserts every alias it already had, and carrying
those would move the mirror revision on an observation that told it nothing.
Every id a delete frees is re-pointed by an alias in the same patch, so the
two arrays need no ordering between them. Accepted source batches are
unchanged, and ADR-0019's revocation and authoritative-replacement
restrictions still hold — only the projected patch grows.
