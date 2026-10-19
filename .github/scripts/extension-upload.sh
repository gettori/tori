#!/usr/bin/env bash
# Upload an extension zip to the Chrome Web Store item as its new draft. Never
# submits it for review: that, and publishing, stay a click in the dashboard.
#
#   CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... CWS_PUBLISHER_ID=... \
#     .github/scripts/extension-upload.sh <zip>
set -euo pipefail

ZIP="${1:?usage: extension-upload.sh <zip>}"
: "${CWS_CLIENT_ID:?}" "${CWS_CLIENT_SECRET:?}" "${CWS_REFRESH_TOKEN:?}" "${CWS_PUBLISHER_ID:?}"
root=$(cd "$(dirname "$0")/../.." && pwd)
[ -f "$ZIP" ] || { echo "error: no zip at $ZIP" >&2; exit 1; }

# The host manifest allows this id alone, so it is read from there.
item=$(sed -nE 's/^const EXTENSION_ID: &str = "([a-p]{32})";$/\1/p' "$root/src-tauri/src/rpc/browsers.rs")
[ -n "$item" ] || { echo "error: no EXTENSION_ID in src-tauri/src/rpc/browsers.rs" >&2; exit 1; }
name="publishers/$CWS_PUBLISHER_ID/items/$item"

fail() {
  echo "error: $1 failed: $2" >&2
  exit 1
}

reply=$(curl -sS https://oauth2.googleapis.com/token \
  -d client_id="$CWS_CLIENT_ID" -d client_secret="$CWS_CLIENT_SECRET" \
  -d refresh_token="$CWS_REFRESH_TOKEN" -d grant_type=refresh_token) || fail "the token request" "curl exited $?"
token=$(jq -r '.access_token // empty' <<<"$reply")
# invalid_grant here usually means the consent screen is still in Testing,
# where a refresh token lasts 7 days.
[ -n "$token" ] || fail "the token request" "$(jq -c '{error, error_description}' <<<"$reply")"

reply=$(curl -sS -X POST "https://chromewebstore.googleapis.com/upload/v2/$name:upload?uploadType=media" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/zip" \
  --data-binary "@$ZIP") || fail "the upload" "curl exited $?"
state=$(jq -r '.uploadState // empty' <<<"$reply")

# A large package is processed after the request returns.
for _ in $(seq 60); do
  case "$state" in
    IN_PROGRESS | UPLOAD_IN_PROGRESS) ;;
    *) break ;;
  esac
  sleep 5
  reply=$(curl -sS "https://chromewebstore.googleapis.com/v2/$name:fetchStatus" \
    -H "Authorization: Bearer $token") || fail "the status check" "curl exited $?"
  state=$(jq -r '.lastAsyncUploadState // empty' <<<"$reply")
done

[ "$state" = SUCCEEDED ] || fail "the upload" "${state:-no state}: $(jq -c . <<<"$reply")"
echo "uploadState: SUCCEEDED for $item, version $(unzip -p "$ZIP" manifest.json | jq -r .version)"
