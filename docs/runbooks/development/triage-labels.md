# Triage labels

The engineering skills use five canonical triage roles. This file maps those
roles to the labels configured in GitHub.

| Skill role        | GitHub label      | Meaning                                    |
| ----------------- | ----------------- | ------------------------------------------ |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the issue     |
| `needs-info`      | `needs-info`      | Waiting on the reporter                    |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation              |
| `wontfix`         | `wontfix`         | Will not be actioned                       |

When a skill refers to a role such as "AFK-ready," use the corresponding label
from this table.

`needs-grilling` remains an additional planning label for a focused
`/grill-with-docs` session. It is not a triage state and does not replace any
canonical role.
