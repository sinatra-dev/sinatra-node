#!/usr/bin/env bash
# The release steps that .github/workflows/release.yml runs, one per command.
# Each can be run locally for a dry run (see RELEASING.md).
#
# Job "build" (read-only token, runs the dev dependencies):
#   plan     Fetch the live spec and decide whether to release: stop if it
#            matches openapi.json and no release-worthy commit landed since the
#            last tag; otherwise write it to openapi.json. Also notices a tag
#            whose GitHub release is missing (a run that failed after its push).
#   version  Compute the next version from the spec change, set it in
#            package.json, write the release notes.
#   pack     Commit the release locally, save that commit as a git bundle, and
#            npm pack the package. Everything the later jobs need is then in
#            release-state/, which the workflow uploads as an artifact.
#   gate     Say whether the publish and tag jobs will run, and why not.
# CI:
#   verify-pack  Pack the checkout and run the publish command with --dry-run.
# Job "publish" (id-token: write, installs nothing):
#   publish  Refuse if main moved since the build. Skip if this exact tarball is
#            already on npm; refuse if a different one is. Otherwise publish it.
# Job "tag" (contents: write, installs nothing):
#   tag      Create the missing GitHub release, if any. Push the release commit
#            and its vX.Y.Z tag to main in one atomic push, then create the
#            GitHub release.
#
# Environment:
#   SPEC_URL         the live spec (default https://api.sinatra.dev/openapi.json)
#   SPEC_FILE        read the spec from this file instead of SPEC_URL
#   DRY_RUN          "true" for a workflow_dispatch dry run (gate's notice only)
#   PUBLISH_ENABLED  "true" when publishing is on (gate's notice only; the
#                    workflow's job conditions are the real gate)
#   RELEASE_BRANCH   the branch releases come from and go to (default main)
set -euo pipefail
cd "$(dirname "$0")/.."

PACKAGE=@sinatra-dev/sdk
SPEC_URL=${SPEC_URL:-https://api.sinatra.dev/openapi.json}
BRANCH=${RELEASE_BRANCH:-main}
# Absolute, so every path handed to npm is unambiguous: npm reads a relative
# "release-state/x.tgz" as GitHub shorthand (user/repo) and tries to clone it.
STATE="$(pwd -P)/release-state"
# Only commits touching these count as a reason to release. Docs, CI and
# test-only commits wait for the next release.
RELEASE_PATHS=(src package.json openapi-ts.config.ts tsup.config.ts tsconfig.json)
PATH="$PWD/.tools/bin:$PATH"

die() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error title=release::$*"; else echo "release: $*" >&2; fi
  exit 1
}
notice() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::notice title=release::$*"; else echo "notice: $*"; fi
}
output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >>"$GITHUB_OUTPUT"; fi
}
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat >>"$GITHUB_STEP_SUMMARY"; else cat; fi
}
canonical() { jq -S -c . "$1"; }
state() { cat "$STATE/$1"; }
git_bot() {
  git -c user.name="github-actions[bot]" -c user.email="41898099+github-actions[bot]@users.noreply.github.com" "$@"
}

# Release tags, highest version first. By version, not by ancestry: a tag
# pushed by hand to recover a failed run need not be on main.
release_tags() { git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; }

# Commits in <range> that touch the release paths, without release commits.
release_commits() {
  git log --no-merges --invert-grep --grep='^chore(release): ' --format='- %s (%h)' "$1" -- "${RELEASE_PATHS[@]}"
}

# write_notes <from-tag or ""> <to-rev> <old-spec> <new-spec> <out>
write_notes() {
  local from=$1 to=$2 old=$3 new=$4 out=$5 levels="$STATE/severity-levels.txt"
  # The spec's info.version is not the SDK's version: leave that check out.
  printf 'api-version-not-bumped none\n' >"$levels"
  local changelog=(oasdiff changelog "$old" "$new" --severity-levels "$levels")
  {
    if [ -z "$from" ]; then
      echo "First release of \`$PACKAGE\`, generated from the Sinatra API spec."
    else
      if [ "$("${changelog[@]}" --format json | jq length)" -gt 0 ]; then
        # oasdiff's markdown has its own "## API Changes" section; drop its
        # title line ("# API Changelog 1.0.0 vs. 1.0.0").
        "${changelog[@]}" --format markdown | sed '1d' | cat -s
      else
        printf '## API Changes\n\nNone.\n'
      fi
      local log
      log=$(release_commits "$from..$to")
      if [ -n "$log" ]; then
        printf '\n## Other changes\n\n%s\n' "$log"
      fi
    fi
    printf '\nAPI reference: https://docs.sinatra.dev/docs/api-reference\n'
  } >"$out"
}

