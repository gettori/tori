#!/usr/bin/env bash
# Cut a release: open the release PR, because `main` takes no direct push.
# Merging that PR is the last human step; the Release workflow
# (.github/workflows/release.yml) builds, signs, tags and publishes from it.
#
#   scripts/release.sh prepare   open the release PR: version bumps + changelog
#   (merge the PR on GitHub, the workflow does the rest)
#   scripts/release.sh status    say where the release stands
#
# Add --yes to prepare to skip the prompt. Without a terminal the flag is
# required, so a script or an agent never opens a release PR by accident.
# Add --force <macos|android|extension> to ship a component even when nothing
# it is built from changed (.github/scripts/ships.sh decides otherwise).
# docs/RELEASING.md walks through all of it, including what to do when a step
# fails halfway.
#
# `prepare` can run from any checkout: it works in a throwaway worktree of
# origin/main and leaves yours alone. The version is YY.MDD.patch from today's
# UTC date; the patch is the next free number for that date. The stage suffix
# (-alpha, -beta, none) is carried over from the desktop's version in
# src-tauri/tauri.conf.json, so editing the suffix there is how a release
# changes stage. Each component (macOS, Android, the browser extension) keeps
# the version of the release that last shipped it and moves to this one only
# when it ships. The notes are the `## Changelog` sections of the PRs merged
# since the last tag, under anything written by hand under `## Unreleased`.
#
# Needs `gh` logged in with write access to this repo.
set -euo pipefail

RELEASES_REPO=gettori/tori
BASE=main
COMPONENTS="macos android extension"

usage() {
  echo "usage: scripts/release.sh prepare|status [--yes] [--force macos|android|extension]..." >&2
}

die() {
  echo "error: $*" >&2
  exit 1
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
yes=0
force=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) yes=1 ;;
    --force)
      case "${2:-}" in
        macos | android | extension)
          force="$force $2"
          shift
          ;;
        *)
          usage
          exit 2
          ;;
      esac
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"

confirm() {
  [ "$yes" = 1 ] && return 0
  [ -t 0 ] || die "no terminal to ask on; pass --yes to run $cmd without the prompt"
  printf '%s [y/N] ' "$1"
  read -r answer
  [ "$answer" = y ] || die "aborted"
}

label() {
  case "$1" in
    macos) echo "macOS" ;;
    android) echo "Android" ;;
    extension) echo "browser extension" ;;
  esac
}

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

version_of() {
  local dir=$1 component=$2 file version distinct seen=""
  while IFS= read -r file; do
    version=$(read_version "$file" <"$dir/$file")
    seen="$seen$file=$version"$'\n'
  done < <(version_files "$component")
  distinct=$(printf '%s' "$seen" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')
  [ "$distinct" -eq 1 ] || die "$(label "$component") version drift: $(printf '%s' "$seen" | tr '\n' ' ')"
  echo "$version"
}

version_at() {
  local ref=$1 component=$2 file
  file=$(version_files "$component" | head -1)
  git show "$ref:$file" | read_version "$file"
}

# Chrome reads four numbers at most, so the extension drops the stage suffix.
version_for() {
  local component=$1 release=$2
  case "$component" in
    extension) echo "${release%%-*}" ;;
    *) echo "$release" ;;
  esac
}

at_release() {
  local component=$1 version=$2 release=$3
  [ "$version" = "$(version_for "$component" "$release")" ]
}

set_version() {
  local dir=$1 component=$2 from=$3 to=$4 file
  while IFS= read -r file; do
    case "$file" in
      *.toml)
        sed -i '' "s/^version = \"$from\"/version = \"$to\"/" "$dir/$file"
        (cd "$dir/$(dirname "$file")" && cargo update -q --package "$(grep -m1 '^name = ' Cargo.toml | cut -d'"' -f2)")
        ;;
      *) sed -i '' "s/\"version\": \"$from\"/\"version\": \"$to\"/" "$dir/$file" ;;
    esac
  done < <(version_files "$component")
  [ "$(version_of "$dir" "$component")" = "$to" ] || die "the $(label "$component") version did not land in every file"
}

