#!/usr/bin/env bash
# Moves a branch cut before the tree-wide reformat across it, without a
# conflict on every line the formatters touched. Run it on the branch:
#
#   scripts/reformat-branch.sh [onto]    onto defaults to origin/main
#
# Three rebases. The first, onto the commit before the reformat, is ordinary:
# real conflicts with main stop there, and after `git rebase --continue` you
# run this again. The second crosses the reformat with `-X theirs` and formats
# and amends every commit, so the branch's code wins each formatting conflict
# and is then formatted itself. The third is a plain rebase onto `onto`.
set -euo pipefail

cd "$(dirname "$0")/.."

ONTO="${1:-origin/main}"
SUBJECT="Format the tree with Oxfmt and rustfmt"

step() {
  printf '\n==> %s\n' "$*"
}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "error: commit or stash your changes first" >&2
  exit 1
fi

# By subject, not hash: rebase merges give the commit a new hash on main.
REFORMAT=$(git log -1 --format=%H --fixed-strings --grep="$SUBJECT" "$ONTO")
if [ -z "$REFORMAT" ]; then
  echo "error: no \"$SUBJECT\" commit on $ONTO (fetch first?)" >&2
  exit 1
fi
if git merge-base --is-ancestor "$REFORMAT" HEAD; then
  echo "already past the reformat; a plain \`git rebase $ONTO\` is all this branch needs"
  exit 0
fi

step "rebase onto the commit before the reformat"
git rebase "$REFORMAT^"

# The branch may predate Vite+, and the formatter has to match the config.
step "install"
pnpm install --frozen-lockfile

step "rebase across the reformat, formatting each commit"
git rebase -X theirs "$REFORMAT" --exec "pnpm exec vp fmt >/dev/null \
  && cargo fmt --manifest-path src-tauri/Cargo.toml \
  && cargo fmt --manifest-path mobile/src-tauri/Cargo.toml \
  && git commit --amend --no-edit --no-verify --all --quiet"

step "rebase onto $ONTO"
git rebase "$ONTO"
