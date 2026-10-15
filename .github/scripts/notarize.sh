#!/usr/bin/env bash
# Sign a file with the Developer ID, send it to Apple's notary service, wait
# for the verdict, and staple the ticket when the file can carry one. Tauri
# does all of this for the .app itself; this covers the two files it does not
# make, the DMG and the zip the CLI binary is notarized as.
#
# A DMG gets stapled, so Gatekeeper can pass it offline. A zip cannot be, and
# neither can the bare binary inside it: Gatekeeper fetches the ticket online
# the first time, which is fine for a tool run from a terminal.
#
# Reads the same variables Tauri's bundler does: APPLE_SIGNING_IDENTITY,
# APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH. On a failed submission
# it prints Apple's log, which names the offending file inside the archive.
#
#   .github/scripts/notarize.sh path/to/Tori_1.0_aarch64.dmg
#   .github/scripts/notarize.sh path/to/tori.zip
set -euo pipefail

FILE="${1:?usage: notarize.sh <dmg or zip>}"
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is not set}"
: "${APPLE_API_KEY:?APPLE_API_KEY is not set}"
: "${APPLE_API_ISSUER:?APPLE_API_ISSUER is not set}"
: "${APPLE_API_KEY_PATH:?APPLE_API_KEY_PATH is not set}"

[ -f "$FILE" ] || { echo "error: no file at $FILE" >&2; exit 1; }

case "$FILE" in
  *.dmg)
    codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$FILE"
    ;;
  *.zip) ;;
  *)
    echo "error: $FILE is neither a .dmg nor a .zip" >&2
    exit 1
    ;;
esac

auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
result=$(xcrun notarytool submit "$FILE" "${auth[@]}" --wait --output-format json)
status=$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
id=$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
if [ "$status" != Accepted ]; then
  echo "error: notarization of $FILE ended as '$status' (submission $id); Apple's log:" >&2
  xcrun notarytool log "$id" "${auth[@]}" >&2 || true
  exit 1
fi

case "$FILE" in
  *.dmg)
    xcrun stapler staple "$FILE"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$FILE"
    ;;
esac

echo "ok: $FILE notarized (submission $id)"
