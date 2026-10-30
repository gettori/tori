# shellcheck shell=bash
# Sourced by scripts/release.sh and .github/scripts/ships.sh: where each
# component carries its version, and which tag released one.

# The files that carry a component's version; the first is where it is read.
version_files() {
  case "$1" in
    macos) printf '%s\n' src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml ;;
    android) printf '%s\n' mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.toml ;;
    extension) printf '%s\n' extension/package.json ;;
  esac
}

read_version() {
  case "$1" in
    *.toml) grep -m1 '^version = ' | cut -d'"' -f2 ;;
    *) node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version" ;;
  esac
}

# Chrome reads four numbers at most, so the extension drops the stage suffix.
version_for() {
  local component=$1 release=$2
  case "$component" in
    extension) echo "${release%%-*}" ;;
    *) echo "$release" ;;
  esac
}

# Releases before each platform got its own prefix were tagged v<release>, and
# the extension's version is that release's without the stage suffix.
released_tag() {
  local component=$1 version=$2 tag
  while IFS= read -r tag; do
    case "$tag" in
      "$component-v$version" | "v$version") ;;
      "v$version"-*) [ "$component" = extension ] || continue ;;
      *) continue ;;
    esac
    echo "$tag"
    return 0
  done
  return 1
}
