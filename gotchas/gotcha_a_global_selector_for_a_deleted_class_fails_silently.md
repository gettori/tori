---
summary: css modules keeps a global() rule for a deleted class, removing a component without grepping css leaves a dead selector
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown (branch `navigation`, phase 8 follow-up); `src/components/Toolbar/Toolbar.module.css`; commit 20243e5
---

# A :global() selector for a deleted class fails silently

When removing a component, grep `.css` too, not just the code. CSS Modules
accepts a rule for a class nothing emits any more, so `:global(.pi-icon)`
survived deleting `PiIcon` and matched nothing forever. Why: `tsc` does not read
stylesheets, and a token/lint guard that checks colour literals and `var()`
resolution says nothing about selectors - there is no tool in this repo that
notices. Only a human opening the file will.
