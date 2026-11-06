#!/usr/bin/env bash
# gettori/packs CI runs this binary as the tori CLI, so it must answer as one
# outside its bundle. Asked with a deadline, since a binary that does not know
# the command starts the app (perl, since macOS has no timeout).
#
#   .github/scripts/check-cli.sh path/to/Tori.app
set -euo pipefail

APP="${1:?usage: check-cli.sh <path to .app>}"
bin="$APP/Contents/MacOS/tori"
[ -x "$bin" ] || { echo "error: no executable at $bin" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$bin" "$stage/tori"

answer=$(perl -e 'alarm 20; exec @ARGV' "$stage/tori" validate-pack 2>&1) && status=0 || status=$?
case "$status:$answer" in
  1:*"tori validate-pack <file|dir>"*) echo "ok: $bin answers as the tori CLI" ;;
  *) echo "error: $bin does not answer as the tori CLI (exit $status)" >&2; exit 1 ;;
esac
