#!/usr/bin/env bash
# Tag the commit this run built and publish its GitHub release with the named
# files, each found once under <assets dir>. Drafted first so a failed upload
# never leaves a live release without its assets; published only once each one
# is confirmed.
#
#   .github/scripts/publish.sh <tag> <title> <notes file> <latest: true|false> <assets dir> <file>...
set -euo pipefail

TAG="${1:?usage: publish.sh <tag> <title> <notes file> <latest> <assets dir> <file>...}"
TITLE=$2
NOTES=$3
LATEST=$4
DIR=$5
shift 5
[ $# -gt 0 ] || { echo "publish.sh: name the files to publish" >&2; exit 1; }
: "${GITHUB_SHA:?}" "${GITHUB_REPOSITORY:?}"

files=()
for name in "$@"; do
  found=$(find "$DIR" -type f -name "$name")
  case "$found" in
    "" | *$'\n'*)
      echo "expected one $name under $DIR, found: ${found:-none}; have:" >&2
      find "$DIR" -type f | sed 's/^/  /' >&2
      exit 1
      ;;
  esac
  files+=("$found")
done

# A ruleset on tags may block deleting or moving one; it must not block
# creating one.
git tag "$TAG" "$GITHUB_SHA"
git push origin "$TAG"

# --verify-tag: gh must not invent a tag on the default branch if the push
# above somehow did not land. Never a prerelease, whatever the stage suffix:
# GitHub cannot make one its latest release, which the Mac's has to be.
gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --draft --verify-tag \
  --title "$TITLE" --notes-file "$NOTES" "${files[@]}"
want=$(printf '%s\n' "$@" | sort)
have=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets -q '.assets[].name' | sort)
if [ "$want" != "$have" ]; then
  echo "the draft is missing an asset; have:" >&2
  echo "$have" >&2
  exit 1
fi
gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false --latest="$LATEST"
