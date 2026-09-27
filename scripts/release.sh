#!/usr/bin/env bash
# Cut a release locally: derive the version, build the universal DMG and the
# Android APK, verify both, tag, publish them on the public releases repo, and
# bump the Homebrew cask. Local counterpart of release.yml for when CI macOS
# minutes are not worth paying for.
#
# The desktop and the phone app share one version, so five files carry it and
# all five are checked before anything is built.
#
#   scripts/release.sh
#
# The version is YY.MDD.patch from today's UTC date; the patch is the next
# free number for that date. The stage suffix (-alpha, -beta, none) is carried
# over from the current version in src-tauri/tauri.conf.json, so editing the
# suffix there is how a release changes stage. Write the changelog section
# before running. Needs `gh` logged in with write access to both public repos.
set -euo pipefail

RELEASES_REPO=gettori/releases
TAP_REPO=gettori/homebrew-tap

cd "$(git rev-parse --show-toplevel)"

# --- Derive the version ----------------------------------------------------

current=$(node -p "require('./src-tauri/tauri.conf.json').version")
suffix=""
case "$current" in *-*) suffix="-${current#*-}" ;; esac

yy=$(date -u +%y)
mdd=$(( $(date -u +%-m) * 100 + $(date -u +%-d) ))

# The patch namespace is shared across suffixes: an alpha and a stable cut the
# same day get distinct patches, so neither tag ever collides.
git fetch -q --tags origin
patch=$(git tag -l "v$yy.$mdd.*" \
  | sed -E "s/^v$yy\.$mdd\.([0-9]+).*/\1/" \
  | sort -n | tail -1)
patch=$(( ${patch:--1} + 1 ))

version="$yy.$mdd.$patch$suffix"
tag="v$version"

# --- Fail-fast checks, all before the long build ---------------------------

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty; the release commit must stand alone" >&2
  exit 1
fi

pkg=$(node -p "require('./package.json').version")
crate=$(grep -m1 '^version = ' src-tauri/Cargo.toml | cut -d'"' -f2)
mconf=$(node -p "require('./mobile/src-tauri/tauri.conf.json').version")
mcrate=$(grep -m1 '^version = ' mobile/src-tauri/Cargo.toml | cut -d'"' -f2)
if [ "$pkg" != "$current" ] || [ "$crate" != "$current" ] \
  || [ "$mconf" != "$current" ] || [ "$mcrate" != "$current" ]; then
  echo "error: version drift: tauri.conf.json=$current package.json=$pkg Cargo.toml=$crate mobile/tauri.conf.json=$mconf mobile/Cargo.toml=$mcrate" >&2
  exit 1
fi

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
for dir in "$JAVA_HOME" "$ANDROID_HOME" "${NDK_HOME:-}"; do
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo "error: Android toolchain incomplete: JAVA_HOME=$JAVA_HOME ANDROID_HOME=$ANDROID_HOME NDK_HOME=${NDK_HOME:-unset}" >&2
    exit 1
  fi
done

apksigner=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)
if [ -z "$apksigner" ]; then
  echo "error: no apksigner under $ANDROID_HOME/build-tools" >&2
  exit 1
fi

# Android refuses to install an unsigned APK, and the signing config falls back
# to unsigned when this file is missing rather than failing the Gradle build.
if [ ! -f mobile/src-tauri/gen/android/keystore.properties ]; then
  echo "error: no mobile/src-tauri/gen/android/keystore.properties; the APK would be unsigned" >&2
  exit 1
fi

if gh release view "$tag" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  echo "error: release $tag already exists on $RELEASES_REPO" >&2
  exit 1
fi

notes=$(mktemp)
.github/scripts/changelog-section.sh "$version" > "$notes"

printf 'Releasing Tori %s (tag %s, was %s). Continue? [y/N] ' "$version" "$tag" "$current"
read -r answer
[ "$answer" = y ] || { echo "aborted"; exit 1; }

# --- Write the version and commit ------------------------------------------

sed -i '' "s/\"version\": \"$current\"/\"version\": \"$version\"/" \
  package.json src-tauri/tauri.conf.json mobile/src-tauri/tauri.conf.json
sed -i '' "s/^version = \"$current\"/version = \"$version\"/" \
  src-tauri/Cargo.toml mobile/src-tauri/Cargo.toml
