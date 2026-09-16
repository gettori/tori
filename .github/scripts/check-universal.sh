#!/usr/bin/env bash
# Fail if any Mach-O file inside a built .app is not universal (x86_64+arm64).
#
# Building with --target universal-apple-darwin makes the *main binary*
# universal and nothing else. Bundled resources are installed separately - the
# LSP resources come from `npm install` at build time - so a dependency that
# ships a prebuilt native binary would be baked in at the runner's architecture
# only, and the app would fail on Intel Macs in a way `lipo` on the main binary
# never reveals. This sweeps everything in the bundle.
#
#   .github/scripts/check-universal.sh path/to/Tori.app
set -euo pipefail

APP="${1:?usage: check-universal.sh <path to .app>}"

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

  if [[ "$archs" == *x86_64* && "$archs" == *arm64* ]]; then
    continue
  fi

  echo "  NOT UNIVERSAL: ${file#"$APP"/} (archs: ${archs:-unreadable})" >&2
  fail=1
done < <(find "$APP" -type f)

if [ "$checked" -eq 0 ]; then
  # A bundle with no Mach-O at all means the path is wrong or the build did not
  # produce one; passing silently here would make the whole check decorative.
  echo "error: found no Mach-O files under $APP - wrong path, or a broken build?" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAIL: $APP contains single-architecture Mach-O files (see above)." >&2
  echo "Intel Macs would not run this build. Pin or replace the offending dependency." >&2
  exit 1
fi

echo "OK: all $checked Mach-O file(s) in $APP are universal (x86_64 + arm64)."
