#!/usr/bin/env bash
# Put the Developer ID into a keychain of its own on a CI runner and print
# the identity's hash, the form codesign and Tauri take without any name
# matching. Tauri's bundler can import the certificate itself, but it keeps
# the keychain private and reports only "failed to resolve signing identity",
# so the one thing worth knowing, what the keychain held and whether macOS
# considered it valid, is lost. This does the same import in the open.
#
# The Developer ID G2 intermediate is imported alongside: an exported .p12
# carries the leaf and its key but not the chain, and a leaf whose issuer is
# unknown to the runner is not a *valid* identity, so `find-identity -v`
# leaves it out and signing fails even though the import succeeded.
#
# Reads APPLE_CERTIFICATE (base64 .p12) and APPLE_CERTIFICATE_PASSWORD. Writes
# APPLE_SIGNING_IDENTITY to $GITHUB_ENV when that is set, so every later step
# of the job signs with it.
#
#   .github/scripts/import-signing-identity.sh
set -euo pipefail

: "${APPLE_CERTIFICATE:?APPLE_CERTIFICATE is not set}"
: "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD is not set}"

keychain="$HOME/Library/Keychains/tori-signing.keychain-db"
keychain_password=$(openssl rand -hex 16)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$work/cert.p12"
curl -fsSL -o "$work/DeveloperIDG2CA.cer" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/DeveloperIDG2CA.cer" -k "$keychain" -T /usr/bin/codesign
security import "$work/cert.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productsign
# Lets codesign use the key without the keychain asking on a UI nobody sees.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# In front of the login keychain, so a lookup by hash finds it first.
existing=()
while IFS= read -r line; do
  existing+=("$(printf '%s' "$line" | sed -e 's/^[[:space:]]*"//' -e 's/"$//')")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$keychain" "${existing[@]}"

echo "identities in $keychain:"
security find-identity -p codesigning "$keychain" | sed 's/^/  /'

hashes=$(security find-identity -v -p codesigning "$keychain" |
  grep 'Developer ID Application' | awk '{print $2}' || true)
count=$(printf '%s\n' "$hashes" | grep -c . || true)
if [ "$count" -ne 1 ]; then
  echo "error: expected one valid 'Developer ID Application' identity, found $count; the unfiltered list above says why (a 'CSSMERR_TP_NOT_TRUSTED' means the chain is incomplete)" >&2
  exit 1
fi

echo "signing identity: $hashes"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "APPLE_SIGNING_IDENTITY=$hashes" >> "$GITHUB_ENV"
fi
