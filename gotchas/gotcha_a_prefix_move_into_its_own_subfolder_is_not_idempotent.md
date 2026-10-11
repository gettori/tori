---
summary: moving <p> to <p>/main twice yields <p>/main/main, so a store rewritten once must skip its own path mapper
status: current
updated: 2026-10-11
source: "gettori/tickets#74, convert a plain clone to the bare plus worktree layout (personal/tori, branch phase-1-block-2); src/utils/debugBreakpoints.ts moveBreakpointWorkspaces; caught by src/panels/Editor/breakpointPane.test.tsx"
---

# A prefix move into its own subfolder is not idempotent

The target `<p>/main` is still under the source `<p>`, so applying the move a second time moves the path again, to `<p>/main/main/...`. `moveBreakpointWorkspaces` first rewrote the store with `moveDeep` and then called `mapBreakpointFiles` to remap the side sets, which rewrote the store's paths a second time. Apply a move exactly once per store: after `moveDeep`, remap only what it did not touch (the dirty and bound sets). See [[concept_workspace_move]].
