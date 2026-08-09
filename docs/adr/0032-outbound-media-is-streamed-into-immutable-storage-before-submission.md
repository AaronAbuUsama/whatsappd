---
status: accepted
---

# Outbound media is streamed into immutable storage before submission

An outbound image, video, audio, document, or sticker is completely and
durably published through the injected Media Store before its WhatsApp
Operation is submitted. The operation row contains only the returned opaque
media reference and message metadata. A replacement Runtime opens that
reference as a byte stream immediately before the Session call.

The Media Store accepts and returns asynchronous byte streams. URL and
asynchronous-stream inputs do not require the Client or adapters to materialize
a complete object as one `Uint8Array`. A Buffer is already materialized and
mutable, so the Client takes one call-time snapshot to own its value, then emits
bounded views of that snapshot. The filesystem adapter writes into a private
temporary object, updates its content hash incrementally, syncs it, and
publishes the immutable object only after the input ends successfully. Its read
side streams the published object. In-memory storage may retain complete objects
because that is the purpose of that adapter, but it satisfies the same streaming
contract.

Publishing media and submitting an operation cross two independently
replaceable durability systems. They are not one distributed transaction. The
Client fixes the operation identity first, uses it as the media owner, publishes
the bytes idempotently, and then submits the deterministic operation. If
submission reports an error, the Client may read the operation by that identity
and accept an exact matching committed row. Whether that read finds a row or
cannot establish the commit, the already-published media remains intact.

Media Store staging leases, `retain`, and `discard` are not part of the 0.3
contract. A fully published object is never deleted from an operation
submission error path: a response may have been lost after the operation row
committed, and deleting the object would corrupt queued work. Reconciliation
and deletion of unreferenced published objects remain the responsibility of
post-0.3 issue #72. Ordinary cancellation and failure remove only the current
process's unpublished temporary file; a hard process exit may leave temporary
storage for that later reconciliation work.

Creating the immutable canonical object is the no-delete boundary. A later
durability error may make one `write` call reject, but that path preserves the
canonical bytes because another concurrent writer or committed operation may
already reference them. Stronger writer coordination and orphan reconciliation
remain post-0.3 work under #72.

`ptt: true` classifies already-compatible voice-note bytes; it does not
transcode them. Before publishing a voice-note operation, the Client performs a
bounded structural check for an Ogg Opus mono payload and rejects incompatible
media before an operation row can execute. Optional transcoding remains an
application or future adapter concern.

## Considered options

- **Keep whole-byte `put`/`read` plus staging leases**: rejected because it
  makes memory grow with object size, widens every Media Store with cleanup
  protocol, and can delete bytes referenced by a committed operation when a
  database response is lost.
- **Expose Effect streams through the SDK and Media Store**: rejected because
  the existing public contracts use Promises, AbortSignal and asynchronous
  iterables, and native streams already provide the required backpressure and
  cleanup primitives.
- **Store media inside the operation database transaction**: rejected because
  backend capabilities remain independent and libSQL is not the media store.
- **Transcode arbitrary voice-note input in core**: rejected because Baileys
  does not supply that conversion and a native or WASM encoder would make a
  portable storage/execution boundary own an unrelated media product.

## Consequences

- The exported Media Store contract changes from whole-byte `put`/`read` to
  streaming `write`/`open`; custom adapters require an explicit 0.3 migration.
- Buffer input costs one caller-isolating snapshot and then follows the same
  bounded-chunk staging path as URL and asynchronous-stream inputs.
- The operation state machine and idempotency rules remain unchanged.
- Orphaned published media is a bounded ownership problem to reconcile later,
  not data the submission path may guess is safe to delete.
- Real iOS and Android playback evidence is required before documentation calls
  voice notes cross-device verified.
