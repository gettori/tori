#!/usr/bin/env bash
# Replaces the pack snapshot Tori embeds, src-tauri/packs/<kind>/ and
# src-tauri/packs/icons/, with gettori/packs at one commit, and records that
# commit and every file's sha256 in src-tauri/packs.lock. `scripts/check.sh
# packs` holds the snapshot to it, so a hand edit under src-tauri/packs/ fails
# CI: change the pack in gettori/packs, then sync.
#
#   scripts/sync-packs.sh [<ref>]   a full commit sha, a branch or a tag;
#                                   main by default
set -euo pipefail

cd "$(dirname "$0")/.."

ref=${1:-main}
folders=(lsp dap formatters themes agents icons)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" fetch -q --depth 1 https://github.com/gettori/packs.git "$ref"
git -C "$tmp" checkout -q FETCH_HEAD
commit=$(git -C "$tmp" rev-parse HEAD)

# Checked before anything is removed, so a packs commit missing a folder never
# leaves the snapshot half replaced.
for folder in "${folders[@]}"; do
  if [ ! -d "$tmp/$folder" ]; then
    echo "error: gettori/packs at $commit has no $folder/ folder" >&2
    exit 1
  fi
done

for folder in "${folders[@]}"; do
  rm -rf "src-tauri/packs/$folder"
  cp -R "$tmp/$folder" "src-tauri/packs/$folder"
done

{
  echo "# Written by scripts/sync-packs.sh. Do not edit: run it again."
  echo "commit $commit"
  (cd src-tauri/packs && find "${folders[@]}" -type f | LC_ALL=C sort | xargs shasum -a 256)
} > src-tauri/packs.lock

echo "src-tauri/packs is gettori/packs at $commit"