(cd src-tauri && cargo update -q --package tori)
(cd mobile/src-tauri && cargo update -q --package tori-mobile)

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
  mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.toml mobile/src-tauri/Cargo.lock
git commit -m "Tori $version"
# Named rather than bare: a worktree checkout usually has no upstream set, and
# releasing from one is ordinary here.
git push origin HEAD

# --- Build and verify ------------------------------------------------------

rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm install --frozen-lockfile
pnpm tauri build --target universal-apple-darwin

app="src-tauri/target/universal-apple-darwin/release/bundle/macos/Tori.app"
.github/scripts/check-universal.sh "$app"

# Matched on the version, not on *.dmg: the bundle dir keeps every DMG a
# previous release left behind, and a bare glob counts those too, failing here
# with the version commit already pushed.
shopt -s nullglob
dmgs=(src-tauri/target/universal-apple-darwin/release/bundle/dmg/*_"$version"_*.dmg)
if [ ${#dmgs[@]} -ne 1 ]; then
  echo "error: expected one DMG for $version, found ${#dmgs[@]}: ${dmgs[*]-none}" >&2
  exit 1
fi
dmg="${dmgs[0]}"
asset=$(basename "$dmg")
sha=$(shasum -a 256 "$dmg" | cut -d' ' -f1)

# --- Build and sign the APK ------------------------------------------------

rustup target add aarch64-linux-android armv7-linux-androideabi \
  i686-linux-android x86_64-linux-android
(cd mobile && pnpm tauri android build --apk)

# The exact signed name, not a glob: an earlier unsigned build leaves its own
# APK in this directory, and uploading that one would ship something no phone
# can install.
out=mobile/src-tauri/gen/android/app/build/outputs/apk/universal/release
if [ ! -f "$out/app-universal-release.apk" ]; then
  echo "error: no signed APK at $out/app-universal-release.apk" >&2
  ls -1 "$out" >&2 || true
  exit 1
fi

# Named for the release, because the asset keeps the name Gradle gave it.
apk="$out/Tori_$version.apk"
cp "$out/app-universal-release.apk" "$apk"
apk_asset=$(basename "$apk")
"$apksigner" verify --print-certs "$apk"

# --- Tag and publish -------------------------------------------------------

git tag "$tag"
git push origin "$tag"

# Drafted first so a failed upload never leaves a live release without its
# asset; published only after the asset is confirmed present.
flags=(--draft)
case "$version" in *-*) flags+=(--prerelease) ;; esac
gh release create "$tag" \
  --repo "$RELEASES_REPO" \
  "${flags[@]}" \
  --title "Tori $tag" \
  --notes-file "$notes" \
  "$dmg" "$apk"

uploaded=$(gh release view "$tag" --repo "$RELEASES_REPO" --json assets -q '.assets[].name' | sort)
want=$(printf '%s\n%s\n' "$asset" "$apk_asset" | sort)
if [ "$uploaded" != "$want" ]; then
  echo "error: release draft is missing an asset (saw: ${uploaded:-nothing}); left as draft" >&2
  exit 1
fi
gh release edit "$tag" --repo "$RELEASES_REPO" --draft=false

# --- Bump the cask ---------------------------------------------------------

tap=$(mktemp -d)
git clone --depth 1 "https://github.com/${TAP_REPO}.git" "$tap"
mkdir -p "$tap/Casks"
# The literal version becomes Ruby's #{version} so the url stanza
# interpolates, keeping a manual bump to two lines.
pattern=$(printf '%s' "$asset" | sed "s/$version/#{version}/")
cat > "$tap/Casks/tori.rb" <<EOF
cask "tori" do
  version "$version"
  sha256 "$sha"

  url "https://github.com/${RELEASES_REPO}/releases/download/v#{version}/$pattern"
  name "Tori"
  desc "Dev workflow manager: session tree + Claude terminal + editor"
  homepage "https://github.com/${RELEASES_REPO}"

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
git -C "$tap" commit -m "tori $version"
git -C "$tap" push
rm -rf "$tap" "$notes"

echo
echo "Released Tori $version:"
echo "  https://github.com/${RELEASES_REPO}/releases/tag/$tag"
echo "  brew install --cask gettori/tap/tori"
echo "  $apk_asset for Android"
