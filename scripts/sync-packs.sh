#!/usr/bin/env bash
# Replaces the pack snapshot Tori embeds, src-tauri/packs/<kind>/ and
# src-tauri/packs/icons/, with the packs scripts/bundle.txt names, taken from
# gettori/packs at one commit, and records that commit and every file's sha256
# in src-tauri/packs.lock. `scripts/check.sh packs` holds the snapshot to the
# lock and the lock to the list, so a hand edit under src-tauri/packs/ fails
# CI: change the pack in gettori/packs, then sync.
#
#   scripts/sync-packs.sh [<ref>]   a full commit sha, a branch or a tag;
#                                   main by default
set -euo pipefail

cd "$(dirname "$0")/.."

ref=${1:-main}
folders=(lsp dap formatters themes agents icons)
bundle=scripts/bundle.txt

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" fetch -q --depth 1 https://github.com/gettori/packs.git "$ref"
git -C "$tmp" checkout -q FETCH_HEAD
commit=$(git -C "$tmp" rev-parse HEAD)

# Checked before anything is removed, so a packs commit missing a folder or a
# listed pack never leaves the snapshot half replaced.
for folder in "${folders[@]}"; do
  if [ ! -d "$tmp/$folder" ]; then
    echo "error: gettori/packs at $commit has no $folder/ folder" >&2
    exit 1
  fi
done
packs=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  packs+=("$line")
  if [ "$(ls "$tmp/$line".* 2>/dev/null | wc -l)" -ne 1 ]; then
    echo "error: gettori/packs at $commit has no $line pack (named in $bundle)" >&2
    exit 1
  fi
done < "$bundle"

for folder in "${folders[@]}"; do
  rm -rf "src-tauri/packs/$folder"
  mkdir -p "src-tauri/packs/$folder"
done
for pack in "${packs[@]}"; do
  cp "$tmp/$pack".* "src-tauri/packs/${pack%/*}/"
  case "$pack" in agents/*)
    for icon in "$tmp/icons/${pack#agents/}".*; do
      [ -e "$icon" ] && cp "$icon" src-tauri/packs/icons/
    done ;;
  esac
done

{
  echo "# Written by scripts/sync-packs.sh. Do not edit: run it again."
  echo "commit $commit"
  (cd src-tauri/packs && find "${folders[@]}" -type f | LC_ALL=C sort | xargs shasum -a 256)
} > src-tauri/packs.lock

echo "src-tauri/packs is ${#packs[@]} packs from gettori/packs at $commit"
