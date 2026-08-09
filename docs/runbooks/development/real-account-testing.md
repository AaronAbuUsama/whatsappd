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

Each profile is one linked device: its own libSQL database, media root, and
credentials. They live outside the repository at
`~/Library/Application Support/whatsappd/proofs/`.

| Profile   | Primary phone      | Role                                                         |
| --------- | ------------------ | ------------------------------------------------------------ |
| `android` | Samsung Galaxy S25 | **Subject.** Small mirror. Use this for bounded live checks. |
| `ios`     | iPhone             | **Peer.** Large mirror of real correspondence. Sends only.   |

They are separate accounts on separate numbers, and both are members of one
shared group, so both direct messages and group behaviour can be exercised.

`android` is the subject because its mirror is small enough to assert against.

## Bringing one online

There is no permanent live-account harness in the repository. A task that needs
a live check must supply a purpose-built program, accept the external profile
path explicitly, and delete that program when the task is complete.

**Never delete a profile directory to "start clean".** That throws away the
link and costs a human a QR scan. `libsqlBackend()` persists credentials, so a
program pointed at the existing database resumes without pairing.

One runtime owns one account (ADR-0009). Two processes against one profile is a
lease conflict, not a shortcut; drive the peer as its own process.

## What may be messaged

No current repository program sends from these accounts. Any temporary program
that can send must enforce this list at its send seam rather than relying on an
operator to remember it.

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
It lives beside the external profiles:

```
~/Library/Application Support/whatsappd/proofs/send-allowlist.json
{ "groups": ["<group id>"], "chats": ["<chat id>", "…"] }
```

Anything that sends resolves its target against that file and **refuses** a
target that is not in it. A missing file means no sends are possible, which is
the correct failure: a harness that cannot find its allowlist has not been set
up, and guessing is exactly the behaviour this prevents.

This is deliberately not a rule an author has to remember. A `chatId` typed
from a mirror read is the cheap wrong path, so the guard belongs where the send
happens.

## Redaction

The profiles hold real account material. Nothing derived from them — no phone
number, JID, group id, message body, media byte, credential, QR or pairing code
— enters a command, log, commit, or GitHub comment. Temporary sanitized output
belongs under ignored `.artifacts/` or in a short-lived CI artifact, never in
source control.

## When something is wrong

| Symptom                                       | Where to go                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A profile asks for a QR when it should resume | [`credential-rotation.md`](../operations/credential-rotation.md) — the credentials are dead or the database moved |
| `AccountAlreadyClaimedError`                  | [`stuck-account-lease.md`](../operations/stuck-account-lease.md) — another process holds it                       |
| The database is locked or corrupt             | [`libsql-recovery.md`](../operations/libsql-recovery.md)                                                          |
| Online, but the mirror looks incomplete       | #140 — a parked app-state collection reports `online` with state it never received                                |
