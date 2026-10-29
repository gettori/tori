#!/usr/bin/env bash
# Build the extension for the Chrome Web Store and zip it. Prints the zip's
# path. Refuses a zip the store would take but users could not run: one with a
# `key`, a version Chrome cannot read, or the dev build's host name.
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

manifest="$dist/manifest.json"
version=$(node -p "require('$manifest').version")
echo "$version" | grep -Eq '^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$' &&
  node -e "process.exit(process.argv[1].split('.').every((n) => n <= 65535) ? 0 : 1)" "$version" ||
  die "manifest version $version is not one Chrome reads: one to four dot separated integers up to 65535"
[ "$(node -p "'key' in require('$manifest')")" = "false" ] || die "the store manifest carries a key"
grep -Eq "[\"\`]app\\.gettori\\.tori[\"\`]" "$dist/background.js" || die "background.js does not name app.gettori.tori"
! grep -rq 'tori_dev' "$dist" || die "the store build names the dev host"

mkdir -p "$OUT"
zip="$(cd "$OUT" && pwd)/tori-extension-$version.zip"
rm -f "$zip"
(cd "$dist" && zip -qrX "$zip" .)
echo "$zip"
