#!/usr/bin/env bash
# Cut a release locally: build the universal DMG, verify it, tag, publish on
# the public releases repo, and bump the Homebrew cask. Local counterpart of
# release.yml for when CI macOS minutes are not worth paying for.
#
#   scripts/release.sh
#
# The version is read from src-tauri/tauri.conf.json; bump it (everywhere)
# and write the changelog section before running. Needs `gh` logged in to an
# account with write access to both public repos.
set -euo pipefail

RELEASES_REPO=skarif2/sway-releases
TAP_REPO=skarif2/homebrew-tap

cd "$(git rev-parse --show-toplevel)"

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
tag="v$version"

# --- Fail-fast checks, all before the long build ---------------------------

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty; the tag must point at a real commit" >&2
  exit 1
fi

pkg=$(node -p "require('./package.json').version")
crate=$(grep -m1 '^version = ' src-tauri/Cargo.toml | cut -d'"' -f2)
if [ "$pkg" != "$version" ] || [ "$crate" != "$version" ]; then
  echo "error: version drift: tauri.conf.json=$version package.json=$pkg Cargo.toml=$crate" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "error: tag $tag already exists; bump the version first" >&2
  exit 1
fi
if gh release view "$tag" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  echo "error: release $tag already exists on $RELEASES_REPO" >&2
  exit 1
fi

notes=$(mktemp)
.github/scripts/changelog-section.sh "$version" > "$notes"

printf 'Releasing Sway %s (tag %s). Continue? [y/N] ' "$version" "$tag"
read -r answer
[ "$answer" = y ] || { echo "aborted"; exit 1; }

# --- Build and verify ------------------------------------------------------

rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm install --frozen-lockfile
pnpm tauri build --target universal-apple-darwin

app="src-tauri/target/universal-apple-darwin/release/bundle/macos/Sway.app"
.github/scripts/check-universal.sh "$app"

shopt -s nullglob
dmgs=(src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg)
if [ ${#dmgs[@]} -ne 1 ]; then
  echo "error: expected one DMG, found ${#dmgs[@]}: ${dmgs[*]-none}" >&2
  exit 1
fi
dmg="${dmgs[0]}"
asset=$(basename "$dmg")
sha=$(shasum -a 256 "$dmg" | cut -d' ' -f1)

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
  --title "Sway $tag" \
  --notes-file "$notes" \
  "$dmg"

uploaded=$(gh release view "$tag" --repo "$RELEASES_REPO" --json assets -q '.assets[].name')
if [ "$uploaded" != "$asset" ]; then
  echo "error: release draft is missing the DMG (saw: ${uploaded:-nothing}); left as draft" >&2
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
cat > "$tap/Casks/sway.rb" <<EOF
cask "sway" do
  version "$version"
  sha256 "$sha"

  url "https://github.com/${RELEASES_REPO}/releases/download/v#{version}/$pattern"
  name "Sway"
  desc "Dev workflow manager: session tree + Claude terminal + editor"
  homepage "https://github.com/${RELEASES_REPO}"

  app "Sway.app"
end
EOF
git -C "$tap" add Casks/sway.rb
git -C "$tap" commit -m "sway $version"
git -C "$tap" push
rm -rf "$tap" "$notes"

echo
echo "Released Sway $version:"
echo "  https://github.com/${RELEASES_REPO}/releases/tag/$tag"
echo "  brew install --cask skarif2/tap/sway --no-quarantine"
