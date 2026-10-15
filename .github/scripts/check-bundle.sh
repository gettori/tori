#!/usr/bin/env bash
# Fail unless every Mach-O inside a built .app is for one architecture and the
# bundle's signature verifies, strictly and all the way down.
#
# Each DMG is built for one arch now, so a file at the other arch, or a fat
# one, means a dependency was baked in at the runner's arch instead of the
# target's. Bundled resources are installed separately from the Rust build
# (the LSP resources come from `npm install` at build time), so a prebuilt
# native binary in one of them is exactly how that would happen, and `lipo`
# on the main binary never shows it. The signature check is the other half:
# notarization rejects a bundle with one unsigned Mach-O in it, after a full
# upload, so this fails first and names the file.
#
#   .github/scripts/check-bundle.sh path/to/Tori.app arm64|x86_64
set -euo pipefail

APP="${1:?usage: check-bundle.sh <path to .app> <arm64|x86_64>}"
ARCH="${2:?usage: check-bundle.sh <path to .app> <arm64|x86_64>}"

if [ ! -d "$APP" ]; then
  echo "error: no app bundle at $APP" >&2
  exit 1
fi

fail=0
checked=0

while IFS= read -r file; do
  # `file` classifies by content, so this skips scripts, JSON, and the rest of
  # the bundle without needing a filename allowlist to keep up to date.
  case "$(file -b "$file")" in
    *Mach-O*) ;;
    *) continue ;;
  esac

  checked=$((checked + 1))
  archs=$(lipo -archs "$file" 2>/dev/null || true)
  if [ "$archs" != "$ARCH" ]; then
    echo "  WRONG ARCH: ${file#"$APP"/} (archs: ${archs:-unreadable}, want $ARCH)" >&2
    fail=1
  fi
done < <(find "$APP" -type f)

if [ "$checked" -eq 0 ]; then
  echo "error: found no Mach-O files under $APP; is that the right path?" >&2
  exit 1
fi

if ! codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/  /'; then
  echo "error: the signature on $APP does not verify" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "ok: $checked Mach-O file(s) in $APP are $ARCH and the bundle signature verifies"
