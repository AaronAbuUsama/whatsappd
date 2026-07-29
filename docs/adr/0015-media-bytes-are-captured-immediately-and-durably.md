---
status: accepted
---

# Media bytes are captured immediately and durably

Every inbound image, video, audio, document, and sticker starts durable capture
while its live Baileys `MediaHandle` can still decrypt or request re-upload.
The runtime writes raw bytes through a required, independently replaceable media
capability and persists an opaque storage reference plus explicit stored or
failed state. Metadata alone never represents successful capture.

Voice transcription is a derived consumer concern. A transcriber reads the
stored PTT audio and appends a separate transcript artifact or observation;
transcription failure cannot remove or downgrade the retained original.

## Considered options

- **Persist metadata and download later**: rejected because the live download
  closure cannot survive serialization and old media may become unavailable
  from the linked phone.
- **Make every application callback remember to download**: rejected because it
  duplicates critical data-preservation logic and silently loses media in
  consumers that omit it.
- **Store transcripts instead of audio**: rejected because derivation is
  fallible and cannot replace the source.

## Consequences

- PocketBase files, Convex storage, Supabase Storage, and local filesystem/blob
  implementations satisfy one media contract; the current-state data store
  retains only their opaque references and capture status.
- Blob upload and database commit cross two durability systems, so adapters need
  idempotent keys and orphan cleanup rather than claiming a distributed atomic
  transaction.