step_plan() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
  git rev-parse HEAD >"$STATE/base-sha"

  if [ -n "${SPEC_FILE:-}" ]; then
    cp "$SPEC_FILE" "$STATE/live.json"
  else
    curl -fsSL --retry 3 --retry-all-errors --max-time 60 -o "$STATE/live.json" "$SPEC_URL"
  fi
  jq -e '(.openapi | type == "string") and (.paths | type == "object")' "$STATE/live.json" >/dev/null ||
    die "the spec from ${SPEC_FILE:-$SPEC_URL} isn't an OpenAPI document"

  local tags tag previous
  tags=$(release_tags)
  tag=$(sed -n 1p <<<"$tags")
  previous=$(sed -n 2p <<<"$tags")
  echo "$tag" >"$STATE/last-tag"

  # A tag without a GitHub release: a run pushed its tag, then failed.
  local missing=""
  if [ -n "$tag" ]; then
    local err
    if ! err=$(gh release view "$tag" --json tagName 2>&1 >/dev/null); then
      case "$err" in
        *"release not found"*) missing=$tag ;;
        *) die "couldn't check the GitHub release for $tag: $err" ;;
      esac
    fi
  fi
  if [ -n "$missing" ]; then
    echo "$missing" >"$STATE/missing-tag"
    git show "$missing:openapi.json" >"$STATE/missing-new.json"
    if [ -n "$previous" ]; then
      git show "$previous:openapi.json" >"$STATE/missing-old.json"
    else
      cp "$STATE/missing-new.json" "$STATE/missing-old.json"
    fi
    write_notes "$previous" "$missing" "$STATE/missing-old.json" "$STATE/missing-new.json" "$STATE/missing-notes.md"
    echo "$missing has no GitHub release; the tag job will create it."
  fi
  output "missing_release=$missing"

  if [ -n "$tag" ]; then
    git show "$tag:openapi.json" >"$STATE/old.json"
  else
    cp openapi.json "$STATE/old.json"
  fi

  local spec_changed=true commits=none
  if [ "$(canonical "$STATE/live.json")" = "$(canonical openapi.json)" ]; then spec_changed=false; fi
  if [ -n "$tag" ]; then commits=$(git rev-list --count "$tag..HEAD" -- "${RELEASE_PATHS[@]}"); fi

  if [ -n "$tag" ] && [ "$spec_changed" = false ] && [ "$commits" = 0 ]; then
    echo "Nothing to release: the live spec matches openapi.json and no release-worthy commit landed since $tag."
    output "release=false"
    return 0
  fi

  # Keep the live document's key order; pretty-print so diffs stay readable.
  jq . "$STATE/live.json" >openapi.json
  echo "Releasing: last tag ${tag:-none}, spec changed: $spec_changed, release-worthy commits since the tag: $commits."
  output "release=true"
}

step_version() {
  local tag version
  tag=$(state last-tag)
  version=$(bash scripts/next-version.sh "$STATE/old.json" openapi.json "$tag")
  echo "$version" >"$STATE/version"
  npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
  write_notes "$tag" HEAD "$STATE/old.json" openapi.json "$STATE/notes.md"

  output "version=$version"
  {
    echo "### v$version (last release: ${tag:-none})"
    echo
    cat "$STATE/notes.md"
  } | summary
}

# The one npm publish command, shared by the publish job and the dry run.
npm_publish() {
  npm publish "$STATE/$(state tarball)" --provenance --access public --ignore-scripts "$@"
}

# Builds and packs into $STATE; records the tarball's name and sha1.
pack_tarball() {
  # Pack without lifecycle scripts so the JSON on stdout is only npm's.
  npm run --silent build >/dev/null
  local packed
  packed=$(npm pack --ignore-scripts --json --pack-destination "$STATE")
  jq -r '.[0].filename' <<<"$packed" >"$STATE/tarball"
  jq -r '.[0].shasum' <<<"$packed" >"$STATE/shasum"
}

# Runs the real npm CLI on the publish command with --dry-run (it uploads
# nothing), so a path npm misreads or a flag it rejects fails here, not in the
# publish job. npm's dry run still refuses a version that's already on npm,
# after reading the tarball; that's fine here (the publish job decides what to
# do about a published version), so it counts as a pass.
publish_dry_run() {
  local out
  if out=$(npm_publish --dry-run 2>&1); then
    echo "npm publish --dry-run accepts $(state tarball)."
  elif grep -q 'npm notice total files:' <<<"$out" &&
    grep -q 'cannot publish over the previously published versions' <<<"$out"; then
    echo "npm publish --dry-run read $(state tarball); its version is already on npm."
  else
    printf '%s\n' "$out" >&2
    die "npm publish --dry-run rejected $(state tarball)"
  fi
}

step_pack() {
  local version base
  version=$(state version)
  base=$(state base-sha)

  git add -A -- openapi.json src/generated package.json package-lock.json
  git_bot commit -q -m "chore(release): v$version"
  git rev-parse HEAD >"$STATE/release-sha"
  git bundle create "$STATE/release.bundle" "$base..HEAD" 2>/dev/null

  pack_tarball
  echo "Packed $(state tarball) (sha1 $(state shasum)) from release commit $(state release-sha)."
  publish_dry_run
}

# CI: pack the checkout and dry-run the publish command, without a release.
step_verify_pack() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
  pack_tarball
  publish_dry_run
}

