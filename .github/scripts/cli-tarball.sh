#!/usr/bin/env bash
# Pack the app's own binary as the tori CLI release asset, which gettori/packs
# CI downloads to run `tori validate-pack` and `tori packs-index`. Prints the
# tarball's path. check-cli.sh asks the binary to answer as the CLI, in the
# build job; this runs where the signing key is, so it never runs the binary.
#
# The binary is already signed as part of the bundle. When the notarization
# variables are set it is also notarized here, as a zip, since that is the
# form the notary service takes a bare binary in; the tarball is made from the
# same bytes afterwards.
#
#   .github/scripts/cli-tarball.sh <path to Tori.app> <version> <arm64|x64> <out dir>
set -euo pipefail

usage="usage: cli-tarball.sh <path to .app> <version> <arm64|x64> <out dir>"
APP="${1:?$usage}"
VERSION="${2:?$usage}"
ARCH="${3:?$usage}"
OUT="${4:?$usage}"
here=$(cd "$(dirname "$0")" && pwd)

bin="$APP/Contents/MacOS/tori"
[ -x "$bin" ] || { echo "error: no executable at $bin" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$bin" "$stage/tori"

# Signed again as a bare binary: inside the bundle it was signed as the main
# executable, and that signature hashes the bundle's Info.plist and resources
# too, so on its own the notary service calls it invalid.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$stage/tori"
  codesign --verify --strict "$stage/tori"
fi

if [ -n "${APPLE_API_KEY:-}" ]; then
  (cd "$stage" && zip -q tori.zip tori)
  "$here/notarize.sh" "$stage/tori.zip" >&2
fi

mkdir -p "$OUT"
tarball="$OUT/tori-cli-$VERSION-macos-$ARCH.tar.gz"
tar -czf "$tarball" -C "$stage" tori
echo "$tarball"
