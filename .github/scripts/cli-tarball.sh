#!/usr/bin/env bash
# Pack the app's own binary as the tori CLI release asset, which gettori/packs
# CI downloads to run `tori validate-pack` and `tori packs-index`. Prints the
# tarball's path.
#
#   .github/scripts/cli-tarball.sh <path to Tori.app> <version> <out dir>
set -euo pipefail

APP="${1:?usage: cli-tarball.sh <path to .app> <version> <out dir>}"
VERSION="${2:?usage: cli-tarball.sh <path to .app> <version> <out dir>}"
OUT="${3:?usage: cli-tarball.sh <path to .app> <version> <out dir>}"

bin="$APP/Contents/MacOS/tori"
[ -x "$bin" ] || { echo "error: no executable at $bin" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$bin" "$stage/tori"
# Asked once before it ships: packs CI depends on this binary answering as the
# CLI outside its bundle. A binary that does not know the command starts the
# app instead, so the question has a deadline (perl, since macOS has no timeout).
answer=$(perl -e 'alarm 20; exec @ARGV' "$stage/tori" validate-pack 2>&1) && status=0 || status=$?
case "$status:$answer" in
  1:*"tori validate-pack <file|dir>"*) ;;
  *) echo "error: $bin does not answer as the tori CLI (exit $status)" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
tarball="$OUT/tori-cli-$VERSION-macos-universal.tar.gz"
tar -czf "$tarball" -C "$stage" tori
echo "$tarball"
