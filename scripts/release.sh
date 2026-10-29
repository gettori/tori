#!/usr/bin/env bash
# Cut a release: open the release PR, because `main` takes no direct push.
# Merging that PR is the last human step; the Release workflow
# (.github/workflows/release.yml) builds, signs, tags and publishes from it.
#
#   scripts/release.sh prepare   open the release PR: version bump + changelog
#   (merge the PR on GitHub, the workflow does the rest)
#   scripts/release.sh status    say where the release stands
#
# Add --yes to prepare to skip the prompt. Without a terminal the flag is
# required, so a script or an agent never opens a release PR by accident.
# Add --extension to ship the browser extension even when nothing it is built
# from changed (.github/scripts/extension-ships.sh decides otherwise).
# docs/RELEASING.md walks through all of it, including what to do when a step
# fails halfway.
#
# `prepare` can run from any checkout: it works in a throwaway worktree of
# origin/main and leaves yours alone. The version is YY.MDD.patch from today's
# UTC date; the patch is the next free number for that date. The stage suffix
# (-alpha, -beta, none) is carried over from the current version in
# src-tauri/tauri.conf.json, so editing the suffix there is how a release
# changes stage. The notes are the `## Changelog` sections of the PRs merged
# since the last tag, under anything written by hand under `## Unreleased`.
#
# Needs `gh` logged in with write access to this repo.
set -euo pipefail

RELEASES_REPO=gettori/tori
BASE=main

usage() {
  echo "usage: scripts/release.sh prepare|status [--yes] [--extension]" >&2
}

die() {
  echo "error: $*" >&2
  exit 1
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
yes=0
extension=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) yes=1 ;;
    --extension) extension=1 ;;
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

  # The notes are the `## Changelog` sections of the PRs merged since the last
  # tag, under anything written by hand under `## Unreleased`, unless somebody
  # already wrote the section under its version.
  local last ext ext_now
  last=$(git describe --tags --abbrev=0 "origin/$BASE" 2>/dev/null) ||
    die "no tag reachable from origin/$BASE; the notes are collected from the PRs merged since the last one"
  ext=$("$work/.github/scripts/extension-ships.sh" "$last" "$version" "origin/$BASE" $([ "$extension" = 1 ] && echo --force))
  ext_now=$(node -p "require('$work/extension/package.json').version")

  local notes
  notes=$(mktemp)
  if ! grep -qx "## $version" "$work/CHANGELOG.md"; then
    local manual collected
    manual=$(.github/scripts/changelog-section.sh Unreleased "$work/CHANGELOG.md" 2>/dev/null || true)
    collected=$(RELEASES_REPO=$RELEASES_REPO .github/scripts/changelog-from-prs.sh "$last" "origin/$BASE")
    [ -n "$manual$collected$ext" ] ||
      die "nothing to release: no PR merged since $last has a '## Changelog' section with bullets, '## Unreleased' is empty, and the extension is unchanged"
    printf '%s\n' "$manual" "$collected" | awk 'NF || started { print; started = 1 }' >"$notes"
    # Replaces the Unreleased section, or goes in before the first release
    # when there is none.
    awk -v ver="$version" -v notesfile="$notes" '
      function emit() { print "## " ver; print ""; while ((getline l < notesfile) > 0) print l; print ""; emitted = 1 }
      $0 == "## Unreleased" { skipping = 1; if (!emitted) emit(); next }
      skipping && /^## / { skipping = 0 }
      skipping { next }
      /^## / && !emitted { emit() }
      { print }
    ' "$work/CHANGELOG.md" >"$work/CHANGELOG.md.new"
    mv "$work/CHANGELOG.md.new" "$work/CHANGELOG.md"
  fi
  # A section written by hand gets it too.
  local bullet="- Browser extension $ext, rolling out on the Chrome Web Store."
  if [ -n "$ext" ] && ! grep -qxF -- "$bullet" "$work/CHANGELOG.md"; then
    awk -v want="## $version" -v line="$bullet" '
      function add() {
        if (!insec) return
        if (content) { print line; printf "%s", blanks } else { print ""; print line; print "" }
        blanks = ""; insec = 0
      }
      $0 == want { insec = 1; print; next }
      insec && /^## / { add(); print; next }
      insec && /^[[:space:]]*$/ { blanks = blanks $0 "\n"; next }
      insec { printf "%s", blanks; blanks = ""; content = 1; print; next }
      { print }
      END { add() }
    ' "$work/CHANGELOG.md" >"$work/CHANGELOG.md.new"
    mv "$work/CHANGELOG.md.new" "$work/CHANGELOG.md"
  fi
  (cd "$work" && .github/scripts/changelog-section.sh "$version" >"$notes")
  # The PR body only: CHANGELOG.md says nothing about an unchanged extension.
  if [ -n "$ext" ]; then
    printf '\nBrowser extension: ships %s\n' "$ext" >>"$notes"
  else
    printf '\nBrowser extension: unchanged, stays %s\n' "$ext_now" >>"$notes"
  fi

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
  if [ -n "$ext" ]; then
    sed -i '' "s/\"version\": \"$ext_now\"/\"version\": \"$ext\"/" "$work/extension/package.json"
    [ "$(node -p "require('$work/extension/package.json').version")" = "$ext" ] ||
      die "the extension version did not land in extension/package.json"
  fi

  git -C "$work" add CHANGELOG.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
    mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.toml mobile/src-tauri/Cargo.lock extension/package.json
  git -C "$work" commit -q -m "Tori $version"
  git -C "$work" push -q origin "$branch"

  local url
  url=$(gh pr create --repo "$RELEASES_REPO" --base "$BASE" --head "$branch" \
    --title "Tori $version" --body-file "$notes")
  rm -f "$notes"

  echo
  echo "Release PR for Tori $version: $url"
  echo "Next: merge it. The Release workflow builds, signs, tags and publishes"
  echo "from the merge; scripts/release.sh status follows it."
}

