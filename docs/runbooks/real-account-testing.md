# Real-account testing

Two real WhatsApp accounts are linked on the development machine, and any agent
can bring either one online without a human. This describes what they are, how
to use them, and — the part that matters more — what must never be sent from
them.

> [!CAUTION]
> One of these accounts holds **hundreds of real conversations with real
> people**. A send to the wrong chat id is a message from the owner's own number
> to someone who did not ask for it, and it cannot be recalled. Read
> "What may be messaged" before writing anything that sends.

## The profiles

Each profile is one linked device: its own libSQL database, its own media root,
its own credentials, under the gitignored `.proof-private/`.

| Profile   | Primary phone      | Role                                                                       |
| --------- | ------------------ | -------------------------------------------------------------------------- |
| `android` | Samsung Galaxy S25 | **Subject.** Small mirror. Use this for anything that publishes a receipt. |
| `ios`     | iPhone             | **Peer.** Large mirror of real correspondence. Sends only.                 |

They are separate accounts on separate numbers, and both are members of one
shared group, so both direct messages and group behaviour can be exercised.

`android` is the subject because its mirror is small enough to assert against,
and because a proof whose fixtures are someone's actual message history is one
nobody can safely publish a receipt for.

## Bringing one online

```bash
pnpm proof:profile android
```

The profile is already linked, so this resumes — no QR, no phone, a few seconds.
It prints counts and exits. `pnpm proof:profile ios` does the same for the peer.

Pairing happens only if a profile's database has no credentials, which on this
machine means someone deleted it. `libsqlBackend()` persists credentials and
`createWhatsAppRuntime` hands that store to the session
(`packages/whatsappd/src/runtime/runtime.ts:714`), so the link survives with the database file.

**Never delete a profile directory to "start clean".** That throws away the link
and costs a human a QR scan. Proofs that need an unlinked start create their own
throwaway profile — see #111's Run B.

One runtime owns one account (ADR-0009). Two processes against one profile is a
lease conflict, not a shortcut; drive the peer as its own process.

## What may be messaged

Nothing in this repository sends yet. `tests/proof-profile.ts` links, reads and
exits, and `client.messages.send` is #108. The first code that can send is
#127's harness, and **it is specified to enforce this list rather than document
it.**

Sends are permitted to exactly three destinations:

1. the shared test group both accounts belong to;
2. the other proof account — `android` → `ios` or the reverse;
3. the owner's own designated test number.

Everything else is prohibited, including any chat that merely looks like a test
chat. The `ios` mirror alone contains several groups with "test" in the subject
that are **not** the sanctioned one; matching on a subject string is how a
message reaches strangers.

### The allowlist is a file, not a sentence

The sanctioned ids are real WhatsApp identifiers, so they are never committed.
They live beside the profiles:

```
.proof-private/send-allowlist.json
{ "groups": ["<group id>"], "chats": ["<chat id>", "…"] }
```

Anything that sends resolves its target against that file and **refuses** a
target that is not in it. A missing file means no sends are possible, which is
the correct failure: a harness that cannot find its allowlist has not been set
up, and guessing is exactly the behaviour this prevents.

This is deliberately not a rule an author has to remember.
`docs/client-stack-defect-ledger.md` C10 records why: an obligation is missed
when the correct path costs more to type than the incorrect one, and a firmer
sentence in a document never changes that. A `chatId` typed from a mirror read
is the cheap wrong path here, so the guard belongs where the send happens.

## Redaction

The profiles hold real account material. Nothing derived from them —
no phone number, JID, group id, message body, media byte, credential, QR or
pairing code — enters a command, a log, a commit, a GitHub comment or a receipt.
Committed receipts carry hashes, counts and lengths only.

`.proof-private/` is gitignored (`.gitignore:10`). Keep it that way; it is the
only thing standing between a real account's credentials and a public
repository.

## When something is wrong

| Symptom                                       | Where to go                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A profile asks for a QR when it should resume | [`credential-rotation.md`](credential-rotation.md) — the credentials are dead or the database moved |
| `AccountAlreadyClaimedError`                  | [`stuck-account-lease.md`](stuck-account-lease.md) — another process holds it                       |
| The database is locked or corrupt             | [`libsql-recovery.md`](libsql-recovery.md)                                                          |
| Online, but the mirror looks incomplete       | #140 — a parked app-state collection reports `online` with state it never received                  |
