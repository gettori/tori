#!/usr/bin/env bash
# Decide whether a release ships a component: print its name when anything it
# is built from changed since its last tag, nothing otherwise. Both exit 0,
# the output is the answer; --force prints it without looking.
#
# Nothing here lists what a component is built from, a list drifts as the phone
# imports more of src/: the vite build writes what it bundled
# (scripts/bundled-inputs.ts) and cargo metadata says what the crate reaches.
# Lockfiles stay out of the file diff since they move on nearly every release;
# the versions the build used are checked against the tag's lockfile instead.
#
#   .github/scripts/ships.sh <macos|android|extension> [since-tag] [--force]
#
# Judges the checkout it lives in: the working tree is built and diffed.
set -euo pipefail
export LC_ALL=C

force=false
args=()
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    *) args+=("$arg") ;;
  esac
done
COMPONENT="${args[0]:?usage: ships.sh <macos|android|extension> [since-tag] [--force]}"
SINCE="${args[1]:-}"

cd "$(dirname "$0")/../.."
# shellcheck source=.github/scripts/components.sh
. .github/scripts/components.sh

die() {
  echo "error: $*" >&2
  exit 1
}

case "$COMPONENT" in
  macos)
    build=desktop
    dir=.
    crate=src-tauri
    platforms="aarch64-apple-darwin x86_64-apple-darwin"
    ;;
  android)
    build=mobile
    dir=mobile
    crate=mobile/src-tauri
    platforms=aarch64-linux-android
    ;;
  extension)
    build=extension
    dir=extension
    crate=""
    platforms=""
    ;;
  *) die "unknown component $COMPONENT (macos, android or extension)" ;;
esac

# Without a tag for the version the component carries, its last release never
# finished, so the newest tag reachable stands in.
baseline_tag() {
  local file version
  file=$(version_files "$COMPONENT" | head -1)
  # shellcheck disable=SC2094 # the name only picks the parser
  version=$(read_version "$file" <"$file")
  released_tag "$COMPONENT" "$version" <<<"$(git tag -l)" && return
  git describe --tags --abbrev=0 --match "$COMPONENT-v*" HEAD 2>/dev/null ||
    git describe --tags --abbrev=0 --match "v*" HEAD 2>/dev/null ||
    die "no $COMPONENT-v* or v* tag reachable; pass the baseline tag"
}

[ -n "$SINCE" ] || SINCE=$(baseline_tag)
git rev-parse -q --verify "$SINCE^{commit}" >/dev/null || die "no such tag or commit: $SINCE"

ships() {
  echo "$COMPONENT: $1" >&2
  echo "$COMPONENT"
  exit 0
}

if $force; then
  ships "--force"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pnpm_lock_versions() {
  awk '/^packages:/ { on = 1; next } /^[^ ]/ { on = 0 } on && /^  [^ ]/ { sub(/^  /, ""); print }' | tr -d "':" | sort
}

cargo_lock_versions() {
  awk -F'"' '/^name = / { name = $2 } /^version = / && $2 != "" { print name "@" $2 }' | sort
}

package_names() {
  sed -E 's/^(@?[^@]+)@.*/\1/' | sort -u
}

lock_drift() {
  local what=$1 used=$2 tag=$3 tip=$4 hit
  hit=$(comm -23 "$used" "$tag" | head -1)
  if [ -n "$hit" ]; then
    echo "$hit is not in $SINCE's $what"
    return
  fi
  # A version the tag held and the tip dropped, of a package the build uses:
  # the build moved to a version the tag's lockfile already had for another
  # package, which the first check cannot see.
  hit=$(comm -23 "$tag" "$tip" | package_names | comm -12 - <(package_names <"$used") | head -1)
  [ -z "$hit" ] || echo "$SINCE's $what held another version of $hit"
}

# A no-op in a current checkout and what a fresh worktree needs. Scripts stay
# off: the root prepare script sets up git hooks, which a build worktree must
# not do, since the config it writes is shared with every checkout.
if ! pnpm install --frozen-lockfile --prefer-offline --ignore-scripts >"$tmp/install.log" 2>&1; then
  cat "$tmp/install.log" >&2
  die "pnpm install failed"
fi
inputs="node_modules/.tori/inputs/$build.tsv"
rm -f "$inputs"
if ! pnpm --dir "$dir" build >"$tmp/build.log" 2>&1; then
  cat "$tmp/build.log" >&2
  die "the $build build failed"
fi
[ -s "$inputs" ] || die "the $build build wrote no $inputs; is scripts/bundled-inputs.ts in its vite config?"
hit=$(awk -F'\t' '$1 == "unknown" { print $2; exit }' "$inputs")
[ -z "$hit" ] || die "the $build build has an input this script cannot place: $hit"

files=()
while IFS= read -r file; do files+=("$file"); done < <(awk -F'\t' '$1 == "file" { print $2 }' "$inputs")
hit=$(git diff --name-only "$SINCE" -- "${files[@]}" | head -1)
[ -z "$hit" ] || ships "$hit differs from $SINCE"

awk -F'\t' '$1 == "package" { print $2 }' "$inputs" | sort >"$tmp/pnpm.used"
git show "$SINCE:pnpm-lock.yaml" | pnpm_lock_versions >"$tmp/pnpm.tag"
pnpm_lock_versions <pnpm-lock.yaml >"$tmp/pnpm.tip"
hit=$(lock_drift pnpm-lock.yaml "$tmp/pnpm.used" "$tmp/pnpm.tag" "$tmp/pnpm.tip")
[ -z "$hit" ] || ships "$hit"

if [ -n "$crate" ]; then
  filter=()
  for platform in $platforms; do filter+=(--filter-platform "$platform"); done
  cargo metadata --format-version 1 --locked --manifest-path "$crate/Cargo.toml" "${filter[@]}" |
    node -e '
      const path = require("node:path");
      const meta = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      for (const p of meta.packages) {
        if (p.source) console.log(`crate\t${p.name}@${p.version}`);
        else console.log(`path\t${path.relative(process.cwd(), path.dirname(p.manifest_path))}`);
      }
    ' >"$tmp/cargo.tsv"
  paths=()
  while IFS= read -r path; do paths+=("$path"); done < <(awk -F'\t' '$1 == "path" { print $2 }' "$tmp/cargo.tsv")
  while IFS= read -r icon; do paths+=("$icon"); done < <(node -e '
    const path = require("node:path");
    const crate = process.argv[1];
    for (const icon of require(`./${crate}/tauri.conf.json`).bundle.icon) {
      console.log(path.relative(process.cwd(), path.resolve(crate, icon)));
    }
  ' "$crate")
  hit=$(git diff --name-only "$SINCE" -- "${paths[@]}" ":!$crate/Cargo.lock" | head -1)
  [ -z "$hit" ] || ships "$hit differs from $SINCE"

  awk -F'\t' '$1 == "crate" { print $2 }' "$tmp/cargo.tsv" | sort >"$tmp/cargo.used"
  git show "$SINCE:$crate/Cargo.lock" | cargo_lock_versions >"$tmp/cargo.tag"
  cargo_lock_versions <"$crate/Cargo.lock" >"$tmp/cargo.tip"
  hit=$(lock_drift "$crate/Cargo.lock" "$tmp/cargo.used" "$tmp/cargo.tag" "$tmp/cargo.tip")
  [ -z "$hit" ] || ships "$hit"
fi

echo "$COMPONENT: unchanged since $SINCE" >&2
