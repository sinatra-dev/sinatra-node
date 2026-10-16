#!/usr/bin/env bash
# The release steps that .github/workflows/release.yml runs, one per command.
# Each can be run locally for a dry run (see RELEASING.md).
#
#   scripts/release.sh plan     Fetch the live spec. Stop if it matches openapi.json
#                               and nothing was committed since the last tag;
#                               otherwise write it to openapi.json.
#   scripts/release.sh version  Compute the next version from the spec change, set
#                               it in package.json, write the release notes.
#   scripts/release.sh publish  npm publish.                          (gated)
#   scripts/release.sh tag      Commit openapi.json, src/generated and the version,
#                               tag vX.Y.Z, push, create the GitHub release. (gated)
#
# Between `plan` and `version` the workflow regenerates, builds and runs every
# test. The gated steps do nothing, and exit 0 with a notice, unless
# PUBLISH_ENABLED is "true" and DRY_RUN isn't "true".
#
# Environment:
#   SPEC_URL         the live spec (default https://api.sinatra.dev/openapi.json)
#   SPEC_FILE        read the spec from this file instead of SPEC_URL
#   DRY_RUN          "true": stop before publish, commit and tag
#   PUBLISH_ENABLED  "true": allowed to publish, commit and tag
#   RELEASE_BRANCH   the branch the release commit is pushed to (default main)
#
# State shared between the steps lives in .release/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."

PACKAGE=@sinatra-dev/sdk
SPEC_URL=${SPEC_URL:-https://api.sinatra.dev/openapi.json}
STATE=.release
PATH="$PWD/.tools/bin:$PATH"

die() {
  echo "release: $*" >&2
  exit 1
}
notice() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::notice title=release::$*"; else echo "notice: $*"; fi
}
warning() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning title=release::$*"; else echo "warning: $*" >&2; fi
}
output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >>"$GITHUB_OUTPUT"; fi
}
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat >>"$GITHUB_STEP_SUMMARY"; else cat; fi
}
canonical() { jq -S -c . "$1"; }
last_tag() { git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true; }

# The one gate for everything that leaves the runner.
gate_open() {
  if [ "${DRY_RUN:-false}" = "true" ]; then
    notice "Dry run: stopping before $1. Would release v$(cat "$STATE/version")."
    return 1
  fi
  if [ "${PUBLISH_ENABLED:-}" != "true" ]; then
    notice "PUBLISH_ENABLED isn't 'true': stopping before $1. Would release v$(cat "$STATE/version"). See RELEASING.md."
    return 1
  fi
  return 0
}

step_plan() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
  if [ -n "${SPEC_FILE:-}" ]; then
    cp "$SPEC_FILE" "$STATE/live.json"
  else
    curl -fsSL --retry 3 --retry-all-errors --max-time 60 -o "$STATE/live.json" "$SPEC_URL"
  fi
  jq -e '(.openapi | type == "string") and (.paths | type == "object")' "$STATE/live.json" >/dev/null ||
    die "the spec from ${SPEC_FILE:-$SPEC_URL} isn't an OpenAPI document"

  local tag
  tag=$(last_tag)
  echo "$tag" >"$STATE/last-tag"
  if [ -n "$tag" ]; then
    git show "$tag:openapi.json" >"$STATE/old.json"
  else
    cp openapi.json "$STATE/old.json"
  fi

  local spec_changed=true commits=none
  if [ "$(canonical "$STATE/live.json")" = "$(canonical openapi.json)" ]; then spec_changed=false; fi
  if [ -n "$tag" ]; then commits=$(git rev-list --count "$tag..HEAD"); fi

  if [ -n "$tag" ] && [ "$spec_changed" = false ] && [ "$commits" = 0 ]; then
    echo "Nothing to release: the live spec matches openapi.json and nothing was committed since $tag."
    output "skip=true"
    return 0
  fi

  # Keep the live document's key order; pretty-print so diffs stay readable.
  jq . "$STATE/live.json" >openapi.json
  echo "Releasing: last tag ${tag:-none}, spec changed: $spec_changed, commits since the tag: $commits."
  output "skip=false"
}

step_version() {
  local tag version
  tag=$(cat "$STATE/last-tag")
  version=$(bash scripts/next-version.sh "$STATE/old.json" openapi.json "$tag")
  echo "$version" >"$STATE/version"
  npm version "$version" --no-git-tag-version --allow-same-version >/dev/null

  {
    if [ -z "$tag" ]; then
      echo "First release of \`$PACKAGE\`, generated from the Sinatra API spec."
    else
      echo "## API changes"
      echo
      if [ "$(oasdiff changelog "$STATE/old.json" openapi.json --format json | jq length)" -gt 0 ]; then
        # Drop oasdiff's title line ("# API Changelog 1.0.0 vs. 1.0.0").
        oasdiff changelog "$STATE/old.json" openapi.json --format markdown | sed '1d' | cat -s
      else
        echo "None."
      fi
      local log
      log=$(git log --no-merges --format='- %s (%h)' "$tag..HEAD")
      if [ -n "$log" ]; then
        echo
        echo "## Other changes"
        echo
        echo "$log"
      fi
    fi
    echo
    echo "API reference: https://docs.sinatra.dev/docs/api-reference"
  } >"$STATE/notes.md"

  output "version=$version"
  {
    echo "### v$version (last release: ${tag:-none})"
    echo
    cat "$STATE/notes.md"
  } | summary
}

step_publish() {
  gate_open "publish" || return 0
  local version
  version=$(cat "$STATE/version")
  # A run that published but then failed to push its tag leaves the version
  # on npm; the next run finishes the job instead of failing on the publish.
  if [ "$(npm view "$PACKAGE@$version" version 2>/dev/null || true)" = "$version" ]; then
    warning "$PACKAGE@$version is already on npm; not publishing it again."
    return 0
  fi
  npm publish --provenance --access public
}

step_tag() {
  gate_open "commit and tag" || return 0
  local version branch
  version=$(cat "$STATE/version")
  branch=${RELEASE_BRANCH:-main}
  git config user.name "github-actions[bot]"
  git config user.email "41898099+github-actions[bot]@users.noreply.github.com"
  git add -A -- openapi.json src/generated package.json package-lock.json
  git commit -m "chore(release): v$version"
  git tag -a "v$version" -m "v$version"
  git push --atomic origin "HEAD:refs/heads/$branch" "refs/tags/v$version"
  gh release create "v$version" --verify-tag --title "v$version" --notes-file "$STATE/notes.md"
}

case "${1:-}" in
  plan | version | publish | tag) "step_$1" ;;
  *) die "usage: release.sh plan|version|publish|tag" ;;
esac
