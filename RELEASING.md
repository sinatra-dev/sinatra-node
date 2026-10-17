# Releasing

Releases are automatic. `.github/workflows/release.yml` runs every hour, on every push to `main`, and on demand. It has three jobs, each with only the access it needs:

1. **build** (read-only token, no stored git credentials). Fetches the live spec from `https://api.sinatra.dev/openapi.json`. If it matches the committed `openapi.json` and no release-worthy commit landed since the last `vX.Y.Z` tag, the run stops there. Release-worthy means touching `src/`, `package.json`, `openapi-ts.config.ts`, `tsup.config.ts` or `tsconfig.json`; docs, CI and test-only commits wait for the next release. Otherwise it writes the live spec to `openapi.json`, regenerates `src/generated`, typechecks, builds, and runs the unit tests, the contract tests against `prism mock openapi.json`, the `next-version.sh` tests, the package checks and the smoke test. It then computes the version with `scripts/next-version.sh` (`oasdiff` decides whether the spec change is breaking, additive or neither; with no tag yet it's `0.1.0`), commits the release locally, and packs the package. The tarball, the release commit (as a git bundle) and the release notes are uploaded as the run's `release` artifact.
2. **publish** (npm OIDC token only, installs nothing). Refuses if `main` moved since the build. Otherwise it publishes the tarball to npm with provenance, through trusted publishing (no npm token is stored anywhere).
3. **tag** (write token only, installs nothing). Pushes the release commit (`chore(release): vX.Y.Z`, with `openapi.json`, `src/generated` and the version) and the `vX.Y.Z` tag to `main` in one atomic push, then creates the GitHub release, whose notes are the `oasdiff` changelog.

**publish** and **tag** run only when the repository variable `PUBLISH_ENABLED` is `true`, the run is on `main`, and it isn't a dry run. Otherwise **build** ends with a notice saying what a real run would release, and the run succeeds. Runs never overlap (concurrency group `release`).

## When something fails

- **build fails** (the spec can't be fetched, the regenerated code doesn't compile, a test fails): nothing is published or tagged. Every later run fails the same way until the cause is fixed, for example by updating the wrapper for an operation the API removed.
- **publish refuses because `main` moved**: nothing is published. The push to `main` already started the run that releases the new `main`.
- **publish fails at npm**: nothing is tagged. The next run retries.
- **tag fails after publish**, for example when its push is rejected: npm now has `vX.Y.Z` with no tag. On the next run, if `main` hasn't changed, it rebuilds the same tarball, sees the same `dist.shasum` on npm, skips the publish and pushes the tag. If `main` has changed, the rebuild differs, and publish fails on every run with `already on npm with shasum ...`, rather than tagging code that was never published. Recover as below.
- **the GitHub release fails after the tag was pushed**: the next run notices the tag without a release and creates it.

### A run failed after publishing

When publish keeps failing with `@sinatra-dev/sdk@X.Y.Z is already on npm with shasum A, but this build packs B`, an earlier run published `X.Y.Z` and never pushed its tag. Tag the commit it published from its artifact (kept for 90 days):

```sh
# The run whose tag job failed, the first one that published X.Y.Z:
gh run list --workflow release.yml --repo sinatra-dev/sinatra-node
gh run download <run-id> --name release --dir ./release-state --repo sinatra-dev/sinatra-node

# Check that it's the one npm has: the two shasums must match.
cat release-state/shasum
npm view "@sinatra-dev/sdk@$(cat release-state/version)" dist.shasum

# Tag the commit that was published, and push only the tag.
git fetch ./release-state/release.bundle HEAD
v="v$(cat release-state/version)"
git tag -a "$v" FETCH_HEAD -m "$v"
git push origin "$v"
```

The tag points at a commit that isn't on `main`, which is fine: releases count the highest `vX.Y.Z` tag, wherever it is. The next run creates that tag's GitHub release and releases `main` as the next version.

## One-time setup

npm can only attach a trusted publisher to a package that already exists, so the very first publish is done by hand. It publishes version `0.0.0`, which is what `package.json` says before the first release; the workflow then publishes `0.1.0` itself.

1. Build and publish the bootstrap version from a clean checkout, logged in to npm as an owner of the `sinatra-dev` org:

   ```sh
   git clone https://github.com/sinatra-dev/sinatra-node.git
   cd sinatra-node
   npm ci
   npm login
   npm publish --access public --provenance=false
   ```

   `npm publish` builds first (the `prepack` script) and publishes `dist/` (the only directory in `files`), as `@sinatra-dev/sdk@0.0.0`. `--provenance=false` is needed because `package.json` asks for provenance, which npm can only produce in CI: a local `npm publish` without it stops with `EUSAGE: Automatic provenance generation not supported`. Run `npm pack --dry-run` first to see the files.

2. On npmjs.com, open the package: **@sinatra-dev/sdk → Settings → Trusted Publisher → GitHub Actions**, and enter:

   - Organization or user: `sinatra-dev`
   - Repository: `sinatra-node`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   Save. Then, under **Publishing access** on the same page, choose **Require two-factor authentication and disallow tokens**: the workflow doesn't need a token.

3. Check that GitHub Actions may push to `main`: no branch rule or ruleset may block `github-actions[bot]` from pushing commits and `v*` tags.

4. Set the repository variable that opens the gate:

   ```sh
   gh variable set PUBLISH_ENABLED --body true --repo sinatra-dev/sinatra-node
   ```

   (or **Settings → Secrets and variables → Actions → Variables → New repository variable**).

5. Start a release instead of waiting for the hourly run, watch it, then check npm:

   ```sh
   gh workflow run release.yml --repo sinatra-dev/sinatra-node
   sleep 10   # the run takes a moment to appear
   gh run watch --repo sinatra-dev/sinatra-node \
     "$(gh run list --workflow release.yml --event workflow_dispatch --repo sinatra-dev/sinatra-node --limit 1 --json databaseId --jq '.[0].databaseId')"
   npm view @sinatra-dev/sdk version   # 0.1.0
   ```

6. Mark the bootstrap version so nobody installs it (npm asks for your one-time password):

   ```sh
   npm deprecate @sinatra-dev/sdk@0.0.0 "Bootstrap publish. Use 0.1.0 or later."
   ```

To stop releases at any time, set `PUBLISH_ENABLED` to anything but `true`.

## Dry runs

On GitHub, run the workflow with `dry_run` set: **build** runs in full, and **publish** and **tag** are skipped.

```sh
gh workflow run release.yml --repo sinatra-dev/sinatra-node -f dry_run=true
```

Locally, **build**'s steps run with `scripts/release.sh`. They rewrite `openapi.json` and `package.json` and make a local release commit, so use a scratch clone:

```sh
git clone https://github.com/sinatra-dev/sinatra-node.git /tmp/sinatra-node-dry-run && cd /tmp/sinatra-node-dry-run
npm ci && npm run tools
bash scripts/release.sh plan        # SPEC_FILE=path/to/spec.json to use a local spec; needs gh auth
npm run generate && npm run typecheck && npm run build
npm test && npm run test:contract && npm run test:version
bash scripts/release.sh version     # prints the version and the release notes
bash scripts/release.sh pack        # release commit + tarball in release-state/
DRY_RUN=true bash scripts/release.sh gate
```

Don't run `publish` or `tag` locally: they publish to npm and push to GitHub.

## Tools

The generator (`@hey-api/openapi-ts`), Prism (`@stoplight/prism-cli`) and the build tools are pinned to exact versions in `package.json`. `oasdiff` is pinned, with checksums, in `scripts/install-oasdiff.sh`. Bumping the generator usually changes `src/generated`; regenerate and commit in the same change, or CI fails the drift check.

`scripts/next-version.sh` is shared byte for byte with `sinatra-python` and `sinatra-go`. Change it in all three.

GitHub turns off scheduled workflows in a public repository after 60 days without activity. If releases stop, re-enable the workflow on the **Actions** tab.
