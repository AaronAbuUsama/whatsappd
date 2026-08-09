# Runbook: a scheduled check is failing

**Symptom:** an issue labelled `scheduled-failure` was filed, or a nightly or
weekly workflow is red.

Unlike every other runbook here, this one is about the repository rather than a
production worker. It exists because scheduled failures have nobody waiting on
them: a red pull request is noticed in minutes, and a nightly job that starts
failing is noticed in months.

## What files these

`.github/workflows/failure-alert.yml` watches the two scheduled workflows and
opens an issue when one fails on its schedule. It files one issue per workflow
and comments on it thereafter, so a job failing all week is one thread and not
seven issues. It deliberately ignores pull-request failures, which already have
a reviewer attached.

## 1. Decide which kind of failure it is

| Workflow               | What a failure means                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `Flaky test detection` | The suite disagreed with itself across ten runs of unchanged code |
| `CodeQL`               | A security query matched, or the scan itself broke                |

The distinction matters because only one of them is about the code as written.

## 2. Flaky test detection

The job runs `pnpm test` ten times on both Node versions and fails if any run
disagrees. Because every run executes identical code, a mixed result is by
definition a flaky test rather than a broken one.

The failing runs are kept as `flaky-run-logs-node*` artifacts on the workflow
run, retained for 14 days. Download them and compare a failing log against a
passing one from the same job — the difference is the test that is not
deterministic.

Reproduce locally before changing anything:

```sh
for i in $(seq 1 20); do pnpm test >"run-$i.log" 2>&1 || echo "run $i failed"; done
```

Twenty runs locally is a reasonable substitute for ten in CI, which is slower
and more contended.

The usual causes, in the order they are usually found:

- A test asserting on wall-clock timing rather than on an awaited signal.
- Shared state between tests — a temporary database or directory reused rather
  than created per test.
- An unawaited promise, where the assertion races the work it describes.

**Do not fix this by adding a retry.** Retrying makes flakiness survivable,
which is how it becomes permanent; the workflow has no retry for that reason.
If a test cannot be made deterministic, deleting it is better than leaving a
test whose result nobody trusts.

## 3. CodeQL

Findings appear under the repository's **Security → Code scanning** tab, not in
the workflow log. The issue is the notification; the alert is the detail.

Triage each alert as one of:

- **A real defect.** Fix it, and add a test if the defect is reachable from a
  message body or a credential path.
- **A false positive.** Dismiss it in the Security tab with a reason. Dismissing
  in the UI is what keeps it dismissed; a comment in the code does nothing.

If the scan itself failed rather than finding something — a timeout, or a build
error inside the action — check whether `security-extended` is still resolving
and whether the workflow's `security-events: write` permission survived an edit.

## 4. If the alert itself is wrong

`failure-alert.yml` matches workflows by display name. Renaming the `name:` of
a workflow without updating the `workflows:` list in the alert silently stops
the alerting — the alert workflow keeps passing and simply never fires, which
is the worst failure mode available to it.

To confirm the wiring is live, run the flake detector manually with a deliberate
failure, or check that the last scheduled run appears under **Actions**.

## Related

- [`release.md`](../delivery/release.md) — a release that failed halfway
- [`session-faults.md`](session-faults.md) — a production session, not CI
