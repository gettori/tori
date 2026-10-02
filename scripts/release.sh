#!/usr/bin/env bash
# Cut a release in two steps, with a pull request between them, because `main`
# takes no direct push:
#
#   scripts/release.sh prepare   open the release PR: version bump + changelog
#   (merge the PR on GitHub)
#   scripts/release.sh publish   build, tag, publish, bump the Homebrew cask
#   scripts/release.sh status    say which of those is next
#
# Add --yes to prepare or publish to skip the prompt. Without a terminal the
# flag is required, so a script or an agent never publishes by accident.
# docs/RELEASING.md walks through all of it, including what to do when a step
# fails halfway.
#
# `prepare` can run from any checkout: it works in a throwaway worktree of
# origin/main and leaves yours alone. The version is YY.MDD.patch from today's
# UTC date; the patch is the next free number for that date. The stage suffix
# (-alpha, -beta, none) is carried over from the current version in
# src-tauri/tauri.conf.json, so editing the suffix there is how a release
# changes stage. The changelog's `## Unreleased` section becomes the release's.
#
# `publish` must run in a checkout sitting exactly on origin/main, with the
# release commit as its tip: it builds what is on disk, and the tag has to name
# the commit that was built. It builds the universal DMG and the Android APK,
# and is the real path until release.yml signs: it has the Android keystore,
# which CI does not.
#
# Needs `gh` logged in with write access to this repo and the tap.
set -euo pipefail

RELEASES_REPO=gettori/tori
TAP_REPO=gettori/homebrew-tap
BASE=main

usage() {
  echo "usage: scripts/release.sh prepare|publish|status [--yes]" >&2
}

die() {
  echo "error: $*" >&2
  exit 1
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
yes=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) yes=1 ;;
    *)
      usage
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

confirm() {
  [ "$yes" = 1 ] && return 0
  [ -t 0 ] || die "no terminal to ask on; pass --yes to run $cmd without the prompt"
  printf '%s [y/N] ' "$1"
  read -r answer
  [ "$answer" = y ] || die "aborted"
}

# The desktop and the phone app share one version, so five files carry it.
# Prints it, or fails when they disagree.
version_in() {
  local dir=$1 conf pkg crate mconf mcrate
  conf=$(node -p "require('$dir/src-tauri/tauri.conf.json').version")
  pkg=$(node -p "require('$dir/package.json').version")
  crate=$(grep -m1 '^version = ' "$dir/src-tauri/Cargo.toml" | cut -d'"' -f2)
  mconf=$(node -p "require('$dir/mobile/src-tauri/tauri.conf.json').version")
  mcrate=$(grep -m1 '^version = ' "$dir/mobile/src-tauri/Cargo.toml" | cut -d'"' -f2)
  if [ "$pkg" != "$conf" ] || [ "$crate" != "$conf" ] || [ "$mconf" != "$conf" ] || [ "$mcrate" != "$conf" ]; then
    die "version drift: tauri.conf.json=$conf package.json=$pkg Cargo.toml=$crate mobile/tauri.conf.json=$mconf mobile/Cargo.toml=$mcrate"
  fi
  printf '%s\n' "$conf"
}

open_release_pr() {
  gh pr list --repo "$RELEASES_REPO" --state open --base "$BASE" --json number,headRefName,url \
    -q '[.[] | select(.headRefName | startswith("release/"))][0] | select(.) | "#\(.number) \(.url)"'
}

# none, draft or published.
release_state() {
  local draft
  draft=$(gh release view "$1" --repo "$RELEASES_REPO" --json isDraft -q .isDraft 2>/dev/null) || {
    echo none
    return
  }
  if [ "$draft" = true ]; then echo draft; else echo published; fi
}

# --- prepare ---------------------------------------------------------------

