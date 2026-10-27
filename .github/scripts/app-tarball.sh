#!/usr/bin/env bash
# The DMG's notarization covers the app inside it, so its ticket is stapled
# onto the app here, letting an update pass Gatekeeper offline too.
#
#   .github/scripts/app-tarball.sh <path to Tori.app> <version> <aarch64|x64> <out dir>
set -euo pipefail

usage="usage: app-tarball.sh <path to .app> <version> <aarch64|x64> <out dir>"
APP="${1:?$usage}"
VERSION="${2:?$usage}"
ARCH="${3:?$usage}"
OUT="${4:?$usage}"

[ -d "$APP" ] || { echo "error: no app at $APP" >&2; exit 1; }

if [ -n "${APPLE_API_KEY:-}" ]; then
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute "$APP"
fi
codesign --verify --deep --strict "$APP"

mkdir -p "$OUT"
tarball="$OUT/Tori_${VERSION}_${ARCH}.app.tar.gz"
# COPYFILE_DISABLE keeps macOS tar from adding ._ files for extended
# attributes, which would sit inside the bundle and break its seal.
COPYFILE_DISABLE=1 tar -czf "$tarball" -C "$(dirname "$APP")" "$(basename "$APP")"
echo "$tarball"
