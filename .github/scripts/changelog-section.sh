#!/usr/bin/env bash
# Print the CHANGELOG.md section for one version, for use as a release body.
#
# Lives here as a script rather than inline YAML so it can be run (and tested)
# locally: a release body that turns out empty is only discoverable after a tag
# is pushed, which is exactly the wrong time to find out.
#
#   .github/scripts/changelog-section.sh 0.1.0 [CHANGELOG.md]
set -euo pipefail

VERSION="${1:?usage: changelog-section.sh <version, e.g. 0.1.0> [changelog path]}"
CHANGELOG="${2:-CHANGELOG.md}"

if [ ! -f "$CHANGELOG" ]; then
  echo "error: no changelog at $CHANGELOG" >&2
  exit 1
fi

# Everything between `## <version>` and the next `## ` heading. Leading and
# trailing blank lines are dropped, interior ones kept: `blanks` holds pending
# blank lines and is only flushed once another content line proves they were
# interior rather than trailing.
section=$(awk -v want="## $VERSION" '
  $0 == want { found = 1; next }
  found && /^## / { exit }
  found {
    if ($0 ~ /^[[:space:]]*$/) { blanks = blanks $0 "\n"; next }
    printf "%s%s\n", (started ? blanks : ""), $0
    blanks = ""
    started = 1
  }
' "$CHANGELOG")

if [ -z "$section" ]; then
  echo "error: no '## $VERSION' section in $CHANGELOG" >&2
  echo "hint: add one before tagging; the release body comes from it." >&2
  exit 1
fi

printf '%s\n' "$section"
