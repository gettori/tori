#!/usr/bin/env bash
# Decide whether a release ships the browser extension: print the version it
# would carry (or `yes` without one), or nothing. It ships when anything the
# store zip is built from changed since <since>, or with --force (a dependency
# bump that matters, since pnpm-lock.yaml moves on nearly every release and is
# not counted).
#
# Its own script rather than inline in release.sh, because `prepare` cannot be
# dry-run: it pushes a branch and opens a PR.
#
#   .github/scripts/extension-ships.sh <since> [version] [tip, default origin/main] [--force]
set -euo pipefail

force=false
args=()
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    *) args+=("$arg") ;;
  esac
done
SINCE="${args[0]:?usage: extension-ships.sh <since> [version] [tip] [--force]}"
VERSION="${args[1]:-yes}"
TIP="${args[2]:-origin/main}"

# The store listing is edited in the dashboard and is not in the zip, and the
# version field is this decision's output rather than a change to ship.
if $force || ! git diff --quiet "$SINCE" "$TIP" -- \
  extension src/utils/spaceTint.ts src-tauri/icons \
  ':!extension/store' ':!extension/package.json'; then
  # Chrome reads four numbers at most, so the stage suffix goes.
  echo "${VERSION%%-*}"
fi