component_line() {
  local component=$1 version=$2 release=$3 state=$4 name
  name=$(label "$component")
  if [ "$state" != ships ]; then
    echo "$name unchanged at $version"
  elif [ "$component" = extension ]; then
    echo "$name $(version_for "$component" "$release") ships, rolling out on the Chrome Web Store"
  else
    echo "$name $release ships"
  fi
}

released_version() {
  awk '!found && /^## [0-9]/ { sub(/^## /, ""); print; found = 1 }'
}

# The stage is the desktop's: editing the suffix in src-tauri/tauri.conf.json
# is how a release changes it.
stage_suffix() {
  local desktop
  desktop=$(version_of "$1" macos)
  case "$desktop" in *-*) echo "-${desktop#*-}" ;; esac
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

  local component current suffix yy mdd patch version tag
  for component in $COMPONENTS; do version_of "$work" "$component" >/dev/null; done
  current=$(released_version <"$work/CHANGELOG.md")
  [ -n "$current" ] || die "CHANGELOG.md has no versioned section"
  suffix=$(stage_suffix "$work")
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

  local out flag ships=""
  for component in $COMPONENTS; do
    flag=""
    case " $force " in *" $component "*) flag=--force ;; esac
    out=$("$work/.github/scripts/ships.sh" "$component" $flag)
    [ -z "$out" ] || ships="$ships $component"
  done
  [ -n "$ships" ] || die "nothing to release: no component changed since the release it carries; --force <component> ships one anyway"

  # The notes are the `## Changelog` sections of the PRs merged since the last
  # tag, under anything written by hand under `## Unreleased`, unless somebody
  # already wrote the section under its version.
  local last notes
  last=$(git describe --tags --abbrev=0 "origin/$BASE" 2>/dev/null) ||
    die "no tag reachable from origin/$BASE; the notes are collected from the PRs merged since the last one"
  notes=$(mktemp)
  if ! grep -qx "## $version" "$work/CHANGELOG.md"; then
    local manual collected
    manual=$(.github/scripts/changelog-section.sh Unreleased "$work/CHANGELOG.md" 2>/dev/null || true)
    collected=$(RELEASES_REPO=$RELEASES_REPO .github/scripts/changelog-from-prs.sh "$last" "origin/$BASE")
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
  # The section is the body of every component's release, so it says what the
  # others did.
  local now lines="" bullet="" line state
  for component in $COMPONENTS; do
    state=stays
    case " $ships " in *" $component "*) state=ships ;; esac
    now=$(version_of "$work" "$component")
    line=$(component_line "$component" "$now" "$version" "$state")
    lines="$lines${lines:+$'\n'}$line"
    bullet="$bullet${bullet:+; }$line"
  done
  bullet="- $bullet."
  if ! grep -qxF -- "$bullet" "$work/CHANGELOG.md"; then
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
  printf '\n%s\n' "$lines" >>"$notes"

  echo "Tori $version (tag $tag, was $current)"
  echo "--- release notes ---"
  cat "$notes"
  echo "---------------------"
  confirm "Open the release PR for Tori $version?"

  for component in $ships; do
    now=$(version_of "$work" "$component")
    set_version "$work" "$component" "$now" "$(version_for "$component" "$version")"
  done

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
  local version tag subject state pr last ahead run component now lines=""
  version=$(git show "origin/$BASE:CHANGELOG.md" | released_version)
  tag="v$version"
  subject=$(git log -1 --format=%s "origin/$BASE")
  state=$(release_state "$tag")
  pr=$(open_release_pr)
  last=$(git describe --tags --abbrev=0 "origin/$BASE" 2>/dev/null || true)
  ahead=$(git rev-list --count "${last:+$last..}origin/$BASE")
  run=$(release_run "$(git rev-parse "origin/$BASE")")
  for component in $COMPONENTS; do
    now=$(version_at "origin/$BASE" "$component")
    if at_release "$component" "$now" "$version"; then
      lines="$lines${lines:+, }$(component_line "$component" "$now" "$version" ships)"
    else
      lines="$lines${lines:+, }$(component_line "$component" "$now" "$version" stays)"
    fi
  done

  echo "$BASE is at $version, tip \"$subject\""
  echo "release $tag: $state"
  echo "components: $lines"
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
