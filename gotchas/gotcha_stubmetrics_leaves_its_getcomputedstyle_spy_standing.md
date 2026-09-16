---
summary: stubMetrics never restores its getComputedStyle spy, so a later accessible-name lookup or axe scan in the file dies
status: current
updated: 2026-09-04
source: "\"Labelled path attachments in the chat composer\" (personal/sway, branch `bugfix-260903`), phase 2, `src/panels/Chat/Composer.test.tsx`, _2026-09-04_"
---

# `stubMetrics` leaves its `getComputedStyle` spy standing

Do not let a test that calls `stubMetrics` run before an accessible-name lookup or an axe scan in the same file: the spy answers with a plain object, so `getByRole({ name })` and `expectNoAxeViolations` both die on `style.getPropertyValue is not a function`. Why: the helper never restores the spy, so it outlives the test that asked for it, and the tests pass one at a time and fail as a file. Put `afterEach(() => vi.restoreAllMocks())` at file level.
