# Runbook: releasing

## Publishing a version

1. **Version the pending changesets.**

   ```bash
   pnpm changeset version   # consumes .changeset/*.md, bumps package.json, writes CHANGELOG.md
   git commit -am "Release <version>"
   ```

2. **Tag and push.** The `Release` workflow triggers on `v*` tags.

   ```bash
   git tag v<version>
   git push origin master --tags
   ```

3. **Watch the run.** It re-runs `check`, `test`, `build`, and `test:pack` on
   the publishing commit before publishing, then packs `dist/` and publishes
   with `--provenance`.

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

## Why `test:pack` runs in the release, not just in CI

`pnpm pack` archives whatever `dist/` already holds. Without a build inside the
release job, the tarball reaching npm would be the one artifact the packed check
never inspected — the check would guard pull requests and not releases (#119).
It runs on the publishing commit, so the artifact is checked on the exact commit
that publishes it.

If you are tempted to skip it to get a release out faster: that is the failure
it was added to prevent.

## The release failed

**Before the publish step.** Nothing was published. Fix and re-tag — but delete
the old tag first, or the new one will not point where you think:

```bash
git tag -d v<version> && git push origin :refs/tags/v<version>
```

**At the publish step.** Check whether it actually landed:

```bash
npm view whatsappd@<version> version
```

The workflow is idempotent — it skips publishing a version already on npm — so
re-running a partially failed release is safe and will not error on the
duplicate.

**Published something broken.** npm publishes are effectively permanent;
unpublishing is restricted and breaks consumers who already installed. Publish a
fixed patch version instead. Deprecate the bad one so installers are warned:

```bash
npm deprecate whatsappd@<version> "Broken: <what>. Use <fixed version>."
```

## Provenance

The workflow publishes with `--provenance` using OIDC (`id-token: write`), so
there is no long-lived npm token stored in the repository. If publishing starts
failing with an auth error, check that the workflow still has `id-token: write`
and that the npm package's trusted-publisher settings still name this
repository — not that someone needs to add a token.
