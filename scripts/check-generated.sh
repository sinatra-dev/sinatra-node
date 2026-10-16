#!/usr/bin/env bash
# Fails if regenerating from the committed openapi.json changes src/generated:
# the generated code must always be exactly what the pinned generator makes
# from the committed spec. Fix with `npm run generate` and commit the result.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run --silent generate >/dev/null

if ! git diff --quiet --exit-code -- src/generated ||
  [ -n "$(git ls-files --others --exclude-standard -- src/generated)" ]; then
  echo "src/generated is out of date with openapi.json. Run 'npm run generate' and commit the result:" >&2
  git status --short -- src/generated >&2
  git --no-pager diff --stat -- src/generated >&2
  exit 1
fi
echo "src/generated matches openapi.json"
