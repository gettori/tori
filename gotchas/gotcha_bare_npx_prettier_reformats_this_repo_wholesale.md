---
summary: running bare npx prettier here reformats to its 80 column default against a hand formatted 120 column codebase
status: current
updated: 2026-07-20
source: "Status deepening: checkpoint timeline, tree revert, touched markers, live indicator (personal/sway, branch `main`); Phase 1"
---

# Bare `npx prettier` reformats this repo wholesale

Do NOT run `npx prettier --write` here, on a file or on a glob. Why: the repo has **no prettier config**, so the tool falls back to its 80-column default while this codebase is hand-formatted at roughly 120 — every touched file is rewritten end to end, burying the actual change in reformatting noise. In phase 1 this churned three pre-existing files that had nothing to do with the work; they had to be restored from the run's baseline tree and the real edits reapplied by hand. Match surrounding style manually instead.
