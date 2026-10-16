#!/usr/bin/env bash
# Sign a file with the Developer ID, send it to Apple's notary service, wait
# for the verdict, and staple the ticket when the file can carry one.
#
# Done here rather than by Tauri's bundler for two reasons. Tauri submits the
# .app, then the DMG is built around it, so the DMG is a second submission;
# notarizing the DMG alone covers everything inside it in one. And Tauri's
# wait is a single `notarytool --wait`, which dies with the first network
# error: Apple's queue has taken hours, and one dropped poll after two of
# them threw the whole build away. This polls on its own and shrugs off a
# failed poll.
#
# A DMG gets stapled, so Gatekeeper can pass it offline. A zip cannot be, and
# neither can the bare binary inside it: Gatekeeper fetches the ticket online
# the first time, which is fine for a tool run from a terminal. The app inside
# the DMG is likewise not stapled; its ticket is found online at first launch.
#
# Reads the same variables Tauri's bundler does: APPLE_SIGNING_IDENTITY,
# APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH. On a refused submission
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
# Apple has been seen taking well over two hours; GitHub ends a job at six.
TIMEOUT_MINUTES="${NOTARIZE_TIMEOUT_MINUTES:-240}"

[ -f "$FILE" ] || { echo "error: no file at $FILE" >&2; exit 1; }

case "$FILE" in
  *.dmg)
    # --force: Tauri's bundler already signs the DMG, and codesign refuses to
    # sign over an existing signature without it.
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$FILE"
    ;;
  *.zip) ;;
  *)
    echo "error: $FILE is neither a .dmg nor a .zip" >&2
    exit 1
    ;;
esac

auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
json_field() { /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

# The upload itself is retried: it is the one step that cannot be resumed.
id=""
for attempt in 1 2 3; do
  if result=$(xcrun notarytool submit "$FILE" "${auth[@]}" --output-format json 2>&1); then
    id=$(printf '%s' "$result" | json_field id)
    break
  fi
  echo "submit attempt $attempt failed: $result" >&2
  sleep 30
done
[ -n "$id" ] || { echo "error: could not submit $FILE after 3 attempts" >&2; exit 1; }
echo "submitted $(basename "$FILE") as $id, waiting for Apple (up to $TIMEOUT_MINUTES min)"

status="In Progress"
deadline=$((SECONDS + TIMEOUT_MINUTES * 60))
while [ "$status" = "In Progress" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "error: Apple has not finished with $id after $TIMEOUT_MINUTES minutes; check https://developer.apple.com/system-status/ and re-run the job" >&2
    exit 1
  fi
  sleep 60
  # A poll that fails is a poll that fails, not a verdict.
  if info=$(xcrun notarytool info "$id" "${auth[@]}" --output-format json 2>&1); then
    status=$(printf '%s' "$info" | json_field status)
  else
    echo "poll failed, will retry: ${info##*$'\n'}" >&2
  fi
done

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