prepare() {
  git fetch -q --tags origin "$BASE"

  local pr
  pr=$(open_release_pr)
  [ -z "$pr" ] || die "a release PR is already open ($pr); merge or close it first"

  # Not local: the trap runs after this function has returned.
  work=$(mktemp -d)
  branch=""
  cleanup() {
    git worktree remove --force "$work" 2>/dev/null || true
    [ -z "$branch" ] || git branch -q -D "$branch" 2>/dev/null || true
  }
  trap cleanup EXIT
  git worktree add -q --detach "$work" "origin/$BASE"

  local current suffix="" yy mdd patch version tag
  current=$(version_in "$work")
  case "$current" in *-*) suffix="-${current#*-}" ;; esac
  yy=$(date -u +%y)
  mdd=$(($(date -u +%-m) * 100 + $(date -u +%-d)))
  # The patch namespace is shared across suffixes: an alpha and a stable cut the
  # same day get distinct patches, so neither tag ever collides.
  patch=$(git tag -l "v$yy.$mdd.*" |
    sed -E "s/^v$yy\.$mdd\.([0-9]+).*/\1/" |
    sort -n | tail -1)
  patch=$((${patch:--1} + 1))
  version="$yy.$mdd.$patch$suffix"
  tag="v$version"
  branch="release/$version"

  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    branch=""
    die "branch release/$version already exists on origin; delete it or merge its PR first"
  fi
  git -C "$work" switch -q -c "$branch"

  # The notes are whatever was collected under Unreleased, unless somebody
  # already wrote the section under its version.
  if ! grep -qx "## $version" "$work/CHANGELOG.md"; then
    grep -qx "## Unreleased" "$work/CHANGELOG.md" ||
      die "CHANGELOG.md on $BASE has neither '## Unreleased' nor '## $version'; the release body comes from it"
    sed -i '' "s/^## Unreleased$/## $version/" "$work/CHANGELOG.md"
  fi
  local notes
  notes=$(mktemp)
  (cd "$work" && .github/scripts/changelog-section.sh "$version" >"$notes")

  echo "Tori $version (tag $tag, was $current)"
  echo "--- release notes ---"
  cat "$notes"
  echo "---------------------"
  confirm "Open the release PR for Tori $version?"

  sed -i '' "s/\"version\": \"$current\"/\"version\": \"$version\"/" \
    "$work/package.json" "$work/src-tauri/tauri.conf.json" "$work/mobile/src-tauri/tauri.conf.json"
  sed -i '' "s/^version = \"$current\"/version = \"$version\"/" \
    "$work/src-tauri/Cargo.toml" "$work/mobile/src-tauri/Cargo.toml"
  (cd "$work/src-tauri" && cargo update -q --package tori)
  (cd "$work/mobile/src-tauri" && cargo update -q --package tori-mobile)
  [ "$(version_in "$work")" = "$version" ] || die "the version did not land in all five files"

  git -C "$work" add CHANGELOG.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
    mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.toml mobile/src-tauri/Cargo.lock
  git -C "$work" commit -q -m "Tori $version"
  git -C "$work" push -q origin "$branch"

  local url
  url=$(gh pr create --repo "$RELEASES_REPO" --base "$BASE" --head "$branch" \
    --title "Tori $version" --body-file "$notes")
  rm -f "$notes"

  echo
  echo "Release PR for Tori $version: $url"
  echo "Next: merge it, then from an up to date checkout of $BASE run"
  echo "  scripts/release.sh publish"
}

# --- publish ---------------------------------------------------------------

