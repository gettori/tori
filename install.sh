#!/bin/sh
# gettori.app/install redirects to this file on main, so moving or renaming it
# breaks that URL.
# The asset name and team id must match the in-app updater's (update.rs).
# Everything runs from main() at the bottom, so a download cut off halfway
# runs nothing.
set -eu

REPO="gettori/tori"
TEAM_ID="C328TXY8Q3"
DEST="${TORI_DEST:-/Applications/Tori.app}"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

# The arch half of the asset name. A terminal running under Rosetta reports
# x86_64 on Apple Silicon, so the hardware is asked as well.
arch() {
  case "$(uname -m)" in
    arm64) echo aarch64 ;;
    x86_64)
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then echo aarch64; else echo x64; fi
      ;;
    *) die "no Tori build for $(uname -m) Macs" ;;
  esac
}

# plutil reads JSON as well as plists, and ships with every Mac, so no jq.
field() { plutil -extract "$1" raw -o - "$2" 2>/dev/null; }

verify() {
  app=$1
  version=$2
  codesign --verify --deep --strict "$app" 2>/dev/null || die "the download's signature does not verify"
  team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [ "$team" = "$TEAM_ID" ] || die "the download is signed by ${team:-nobody}, not Tori's team"
  spctl --assess --type execute "$app" 2>/dev/null || die "Gatekeeper refuses the download"
  [ "$(field CFBundleShortVersionString "$app/Contents/Info.plist")" = "$version" ] ||
    die "the download is not version $version"
}

main() {
  [ "$(uname -s)" = Darwin ] || die "Tori runs on macOS only, for now"
  build=$(arch)
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  curl -fsSL -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases/latest" -o "$work/release.json" ||
    die "could not reach GitHub"
  tag=$(field tag_name "$work/release.json") || die "GitHub did not name a latest release"
  version=${tag#v}

  if [ -d "$DEST" ] && [ "$(field CFBundleShortVersionString "$DEST/Contents/Info.plist")" = "$version" ]; then
    say "Tori $version is already installed."
    open "$DEST"
    return
  fi

  asset="Tori_${version}_${build}.app.tar.gz"
  say "Downloading Tori $version for $( [ "$build" = aarch64 ] && echo 'Apple Silicon' || echo Intel )..."
  curl -fL --progress-bar "https://github.com/$REPO/releases/download/$tag/$asset" -o "$work/$asset" ||
    die "this release has no $asset"
  tar -xzf "$work/$asset" -C "$work"
  verify "$work/Tori.app" "$version"

  sudo=""
  [ -w "$(dirname "$DEST")" ] || sudo=sudo
  # Staged beside the destination so the swap is a rename on one volume.
  staged="$(dirname "$DEST")/.Tori-install-$$"
  aside="$(dirname "$DEST")/.Tori-old-$$"
  $sudo rm -rf "$staged" "$aside"
  $sudo ditto "$work/Tori.app" "$staged"
  if [ -d "$DEST" ]; then
    $sudo mv "$DEST" "$aside"
  fi
  if ! $sudo mv "$staged" "$DEST"; then
    if [ -d "$aside" ]; then $sudo mv "$aside" "$DEST"; fi
    $sudo rm -rf "$staged"
    die "could not put Tori in $DEST"
  fi
  $sudo rm -rf "$aside"

  say "Tori $version is installed at $DEST. It keeps itself up to date from here."
  open "$DEST"
}

main "$@"
