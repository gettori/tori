---
summary: tsc clean was reported from a run that predated the session's last edit, so the verify has to postdate the whole diff
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/tori, branch `topbar`); Phase 3 defect, found in Phase 4; commits 3275344 (broke), 10efde7 (fixed)"
---

# Re-run the full verify after the last edit, not the last risky one

## What happened

Phase 3's self-review reported "tsc clean" and the phase was committed as `3275344`. The typecheck had genuinely passed, and the report was still false: `tsc` was run *before* the last edit of the session, which added a `node:fs` import to `theme.test.ts` for three structural assertions about `tokens.css`. This project has no `@types/node`, so that import broke the frontend typecheck. It was found a whole phase later, by a self-review that happened to re-run the suite.

The fix was not the interesting part (the checks moved into `scripts/check-tokens.mjs`, which already reads files and already gates `pnpm test`; Vite's `?raw` was not an option because vitest stubs CSS imports to the empty string, see [[gotcha_vitest_stubs_css_imports_to_the_empty_string]]).

## Why

The ordering was not an accident, it was a judgment: the risky work that session was the colour migration across 51 files, and that is what got verified. Adding an import to a test file at the end registered as clerical. So the verify ran against the state of the world I considered dangerous rather than the state of the world I was about to commit.

That is the whole failure mode. Verification effort gets allocated by **perceived** risk, and the edits that break builds are disproportionately the ones that felt too small to re-check. A typecheck takes seconds; the belief that it did not need re-running is what cost a phase.

## What to do next time

The verify is a property of the **commit**, not of the individual edits. Re-run the whole gate immediately before reporting done or proposing a commit, with no exception for edits that feel clerical. If a claim is going into a report ("tsc clean", "tests pass"), the run that backs it has to postdate every edit in the diff being reported on.

Corollary on reporting: when this does happen, say plainly that the earlier claim was wrong rather than quietly folding the fix into later work. The claim was in the record; the correction has to be too.

## Related

- [[concept_design_token_system]] - `check-tokens.mjs`, where the assertions ended up.
- [[gotcha_vitest_stubs_css_imports_to_the_empty_string]] - why they could not stay in vitest.
