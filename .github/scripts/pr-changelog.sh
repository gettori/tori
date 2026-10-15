#!/usr/bin/env bash
# Print the `## Changelog` section of a pull request body, read from stdin, as
# the bullets that go into CHANGELOG.md. Exits nonzero when the section is
# missing or empty, or when a top-level line is not a `- ` bullet. The single
# word `none` means the PR ships nothing a user would notice: that prints
# nothing and exits 0.
#
# One parser for two callers: changelog.yml checks every PR with it, and
# changelog-from-prs.sh collects the merged ones at release time, so what the
# check accepts is exactly what the release collects.
#
#   gh pr view 283 --json body -q .body | .github/scripts/pr-changelog.sh
set -euo pipefail

# Everything between `## Changelog` and the next `## ` heading, with the
# template's HTML comments removed first so an untouched template reads as
# empty rather than as guidance text. Leading and trailing blank lines are
# dropped, interior ones kept, same as changelog-section.sh.
section=$(sed -e 's/<!--.*-->//g' | awk '
  /<!--/ { skip = 1 }
  skip { if (/-->/) { skip = 0 }; next }
  $0 == "## Changelog" { found = 1; next }
  found && /^## / { exit }
  found {
    if ($0 ~ /^[[:space:]]*$/) { blanks = blanks $0 "\n"; next }
    printf "%s%s\n", (started ? blanks : ""), $0
    blanks = ""
    started = 1
  }
  END { exit !found }
') || {
  echo "error: the PR body has no '## Changelog' section" >&2
  exit 1
}

if [ -z "$section" ]; then
  echo "error: the '## Changelog' section is empty; write the bullets a user should read, or 'none'" >&2
  exit 1
fi

case "$(printf '%s' "$section" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
  none | none. | -none | -none.) exit 0 ;;
esac

bad=$(printf '%s\n' "$section" | grep -v -E '^(- |[[:space:]]|$)' || true)
if [ -n "$bad" ]; then
  echo "error: every top-level line of '## Changelog' must be a '- ' bullet; these are not:" >&2
  printf '  %s\n' "$bad" >&2
  exit 1
fi

printf '%s\n' "$section"