publish() {
  git fetch -q --tags origin "$BASE"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "working tree is dirty; publish builds what is on disk, so it must be exactly the release commit"
  fi
  local head tip
  head=$(git rev-parse HEAD)
  tip=$(git rev-parse "origin/$BASE")
  [ "$head" = "$tip" ] ||
    die "HEAD is ${head:0:8} and origin/$BASE is ${tip:0:8}; run publish from a checkout of $BASE that is up to date (git pull)"

  local version tag subject
  version=$(version_in .)
  tag="v$version"
  # Anything merged after the release PR would ship under this version without
  # being in its notes.
  subject=$(git log -1 --format=%s)
  [ "$subject" = "Tori $version" ] ||
    die "the tip of $BASE is \"$subject\", not the release commit \"Tori $version\"; run prepare and merge its PR first, and publish before anything else merges"

  if git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null; then
    [ "$(git rev-parse "refs/tags/$tag^{commit}")" = "$head" ] ||
      die "tag $tag already exists and names another commit"
  fi
  local state
  state=$(release_state "$tag")
  [ "$state" != published ] || die "release $tag is already published on $RELEASES_REPO"

  # A private repo's release assets cannot be downloaded, so the cask and every
  # install link would 404.
  [ "$(gh repo view "$RELEASES_REPO" --json visibility -q .visibility)" = PUBLIC ] ||
    die "$RELEASES_REPO is not public; its release assets would not be downloadable"

  # The Android toolchain, resolved here rather than at build time: a missing NDK
  # should cost a second, not a universal macOS build. Tori's own shell does not
  # export these, so the usual macOS locations are the defaults.
  : "${JAVA_HOME:=/opt/homebrew/opt/openjdk@17}"
  : "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
  if [ -z "${NDK_HOME:-}" ]; then
    NDK_HOME=$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)
  fi
  export JAVA_HOME ANDROID_HOME NDK_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
  local dir
  for dir in "$JAVA_HOME" "$ANDROID_HOME" "${NDK_HOME:-}"; do
    if [ -z "$dir" ] || [ ! -d "$dir" ]; then
      die "Android toolchain incomplete: JAVA_HOME=$JAVA_HOME ANDROID_HOME=$ANDROID_HOME NDK_HOME=${NDK_HOME:-unset}"
    fi
  done

  local apksigner
  apksigner=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)
  [ -n "$apksigner" ] || die "no apksigner under $ANDROID_HOME/build-tools"

  # Android refuses to install an unsigned APK, and the signing config falls back
  # to unsigned when this file is missing rather than failing the Gradle build.
  [ -f mobile/src-tauri/gen/android/keystore.properties ] ||
    die "no mobile/src-tauri/gen/android/keystore.properties; the APK would be unsigned"

  local notes
  notes=$(mktemp)
  .github/scripts/changelog-section.sh "$version" >"$notes"

  confirm "Build and publish Tori $version from ${head:0:8}?"

  # --- Build and verify ----------------------------------------------------

  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  pnpm install --frozen-lockfile
  pnpm tauri build --target universal-apple-darwin

  local app="src-tauri/target/universal-apple-darwin/release/bundle/macos/Tori.app"
  .github/scripts/check-universal.sh "$app"

  # Matched on the version, not on *.dmg: the bundle dir keeps every DMG a
  # previous release left behind, and a bare glob counts those too.
  shopt -s nullglob
  local dmgs=(src-tauri/target/universal-apple-darwin/release/bundle/dmg/*_"$version"_*.dmg)
  if [ ${#dmgs[@]} -ne 1 ]; then
    die "expected one DMG for $version, found ${#dmgs[@]}: ${dmgs[*]-none}"
  fi
  local dmg="${dmgs[0]}" asset sha
  asset=$(basename "$dmg")
  sha=$(shasum -a 256 "$dmg" | cut -d' ' -f1)

  # --- Build and sign the APK ----------------------------------------------

  rustup target add aarch64-linux-android armv7-linux-androideabi \
    i686-linux-android x86_64-linux-android
  (cd mobile && pnpm tauri android build --apk)

  # The exact signed name, not a glob: an earlier unsigned build leaves its own
  # APK in this directory, and uploading that one would ship something no phone
  # can install.
  local out=mobile/src-tauri/gen/android/app/build/outputs/apk/universal/release
  if [ ! -f "$out/app-universal-release.apk" ]; then
    ls -1 "$out" >&2 || true
    die "no signed APK at $out/app-universal-release.apk"
  fi

  # Named for the release, because the asset keeps the name Gradle gave it.
  local apk="$out/Tori_$version.apk" apk_asset
  cp "$out/app-universal-release.apk" "$apk"
  apk_asset=$(basename "$apk")
  "$apksigner" verify --print-certs "$apk"

  # --- Tag and publish -----------------------------------------------------

  # Only now, with both artifacts in hand: a build that fails leaves no tag, so
  # publish can simply be run again.
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git tag "$tag"
  git push -q origin "$tag"

  # A draft left by a run that died during upload is replaced, not resumed.
  [ "$state" != draft ] || gh release delete "$tag" --repo "$RELEASES_REPO" --yes

  # Drafted first so a failed upload never leaves a live release without its
  # asset; published only after the asset is confirmed present.
  local flags=(--draft --verify-tag)
  case "$version" in *-*) flags+=(--prerelease) ;; esac
  gh release create "$tag" \
    --repo "$RELEASES_REPO" \
    "${flags[@]}" \
    --title "Tori $tag" \
    --notes-file "$notes" \
    "$dmg" "$apk"

  local uploaded want
  uploaded=$(gh release view "$tag" --repo "$RELEASES_REPO" --json assets -q '.assets[].name' | sort)
  want=$(printf '%s\n%s\n' "$asset" "$apk_asset" | sort)
  [ "$uploaded" = "$want" ] ||
    die "release draft is missing an asset (saw: ${uploaded:-nothing}); left as draft, run publish again"
  gh release edit "$tag" --repo "$RELEASES_REPO" --draft=false

  # --- Bump the cask -------------------------------------------------------

  local tap pattern
  tap=$(mktemp -d)
  git clone -q --depth 1 "https://github.com/${TAP_REPO}.git" "$tap"
  mkdir -p "$tap/Casks"
  # The literal version becomes Ruby's #{version} so the url stanza
  # interpolates, keeping a manual bump to two lines.
  pattern=$(printf '%s' "$asset" | sed "s/$version/#{version}/")
  cat >"$tap/Casks/tori.rb" <<EOF
cask "tori" do
  version "$version"
  sha256 "$sha"

  url "https://github.com/${RELEASES_REPO}/releases/download/v#{version}/$pattern"
  name "Tori"
  desc "Cockpit for the coding agents you already run"
  homepage "https://gettori.app"

  # No version bound: the bundle sets no minimum, so older macOS is untested
  # rather than blocked, and this says only what the app really requires.
  depends_on :macos

  app "Tori.app"

  # Homebrew 6 removed --no-quarantine, and the app is unsigned, so without
  # this Gatekeeper reports it as damaged. postflight_steps rather than the
  # postflight block it replaces, which Homebrew 7 deprecates and warns about
  # on every read. Drop the whole stanza once builds are signed and notarized.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-cr", "{{appdir}}/Tori.app"]
  end
end
EOF
  git -C "$tap" add Casks/tori.rb
  if git -C "$tap" diff --cached --quiet; then
    echo "cask already at $version"
  else
    git -C "$tap" commit -q -m "tori $version"
    git -C "$tap" push -q
  fi
  rm -rf "$tap" "$notes"

  echo
  echo "Released Tori $version:"
  echo "  https://github.com/${RELEASES_REPO}/releases/tag/$tag"
  echo "  brew install --cask gettori/tap/tori"
  echo "  $apk_asset for Android"
}

# --- status ----------------------------------------------------------------

status() {
  git fetch -q --tags origin "$BASE"
  local version tag subject state pr last ahead
  version=$(git show "origin/$BASE:src-tauri/tauri.conf.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
  tag="v$version"
  subject=$(git log -1 --format=%s "origin/$BASE")
  state=$(release_state "$tag")
  pr=$(open_release_pr)
  last=$(git describe --tags --abbrev=0 "origin/$BASE" 2>/dev/null || true)
  ahead=$(git rev-list --count "${last:+$last..}origin/$BASE")

  echo "$BASE is at $version, tip \"$subject\""
  echo "release $tag: $state"
  echo "last tag on $BASE: ${last:-none}, $ahead commits since"
  echo "open release PR: ${pr:-none}"
  if [ -n "$pr" ]; then
    echo "next: merge the release PR, then scripts/release.sh publish"
  elif [ "$subject" = "Tori $version" ] && [ "$state" = draft ]; then
    echo "next: scripts/release.sh publish (a draft is left from a run that stopped)"
  elif [ "$subject" = "Tori $version" ] && [ "$state" = none ] && [ "$last" != "$tag" ]; then
    echo "next: scripts/release.sh publish"
  elif [ "$subject" = "Tori $version" ] && [ "$state" = none ]; then
    echo "next: nothing, unless a publish stopped after tagging: then run publish again"
  elif [ "$ahead" -gt 0 ]; then
    echo "next: scripts/release.sh prepare"
  else
    echo "next: nothing to release"
  fi
}

case "$cmd" in
  prepare) prepare ;;
  publish) publish ;;
  status) status ;;
  *)
    usage
    exit 2
    ;;
esac