step_gate() {
  local what
  if [ -s "$STATE/version" ]; then
    what="release v$(state version)"
  else
    what="create the missing GitHub release for $(state missing-tag)"
  fi
  if [ "${DRY_RUN:-false}" = "true" ]; then
    notice "Dry run: the publish and tag jobs are skipped. A real run would $what."
  elif [ "${PUBLISH_ENABLED:-}" != "true" ]; then
    notice "PUBLISH_ENABLED isn't 'true' (or this isn't $BRANCH): the publish and tag jobs are skipped. A real run would $what. See RELEASING.md."
  else
    echo "The publish and tag jobs run next, to $what."
  fi
}

# The commit main points at on the remote right now.
remote_head() {
  local line
  line=$(git ls-remote origin "refs/heads/$BRANCH") || die "couldn't read $BRANCH from origin"
  cut -f1 <<<"$line"
}

step_publish() {
  local version shasum base head
  version=$(state version)
  shasum=$(state shasum)
  base=$(state base-sha)

  head=$(remote_head)
  if [ "$head" != "$base" ]; then
    die "$BRANCH moved from $base to $head since this run built; not publishing v$version. The next run releases the new $BRANCH."
  fi

  local published err
  if published=$(npm view "$PACKAGE@$version" dist.shasum 2>"$STATE/npm-view.err"); then
    if [ -z "$published" ]; then
      die "npm view $PACKAGE@$version answered without a shasum; not publishing."
    elif [ "$published" = "$shasum" ]; then
      notice "$PACKAGE@$version is already on npm with this build's shasum ($shasum): a previous run published it and failed before tagging. Not publishing again."
      return 0
    else
      die "$PACKAGE@$version is already on npm with shasum $published, but this build packs $shasum. A run published different code as v$version and failed before tagging it, so this run won't tag v$version on code that was never published. See RELEASING.md, 'A run failed after publishing'."
    fi
  fi
  err=$(cat "$STATE/npm-view.err")
  case "$err" in
    *E404*) ;; # not published yet
    *) die "couldn't check whether $PACKAGE@$version is on npm: $err" ;;
  esac

  npm_publish
}

# Checks the release commit from the artifact before it is pushed: one commit
# on top of the commit this job checked out (the one build started from), that
# changes only the spec, the generated code and the version.
verify_release_commit() {
  local sha=$1 version=$2 base parents path
  base=$(git rev-parse HEAD)
  [ "$(state base-sha)" = "$base" ] ||
    die "the artifact was built from $(state base-sha), but this job checked out $base"
  parents=$(git rev-list --parents -n 1 "$sha" | cut -d' ' -f2-)
  [ "$parents" = "$base" ] ||
    die "release commit $sha must have exactly one parent, $base; it has: ${parents:-none}"
  # --no-renames: with rename detection a moved file lists only its new path,
  # so a file moved into src/generated/ would hide that its old path was
  # deleted. -z: paths NUL-separated and unquoted, whatever they contain.
  git diff --no-renames --name-only -z "$base" "$sha" >"$STATE/changed-paths" ||
    die "couldn't list the paths release commit $sha changes"
  while IFS= read -r -d '' path; do
    case "$path" in
      openapi.json | package.json | package-lock.json | src/generated/*) ;;
      *) die "release commit $sha changes $path; a release commit may only change openapi.json, src/generated/, package.json and package-lock.json" ;;
    esac
  done <"$STATE/changed-paths"
  # The manifests may change only their version.
  [ "$(git show "$sha:package.json" | jq -S 'del(.version)')" = "$(git show "$base:package.json" | jq -S 'del(.version)')" ] ||
    die "release commit $sha changes package.json beyond its version"
  local lock='del(.version, .packages[""].version)'
  [ "$(git show "$sha:package-lock.json" | jq -S "$lock")" = "$(git show "$base:package-lock.json" | jq -S "$lock")" ] ||
    die "release commit $sha changes package-lock.json beyond its version"
  [ "$(git show "$sha:package.json" | jq -r .version)" = "$version" ] ||
    die "release commit $sha doesn't set package.json's version to $version"
}

step_tag() {
  if [ -s "$STATE/missing-tag" ]; then
    local missing
    missing=$(state missing-tag)
    gh release create "$missing" --verify-tag --title "$missing" --notes-file "$STATE/missing-notes.md"
  fi
  [ -s "$STATE/version" ] || return 0

  local version sha
  version=$(state version)
  sha=$(state release-sha)
  git fetch -q "$STATE/release.bundle" HEAD
  [ "$(git rev-parse FETCH_HEAD)" = "$sha" ] || die "release.bundle doesn't hold release commit $sha"
  verify_release_commit "$sha" "$version"
  git_bot tag -a "v$version" "$sha" -m "v$version"
  git push --atomic origin "$sha:refs/heads/$BRANCH" "refs/tags/v$version"
  gh release create "v$version" --verify-tag --title "v$version" --notes-file "$STATE/notes.md"
}

case "${1:-}" in
  plan | version | pack | gate | publish | tag) "step_$1" ;;
  verify-pack) step_verify_pack ;;
  *) die "usage: release.sh plan|version|pack|gate|publish|tag|verify-pack" ;;
esac
