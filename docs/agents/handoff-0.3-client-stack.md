# Handoff — 0.3 Client stack, after #106 merged

Written 2026-08-04, immediately after PR #125 merged. Read this whole file
before touching anything. It exists because the previous session found that the
repository's own specifications disagree with the code in several places, and an
executor who trusts them will build the wrong thing.

## Where things actually are

`master` is at the merge of PR #125. `pnpm test` = 408 pass, `pnpm check` clean,
`pnpm build` / `proof:pack` / `audit --prod` green, CI green on Node 22 and 24.

Merged in the last day:

- **#123** — amended ADR-0023, ADR-0029, `CONTEXT.md` and two planning docs to
  retire the `chats.open(chatId)` conversation handle.
- **#106 / PR #125** — built `client.messages`, the fifth Client namespace.

## What `client.messages` actually is

The whole public shape, on `master` today:

```ts
readonly messages: ClientNamespace & {
  get(chatId: string): ClientChatMessages;   // what is held; never touches storage
  older(chatId: string): void;               // read one page further back
};
```

and what a consumer writes (this compiles against `master`):

```ts
render(client.messages.get(chatId).messages);
const off = client.messages.subscribe(() => render(client.messages.get(chatId).messages));

client.messages.older(chatId); // first load AND scroll-up
onScrollTop(() => client.messages.older(chatId));

const view = client.messages.get(chatId);
if (view.older === "loading") render("spinner");
if (view.older === "exhausted") render("no older messages saved");
if (view.error) render("that read failed, tap to retry");

off();
await client.close(); // nothing per-chat to close
```

There is no `open()`, no conversation object, no per-chat `close()`. That design
was **never implemented** — `git log --all -S "chats.open" -- src/` returns
nothing. It was retired on paper before code existed.

## The one thing that is not true yet

**`createWhatsAppClient` is not exported from `src/index.ts`.** Count is zero.
Nobody who installs the package can use any of the above. #107 is what makes it
reachable. Until then the friendly Client is source-only.

## Failure modes found while building it — do not re-learn these

All are recorded in `docs/client-stack-defect-ledger.md` with reproductions. The
short version, because the ledger is long:

1. **An operation's lifecycle stored as a value instead of modelled as a type.**
   `older` was a string field with a `"loading"` member. A page read ends five
   ways (returns rows / read rejects / applying rows throws / Client closes /
   following fails) and each ending had to _remember_ to retract the claim **and**
   remember to announce the retraction. Three review rounds; the first fix caused
   two of the second round's defects. Closed by a `PageLanding` union with a
   member per ending, so a sixth is a compile error.
2. **Correcting state without publishing it.** A fix that wrote the right value
   beside `commit` rather than through it satisfied a poller and left every
   `useSyncExternalStore` binding on the stale snapshot for ever. Correcting and
   announcing are two obligations; both were missed independently.
3. **Tests that assert properties their own setup made unreachable.** Three
   tracers seeded fewer messages than one 25-row store page, so the entry was
   already `exhausted` and the gated read issued **zero** reads. Every assertion
   after the gate passed on untouched state.
4. **A mutation audit inherits the blind spot of whoever chose the mutations.**
   Round 2's set came from the replan's own decision points, so it proved the new
   shape and not the loop that shape runs in — `stopped()` ending only the _first_
   in-flight read passed 406 tests.
5. **Applying mutations by line number while the diff is moving.** Two landed on
   the wrong lines and reported green as evidence of an unfalsifiable `own()`.
   Match on content.

**Working rule that came out of it:** count findings by root cause _before_
fixing any. If ≥2 share a property, the fix is structural — make the wrong path
a compile error — not a guard at each known site.

Three properties are recorded as structurally unprovable in the ledger's own
table. They are correct in code and cannot be pinned by a test; the reasons are
written there. Do not "fix" them by weakening a test.

## The work, in order

### Phase 1 — repair the specifications. Nothing gets dispatched until this is done.

The repository currently argues with itself. Every item below is a case where a
document or issue still teaches the retired handle.

**1a. #124 — already filed and correctly scoped.** It lists ~30 references in
`docs/sdk-capabilities.md` plus `contracts.ts` TSDoc, the architecture document,
`README.md`, a changeset and ADR-0029's residue, with a suggested order. Verified
against `master`: the four `contracts.ts` TSDoc comments (`:281`, `:342`, `:499`,
`:746`) are still there, `README.md`'s "Opening a conversation" line is still
there, the architecture document still has `<Conversation.Root>` /
`loadOlderSaved`, and `sdk-capabilities.md` has **37** matching lines. One item
is now done: `client.ts`'s "belongs to an opened conversation" no-op comment was
replaced by #106. **Execute #124 as written; do not re-scope it.**

**1b. `docs/sdk-capabilities.md:10` says "Live WhatsApp account: not run".**
That is false — `.proof-receipts/` holds two P4 receipts from 3 August
(`issue18-p4.run1-b06fa2f.json`, `issue18-p4.run2-ea53648.json`). `CONTEXT.md`
defines `not-run` as meaning exactly that. **Not covered by #124** — #124 is the
handle sweep. Fix the verification block to say what has actually been run, at
what layer, and what has not.

