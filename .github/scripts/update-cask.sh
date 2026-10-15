#!/usr/bin/env bash
# Point the Homebrew tap at a *published* release: download its two DMGs,
# checksum them, rewrite Casks/tori.rb whole from the template below, and
# push. Rewriting the whole file rather than sed-patching fields is what lets
# the same run create the file the first time.
#
# A draft's assets are not publicly downloadable, so a cask written against
# one would 404 for every tester; the script refuses a draft. Needs GH_TOKEN
# able to read releases on gettori/tori and TAP_TOKEN, a fine-grained PAT with
# Contents read/write on the tap repo, since github.token cannot push anywhere
# but its own repo.
#
#   .github/scripts/update-cask.sh 26.1016.0-alpha
set -euo pipefail

VERSION="${1:?usage: update-cask.sh <published version, without the v>}"
: "${TAP_TOKEN:?TAP_TOKEN is not set}"
RELEASES_REPO="${RELEASES_REPO:-gettori/tori}"
TAP_REPO="${TAP_REPO:-gettori/homebrew-tap}"
tag="v$VERSION"

if [ "$(gh release view "$tag" --repo "$RELEASES_REPO" --json isDraft -q .isDraft)" = true ]; then
  echo "error: $tag is still a draft; publish it first, brew cannot download draft assets" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh release download "$tag" --repo "$RELEASES_REPO" --pattern '*.dmg' --dir "$work/dmg"

sha_for() {
  local files=("$work"/dmg/*_"$1".dmg)
  if [ ${#files[@]} -ne 1 ] || [ ! -f "${files[0]}" ]; then
    echo "error: expected one *_$1.dmg asset on $tag, found: $(ls "$work/dmg")" >&2
    exit 1
  fi
  shasum -a 256 "${files[0]}" | cut -d' ' -f1
}
arm_sha=$(sha_for aarch64)
intel_sha=$(sha_for x64)

git clone -q "https://x-access-token:${TAP_TOKEN}@github.com/${TAP_REPO}.git" "$work/tap"
mkdir -p "$work/tap/Casks"
# Tauri names the DMGs after the Rust arch (aarch64, x64), so the cask's arch
# stanza maps brew's names onto those, and #{arch} in the url picks the file.
cat >"$work/tap/Casks/tori.rb" <<EOF
cask "tori" do
  arch arm: "aarch64", intel: "x64"

  version "$VERSION"
  sha256 arm:   "$arm_sha",
         intel: "$intel_sha"

  url "https://github.com/${RELEASES_REPO}/releases/download/v#{version}/Tori_#{version}_#{arch}.dmg"
  name "Tori"
  desc "Cockpit for the coding agents you already run"
  homepage "https://gettori.app"

  # No version bound: the bundle sets no minimum, so older macOS is untested
  # rather than blocked, and this says only what the app really requires.
  depends_on :macos

  app "Tori.app"
end
EOF

cd "$work/tap"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add Casks/tori.rb
if git diff --cached --quiet; then
  echo "cask already at $VERSION, nothing to push"
  exit 0
fi
git commit -q -m "tori $VERSION"
git push -q
echo "ok: cask at $VERSION"
