---
status: accepted
---

# Coherence is answered by the substrate, not reconstructed above it

Issue #71 asks the WhatsApp Client to present one coherent application view:
chats, contacts, groups and a conversation's messages that agree with each other.
Two implementations were retired trying to assemble that coherence from parts the
layers below hand up incoherently. Scoring the retired Client's complexity
attributed eleven of its twenty findings to substrate properties, four to the
specification, and five to itself.

Three of those properties are not fixable above the store at any Client design.
This decision fixes them where they belong. ADR-0003 already makes whatsappd the
owner of the Current Mirror; owning it includes answering questions about it
consistently.

## A joint read is a read transaction, not a retry loop

`WhatsAppDataStore.snapshot()` and `WhatsAppDataStore.messages()` each open their
own read transaction and neither accepts a revision. Opening a conversation needs
both — global state, and that chat's newest page — so a consumer receives two
reads of two different revisions and must reconcile them.

The only reconciliation available above the store is to read both, compare
revisions, and retry on mismatch. Against a live write stream that loop is
unbounded and livelock-prone, and it produced a P1 on the first review round of
the second attempt.

The store therefore exposes the transaction boundary it already has internally:

```ts
read<T>(accountId: string, fn: (view: MirrorView) => Promise<T>): Promise<T>;

export interface MirrorView {
  snapshot(): Promise<WhatsAppSnapshot>;
  messages(chatId: string, options?: StoredMessagePageOptions): Promise<StoredMessagePage>;
}
```

One transaction, any number of reads, one revision. `snapshot()` and `messages()`
remain as one-line conveniences over it. This is an exposure of existing
behaviour rather than a new capability: both implementations already wrap their
reads in exactly this boundary.

## The Client reaches that transaction through a private Runtime source

The public factory remains `createWhatsAppClient(runtime)`: passing a Backend as
a second public argument would expose infrastructure ownership to application
state, while adding `read()` to `WhatsAppRuntime` would turn an internal
coherence need into a general Runtime query API.

The concrete Runtime implementation therefore registers one module-private
source for the Client:

```ts
type ClientRuntimeSource = {
  frames(signal?: AbortSignal): AsyncIterable<WhatsAppDurableFrame>;
  onLive(
    listener: (
      frame: WhatsAppLiveFrame,
      claim: { fencingToken: number; expiresAt: number },
    ) => void,
  ): Unsubscribe;
  read<T>(fn: (view: MirrorView) => Promise<T>): Promise<T>;
  identity(): WaIdentity | undefined;
  currentClaim(): { fencingToken: number; expiresAt: number } | undefined;
};

const clientSourceFor = new WeakMap<WhatsAppRuntime, ClientRuntimeSource>();
```

`createWhatsAppRuntime()` captures its Backend, Session identity, account claim
and the existing durable pull loop in that source. `createWhatsAppClient()`
accepts only a Runtime created by this module and looks up the source. No public
Runtime read method, Backend parameter, generic source Adapter or second durable
frame loop is introduced.

This also keeps live observations tied to the claim that produced them: a Client
accepts one only while its fencing token is still current and the observation
and claim have not expired. Durable coherence comes from the Data Store read
transaction; live freshness comes from the current Runtime claim. Neither is
reconstructed by comparing independent application reads.

## Live and durable do not share one ordered channel

`WhatsAppClientFrame` places `presence` and `connection` — which carry no
revision and expire by wall clock — in the same union and the same listener set
as `snapshot`, `patch` and `closed`, which are revision-ordered. From one
observation the Runtime publishes the live frame before the durable patch derived
from it.

A consumer that maintains a revision-ordered view therefore receives, on one
channel, values that cannot be ordered against it. Live state cannot join a
revision-ordered commit boundary because it has no revision, and requiring it to
is how the retired implementations acquired a publication path that bypassed
their own transition machinery.

The channels are separated at the Runtime:

```ts
export type WhatsAppDurableFrame = snapshot | patch | closed;   // revision-ordered
export type WhatsAppLiveFrame    = presence | connection;       // expiring, unordered

onFrame(listener: (frame: WhatsAppDurableFrame) => void): Unsubscribe;
onLive (listener: (frame: WhatsAppLiveFrame)    => void): Unsubscribe;
```

ADR-0020 already separated these two kinds of fact for storage; this separates
them for delivery. ADR-0028 describes how a client then represents the live one.

## A patch carries every mutation the projection computed

ADR-0011 specifies that a patch carries normalized mirror-record upserts and
deletes. ADR-0019 recorded that no delete producer existed yet, and ADR-0022
established WhatsApp-delivered PN/LID equivalence as the first one. But the
projection computes a third mutation kind — the alias itself — and the patch type
does not carry it, and `MirrorDelete` does not name the native ids a delete
frees.

The consequence is stronger than an inefficiency: a consumer maintaining state
from patches cannot keep Address Resolution coherent at all. It can only discard
its state and re-read a snapshot, which is the recovery path, on an ordinary
event. This decision amends ADR-0011's clause so the patch carries what the
projection produced:

```ts
export type MirrorAlias = { readonly nativeId: string; readonly contactId: string };

export interface WhatsAppPatch {
  // …
  readonly aliases?: readonly MirrorAlias[];
}

export type MirrorDelete = {
  readonly type: "contact";
  readonly contactId: string;
  readonly freedNativeIds?: readonly string[];
};
```

Accepted source remains append-only, and the revocation and
authoritative-replacement restrictions in ADR-0019 still hold. Only the projected
patch grows.

## Considered options

- **Reconstructing coherence in each client**: rejected, and empirically so. Two
  implementations tried; the retry loop is livelock-prone, the alias rebuild is
  O(n) on every contact change and cannot be correct from patches alone, and the
  un-orderable live frame produced a publication path outside the client's own
  transition boundary. All three defects were fixed above the layer that caused
  them and all three recurred.
- **An `atRevision` parameter on each existing read**: rejected. It makes every
  caller responsible for threading a revision between calls and for deciding what
  to do when the requested revision has been compacted away, which is the same
  reconciliation burden with more surface. A transaction expresses "these reads
  agree" without naming a number.
- **Keeping one frame union and tagging live frames as unordered**: rejected. A
  consumer still receives them on the ordered channel and must branch, which is
  exactly the special case that stayed defective across all eight review rounds
  of the retired work.
- **Deferring these to after the Client ships**: rejected. Each one removes a
  mechanism the Client would otherwise have to contain, and the reviewable size
  of that Client is the measured cause of two failures.