**1c. #107's body has three defects.** It is the next node on the DAG and it is
**not safe to dispatch as written**:

- Its "Plain-English outcome" — the first thing an executor reads — is a code
  sample using `client.chats.open(chatId)` and `conversation.close()`. Twenty
  lines later the same issue says the handle was dropped. Unlike #108 and #111 it
  carries **no banner**.
- Acceptance criterion _"No packed declaration named `WhatsAppClient` carries
  `watch` or `messages`"_ **cannot be satisfied by a correct implementation.**
  #107 renames the friendly Client to `WhatsAppClient`, and the friendly Client
  has a `messages` namespace. The criterion's intent was to catch the _raw_ type
  surviving under the new name; the raw one is identifiable by `watch()`. Rewrite
  it against `watch`, or against the shape.
- It cites `WhatsAppClientCore` at `src/runtime/client.ts:278`. It is at **407**;
  #106's merge moved it. (`contracts.ts:738` and `index.ts:55-106,96` are still
  exact.)

**1d. #108 and #111 already carry `[!IMPORTANT]` banners** saying their action
surface is superseded and "nothing below that names `conversation.*` is
executable as written". #111's live matrix still literally calls
`conversation.send.text()` at step 7 and "the opened friendly conversation" at
step 5. Both need re-specifying against `client.messages.*` **at their own
dispatch**, which is what their banners already instruct.

### Phase 2 — prove the Client against a real phone, before packaging it

**This is a deliberate reordering of the DAG, agreed with the owner on
2026-08-04.**

The DAG currently runs #107 (package it, name it, write the README, prove a
consumer can install the tarball) → #108 → #109 → #111 (first real phone). That
means naming and publishing an API that has never received a real WhatsApp
message. If the real-phone run finds the shape wrong, the README, the naming cut
and the packaging proof are all rework.

The **full** #111 genuinely cannot run first — it needs pairing (#109) and sends
(#108). But the **read path** needs neither. Create a new issue:

> **A real-account read-path smoke test, runnable on `master` today.**
> Link a real authorised test account with the existing harness; compose
> `fileMediaStore + libsqlBackend -> WhatsAppRuntime -> createWhatsAppClient`;
> receive a text and one attachment from a test peer; assert they appear through
> `client.chats.list()` and `client.messages.get(chatId)`; page back with
> `client.messages.older(chatId)`; close in application-owned order; start a new
> process against the same files and assert the durable state reconstructs and no
> live presence/connection does.
> Explicitly **not** covering sends, pairing-as-a-feature, or unlink.
> Make #107 blocked by it.

**Harness assessment — extend, do not rebuild.**

- `tests/proof.ts` (115 lines) drives **only** `createSession` from the root
  entry. It never touches Runtime, libSQL, media or the Client. Reusable: its QR
  and pairing-code ergonomics, its logging, and `replyToProofPing`.
- `tests/history-proof-receipt.ts` (245 lines) is the sanitised, append-only,
  refuses-on-dirty-tree receipt writer that produced both existing P4 receipts.
  **Reuse it directly.** It is the proven part.
- `tests/history-proof.ts` (656 lines) is the #18 research harness.
- Nothing currently composes `libsqlBackend -> Runtime -> friendly Client`. That
  is the new code, and it is small. #111 says the same thing about itself.

All the safety rules in #111's "Human prerequisite and safety boundary" section
apply unchanged: an explicitly authorised account, no phone number or JID in any
command, log, comment or receipt, and separate explicit permission before
anything destructive.

### Phase 3 — then the existing chain

7. **#107** — the public cut (after 1c and Phase 2).
8. **#108** — sends. Re-spec first, per its banner.
9. **#109** — pairing and unlink.
10. **#111** — the full real-account proof. Re-spec first, per its banner.
11. **#119** — blocks #112 and is only `needs-triage`. Someone must specify it
    before the release gate can move; nothing will surface that until #112.
12. **#112** → **#113** — release candidate, then publish.

Open but not blocking: **#121** (message retention is unbounded — the code that
grows without limit is now on `master`, so this stopped being hypothetical) and
**#126** (audit every operation whose lifecycle is stored as a value rather than
modelled as a type — the generalisation of failure mode 1 above; it lists 15
candidate sites, and flags `runtime.ts:382-385` as the highest value because it
holds four in-flight markers in one scope around the account lease).

## Standing constraints

- `docs/agents/frontier-execution.md` governs unattended runs and is mandatory.
- The GitHub Codex reviewer is **disabled**. Reviews run as independent
  fresh-context local agents — precedent recorded on PR #116 and again in the
  ledger's #106 section. Three lenses in round 1 is the pattern that worked.
- Four-round ceiling per PR; the numeric counter restarts per PR, the ledger does
  not.
- An issue body is not edited in response to a review finding mid-lane
  (`frontier-execution.md:125-138`). Editing a body _before_ dispatch, to correct
  a spec that contradicts merged code, is a different thing and is what Phase 1 is.
- `docs/sdk-capabilities.md` calls itself "human-maintained". No human wrote it.
  Treat it as agent-maintained and therefore capable of being wrong — and fix it
  when it is, rather than routing around it.
