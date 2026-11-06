#!/usr/bin/env bash
# The build job holds no signing identity, so the app it made is signed here,
# inside out, with the hardened runtime and a timestamp notarization requires.
#
#   .github/scripts/sign-app.sh path/to/Tori.app path/to/Entitlements.plist
set -euo pipefail

usage="usage: sign-app.sh <path to .app> <entitlements plist>"
APP="${1:?$usage}"
ENTITLEMENTS="${2:?$usage}"
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is not set}"

[ -d "$APP" ] || { echo "error: no app at $APP" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "error: no entitlements at $ENTITLEMENTS" >&2; exit 1; }

sign() {
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$@"
}

main="$APP/Contents/MacOS/tori"
signed=0
# Deepest path first, so a file is signed before anything that seals it.
while IFS= read -r file; do
  [ "$file" = "$main" ] && continue
  case "$(file -b "$file")" in
    *Mach-O*)
      sign "$file"
      signed=$((signed + 1))
      ;;
  esac
done < <(find "$APP/Contents" -type f | awk '{ print gsub("/", "/"), $0 }' | sort -rn | cut -d' ' -f2-)

while IFS= read -r bundle; do
  sign "$bundle"
done < <(find "$APP/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.bundle' -o -name '*.xpc' \))

sign --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "ok: signed $signed nested Mach-O file(s) and $APP"
