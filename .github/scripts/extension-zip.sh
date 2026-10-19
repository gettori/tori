#!/usr/bin/env bash
# Build the extension for the Chrome Web Store and zip it. Prints the zip's
# path. Refuses a zip the store would take but users could not run: one with a
# `key`, a version other than the app's, or the dev build's host name.
#
#   .github/scripts/extension-zip.sh <out dir>
set -euo pipefail

OUT="${1:?usage: extension-zip.sh <out dir>}"
root=$(cd "$(dirname "$0")/../.." && pwd)
dist="$root/extension/dist/store"

die() {
  echo "error: $*" >&2
  exit 1
}

TORI_TARGET=store pnpm --dir "$root/extension" build >&2

version=$(node -p "require('$root/package.json').version.split('-')[0]")
manifest="$dist/manifest.json"
[ "$(node -p "require('$manifest').version")" = "$version" ] || die "manifest version is not $version"
[ "$(node -p "'key' in require('$manifest')")" = "false" ] || die "the store manifest carries a key"
grep -Eq '["`]app\.gettori\.tori["`]' "$dist/background.js" || die "background.js does not name app.gettori.tori"
! grep -rq 'tori_dev' "$dist" || die "the store build names the dev host"

mkdir -p "$OUT"
zip="$(cd "$OUT" && pwd)/tori-extension-$version.zip"
rm -f "$zip"
(cd "$dist" && zip -qrX "$zip" .)
echo "$zip"
