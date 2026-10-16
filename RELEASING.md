# Releasing

Releases are automatic. `.github/workflows/release.yml` runs every hour (and on every push to `main`, and on demand). Each run:

1. Fetches the live spec from `https://api.sinatra.dev/openapi.json`. If it matches the committed `openapi.json` and nothing was committed since the last `vX.Y.Z` tag, the run stops there.
2. Writes the live spec to `openapi.json` and regenerates `src/generated`.
3. Typechecks, builds, and runs the unit tests, the contract tests against `prism mock openapi.json`, the `next-version.sh` tests, the package checks and the smoke test.
4. Computes the version with `scripts/next-version.sh` (`oasdiff` decides whether the spec change is breaking, additive or neither) and writes it to `package.json`. With no tag yet, the version is `0.1.0`.
5. Publishes to npm with provenance, through trusted publishing (no npm token is stored anywhere).
6. Commits `openapi.json`, `src/generated` and the version as `chore(release): vX.Y.Z`, tags `vX.Y.Z`, pushes both, and creates a GitHub release whose notes are the `oasdiff` changelog.

Steps 5 and 6 run only when the repository variable `PUBLISH_ENABLED` is `true`, the run is on `main`, and it isn't a dry run. Otherwise the run ends after step 4 with a notice saying which version it would have released, and succeeds. Any failure fails the run before anything is tagged. Runs never overlap (concurrency group `release`).

If a run publishes and then fails to push its tag, the next run sees the version already on npm, skips the publish and finishes the commit, tag and release.

## One-time setup

npm can only attach a trusted publisher to a package that already exists, so the very first publish is done by hand. It publishes version `0.0.0`, which is what `package.json` says before the first release; the workflow then publishes `0.1.0` itself.

1. Build and publish the bootstrap version from a clean checkout, logged in to npm as an owner of the `sinatra-dev` org:

   ```sh
   git clone https://github.com/sinatra-dev/sinatra-node.git
   cd sinatra-node
   npm ci
   npm run build
   npm login
   npm publish --access public
   ```

   `npm publish` publishes the built `dist/` (the only directory in `files`), as `@sinatra-dev/sdk@0.0.0`. Check with `npm pack --dry-run` first if you like.

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

5. Start a release instead of waiting for the hourly run, then check it:

   ```sh
   gh workflow run release.yml --repo sinatra-dev/sinatra-node
   gh run watch --repo sinatra-dev/sinatra-node
   npm view @sinatra-dev/sdk version   # 0.1.0
   ```

6. Mark the bootstrap version so nobody installs it:

   ```sh
   npm deprecate @sinatra-dev/sdk@0.0.0 "Bootstrap publish. Use 0.1.0 or later."
   ```

To stop releases at any time, set `PUBLISH_ENABLED` to anything but `true`.

## Dry runs

On GitHub, run the workflow with `dry_run` set: every step runs except publish, commit and tag.

```sh
gh workflow run release.yml --repo sinatra-dev/sinatra-node -f dry_run=true
```

Locally, the same steps run with `scripts/release.sh`. `plan` rewrites `openapi.json` and `version` rewrites `package.json`, so do this in a scratch clone, or reset afterwards with `git checkout -- openapi.json src/generated package.json package-lock.json`:

```sh
npm ci && npm run tools
bash scripts/release.sh plan        # SPEC_FILE=path/to/spec.json to use a local spec
npm run generate && npm run typecheck && npm run build
npm test && npm run test:contract && npm run test:version
bash scripts/release.sh version     # prints the version and the release notes
DRY_RUN=true bash scripts/release.sh publish   # prints the notice, publishes nothing
```

## Tools

The generator (`@hey-api/openapi-ts`), Prism (`@stoplight/prism-cli`) and the build tools are pinned to exact versions in `package.json`. `oasdiff` is pinned, with checksums, in `scripts/install-oasdiff.sh`. Bumping the generator usually changes `src/generated`; regenerate and commit in the same change, or CI fails the drift check.

`scripts/next-version.sh` is shared byte for byte with `sinatra-python` and `sinatra-go`. Change it in all three.

GitHub turns off scheduled workflows in a public repository after 60 days without activity. If releases stop, re-enable the workflow on the **Actions** tab.
