#!/usr/bin/env bash
# Fail if any non-merge commit in base..head lacks a Signed-off-by trailer for
# its author's email: the Developer Certificate of Origin sign-off that
# CONTRIBUTING.md asks of outside contributors.
#
# Merge commits are skipped. GitHub's "Update branch" button creates one with
# no trailer, and it carries no contribution of its own.
#
#   .github/scripts/check-dco.sh <base sha> <head sha>
set -euo pipefail

BASE="${1:?usage: check-dco.sh <base> <head>}"
TIP="${2:?usage: check-dco.sh <base> <head>}"

fail=0
checked=0

while IFS= read -r sha; do
  checked=$((checked + 1))
  email=$(git log -1 --format='%ae' "$sha" | tr '[:upper:]' '[:lower:]')

  if git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" \
    | tr '[:upper:]' '[:lower:]' | grep -qF "<$email>"; then
    continue
  fi

  echo "  NOT SIGNED OFF: $(git log -1 --format='%h %s' "$sha") (author <$email>)" >&2
  fail=1
done < <(git rev-list --no-merges "$BASE..$TIP")

if [ "$fail" -ne 0 ]; then
  echo "FAIL: the commits above need a 'Signed-off-by: Name <email>' trailer matching the author." >&2
  echo "Add one with git commit -s, or git rebase --signoff $BASE for the branch, then force-push. See CONTRIBUTING.md." >&2
  exit 1
fi

echo "OK: all $checked commit(s) are signed off."
