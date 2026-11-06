#!/usr/bin/env bash
# hdiutil rather than Tauri's bundle_dmg.sh, which lays the window out through
# Finder with AppleScript (a CI runner fails that now and then with no output)
# and would sign with an identity the build job lacks.
#
#   .github/scripts/make-dmg.sh path/to/Tori.app path/to/Tori_1.0_aarch64.dmg
set -euo pipefail

usage="usage: make-dmg.sh <path to .app> <dmg to write>"
APP="${1:?$usage}"
DMG="${2:?$usage}"

[ -d "$APP" ] || { echo "error: no app at $APP" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# ditto keeps the signature's extended attributes and the bundle's symlinks.
ditto "$APP" "$stage/$(basename "$APP")"
ln -s /Applications "$stage/Applications"

mkdir -p "$(dirname "$DMG")"
hdiutil create -volname Tori -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$DMG" >&2
echo "$DMG"