# --- status ----------------------------------------------------------------

# The latest Release workflow run for the tip of main, as "<status> <url>", or
# nothing when none has started yet.
release_run() {
  gh run list --repo "$RELEASES_REPO" --workflow release.yml --branch "$BASE" --commit "$1" \
    --limit 1 --json status,conclusion,url \
    -q '.[0] | select(.) | "\(if .status == "completed" then .conclusion else .status end) \(.url)"'
}

status() {
  git fetch -q --tags origin "$BASE"
  local version tag subject state pr last ahead run
  version=$(git show "origin/$BASE:src-tauri/tauri.conf.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
  tag="v$version"
  subject=$(git log -1 --format=%s "origin/$BASE")
  state=$(release_state "$tag")
  pr=$(open_release_pr)
  last=$(git describe --tags --abbrev=0 "origin/$BASE" 2>/dev/null || true)
  ahead=$(git rev-list --count "${last:+$last..}origin/$BASE")
  run=$(release_run "$(git rev-parse "origin/$BASE")")

  echo "$BASE is at $version, tip \"$subject\""
  echo "release $tag: $state"
  echo "last tag on $BASE: ${last:-none}, $ahead commits since"
  echo "open release PR: ${pr:-none}"
  echo "Release workflow for the tip: ${run:-not started}"
  if [ -n "$pr" ]; then
    echo "next: merge the release PR; the Release workflow takes it from there"
  elif [ "$state" = published ] && [ "$last" = "$tag" ] && [ "$ahead" -eq 0 ]; then
    echo "next: nothing to release"
  elif [ "$state" = published ]; then
    echo "next: scripts/release.sh prepare, when the $ahead commit(s) since $last are ready to ship"
  elif grep -qx "## $version" <(git show "origin/$BASE:CHANGELOG.md"); then
    case "${run%% *}" in
      success) echo "next: nothing; the run finished but $tag is $state, so look at the run" ;;
      failure | cancelled) echo "next: fix the cause in an ordinary PR; merging it runs the release again" ;;
      "") echo "next: wait for the Release workflow to start, or dispatch it by hand" ;;
      *) echo "next: wait for the Release workflow" ;;
    esac
  elif [ "$ahead" -gt 0 ]; then
    echo "next: scripts/release.sh prepare"
  else
    echo "next: nothing to release"
  fi
}

case "$cmd" in
  prepare) prepare ;;
  status) status ;;
  *)
    usage
    exit 2
    ;;
esac
