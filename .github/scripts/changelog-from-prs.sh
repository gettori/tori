#!/usr/bin/env bash
# Print the changelog bullets of every pull request merged into main since a
# tag, oldest first: the `## Changelog` section of each PR body, as
# pr-changelog.sh reads it. This is where a release's notes come from, so
# nobody edits CHANGELOG.md between releases.
#
# A merged PR without a usable section fails the whole run and is named, with
# the command that fixes it: `gh pr edit <n>` works on a merged PR, and the
# next run picks the edit up. Release PRs (branch `release/*`) are skipped;
# their body is the notes of the release before.
#
# Needs `gh` logged in. Runs in any checkout with an `origin` that has the tag
# and main fetched.
#
#   .github/scripts/changelog-from-prs.sh v26.1015.0-alpha [origin/main]
set -euo pipefail

SINCE="${1:?usage: changelog-from-prs.sh <tag or commit> [tip, default origin/main]}"
TIP="${2:-origin/main}"
REPO="${RELEASES_REPO:-gettori/tori}"
here=$(cd "$(dirname "$0")" && pwd)

git rev-parse -q --verify "$SINCE^{commit}" >/dev/null || {
  echo "error: $SINCE is not a commit or tag in this checkout; git fetch --tags origin first" >&2
  exit 1
}

# The search is by date only to bound the list; the commit range decides. A PR
# merged into main before the tag but after the tag's commit date (a release
# cut from an older commit) is excluded by the range, and one merged into
# another base never had its merge commit on main.
since_date=$(git log -1 --format=%cI "$SINCE")
in_range=$(git rev-list "$SINCE..$TIP")

prs=$(gh pr list --repo "$REPO" --state merged --base main --limit 500 \
  --search "merged:>=$since_date" \
  --json number,headRefName,mergedAt,mergeCommit \
  --jq 'sort_by(.mergedAt) | .[] | select(.headRefName | startswith("release/") | not) | "\(.number)\t\(.mergeCommit.oid)"')

out=""
failed=""
while IFS=$'\t' read -r number oid; do
  [ -n "$number" ] || continue
  grep -qx "$oid" <<<"$in_range" || continue
  if bullets=$(gh pr view "$number" --repo "$REPO" --json body -q .body | "$here/pr-changelog.sh" 2>/tmp/pr-changelog-$$); then
    [ -z "$bullets" ] || out="$out${out:+$'\n'}$bullets"
  else
    failed="$failed  #$number: $(cat /tmp/pr-changelog-$$)"$'\n'
  fi
  rm -f /tmp/pr-changelog-$$
done <<<"$prs"

if [ -n "$failed" ]; then
  echo "error: merged PRs without a usable '## Changelog' section:" >&2
  printf '%s' "$failed" >&2
  echo "hint: gh pr edit <number> --repo $REPO --body-file <file> fixes a merged PR's body; a PR with nothing to tell a user says 'none'" >&2
  exit 1
fi

[ -z "$out" ] || printf '%s\n' "$out"
