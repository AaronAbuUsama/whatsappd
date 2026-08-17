# Contributing

## From a fresh clone

```bash
pnpm install
pnpm test
```

`pnpm install` is the whole setup. It runs `prepare` (`vp config`), which points
`core.hooksPath` at `.vite-hooks/` so the pre-commit hook is live from the first
commit, and it downloads pnpm 11.10.0 itself if your shell has a different one —
`devEngines.packageManager.onFail` is `download`.

Node 20 or newer is required; CI runs 22 and 24. There is no database to start,
no service to run, and no credential to obtain: the default backend is in-memory
and the test suite never contacts WhatsApp.

To see a pairing flow end to end without linking anything:

```bash
pnpm example:pair --demo
```

That serves the pairing screen on 127.0.0.1 and walks every status it can
render — QR, scanned, syncing, a dropped connection, unlinked — with no socket
and no account. The QR it shows is synthetic and says so on the screen, because
a code that looks right and silently fails to scan is worse than no code.

There is no dev server. This is a library, so the equivalent inner loop is
`pnpm dev` (`vp pack --watch`) if you want the built artifact rebuilt as you
edit, or a test file run directly:

```bash
node --experimental-strip-types --test packages/whatsappd/tests/pacer.test.ts
```

## Exercising it by hand

The deterministic driver runs the real awaited subscription contract without an
account, sleeps, or a network:

```ts
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";

const test = createTestWhatsAppSession();
test.session.subscribe({
  async message(_message, { reply }) {
    await reply("Received");
  },
});
await test.emit({
  type: "message",
  message: textMessage({ id: "m1", chatId: "person@s.whatsapp.net", text: "Hello" }),
});
console.log(test.commands.sent);
```

Real-account work is task-specific and never runs in CI. Read
`docs/runbooks/development/real-account-testing.md` before creating a temporary
program: this machine holds real conversations and sends are allowlisted.

## Before you open a pull request

```bash
pnpm check         # format, lint, and type-check
pnpm test
pnpm docs:build
pnpm registry:test
pnpm check:docs    # every path and script name the agent docs cite still exists
pnpm check:unused  # unused files, exports, and dependencies
pnpm build
pnpm test:pack     # builds, packs, and inspects the tarball a consumer receives
```

CI runs these core gates on Node 22 and 24, plus renderer, coverage, and package-size proofs.

The size and shape limits in `vite.config.ts` are set just above what the
codebase already contains, so they bind the next file rather than demand a
refactor of the current one. Where a file is over, the exception names it with
its measured value instead of switching the rule off — `packages/whatsappd/src/runtime/libsql.ts`
is capped at 1500 lines, not exempted. If your change needs a limit raised, say
why in the PR; the number moving is the point at which someone decides.

Complexity is deliberately looser at the protocol boundary. `toInbound`,
`context`, and `transition` are exhaustive switches over a closed protocol
union, where the branch count _is_ the specification, and splitting them hides
which cases are handled. `pnpm check --fix` also runs on staged
files at commit time, so formatting is usually already settled.

Add a changeset for anything a consumer would notice:

```bash
pnpm changeset
```

Patch for a fix, minor for a new surface. A PR that changes only tests, docs, or
CI needs none.

## Conventions

**Naming.** Files are `kebab-case.ts` — `file-media.ts`, `store-conformance.ts`.
Package tests and packed-consumer checks live beside their package under
`packages/<name>/tests/` and `packages/<name>/smoke/`. Repository-only scripts
live in `.github/scripts/`. `pnpm test` runs every `*.test.ts` in those owned
locations.

Types and classes are `PascalCase`, values and functions `camelCase`, and
capability constructors read as the thing they return — `fileStore()`,
`memoryBackend()`, `libsqlBackend()`, `fileMediaStore()`.

**Domain language.** `CONTEXT.md` is the vocabulary, and it lists the words to
avoid alongside the ones to use — "WhatsApp Address" rather than "identity",
"Account Lease" rather than "advisory lock". Naming a concept off-vocabulary is
the kind of thing review will ask you to change, so it is cheaper to check
first. Decisions already settled live in `docs/adr/`; if your change argues with
one, the ADR is the thing to change first.

**Module boundaries.** `packages/whatsappd/src/model/` is pure domain types and depends on nothing
below it. `packages/whatsappd/src/runtime/` builds on the model. `packages/whatsappd/src/baileys/` is the only place
that knows the wire protocol. The dependencies run one way — model, then
runtime, then baileys — and lint enforces it.

**Comments.** The ones in this codebase explain why a line resists an obvious
simplification, usually citing the defect that made it necessary. Comments that
restate the code get deleted; a comment that argues with the code below it is a
defect in its own right.

## Running it in production

`docs/runbooks/` holds the operational procedures: session faults, a stuck
account lease, libSQL recovery, credential rotation, and releasing. They are
written for whoever is holding the pager, and they start from the fault
disposition table — `retryable`, `logged_out`, `suspended` — because acting
against the disposition is the most common way to make an incident worse.

## Issues

Issues are the only intake surface — pull requests are for implementation and
review (`docs/runbooks/development/issue-tracker.md`). New issues open at `needs-triage`; the
maintainer moves them to `ready-for-agent`, `ready-for-human`, or `needs-info`
(`docs/runbooks/development/triage-labels.md`).

Never paste real WhatsApp data into an issue. Phone numbers, message text, and
credential files identify people who did not file it.

## If an agent is doing the work

`AGENTS.md` is the entry point. GitHub Issues are the source of truth for work
and `pnpm state` prints the current dependency frontier.
