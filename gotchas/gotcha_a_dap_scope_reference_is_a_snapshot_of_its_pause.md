---
summary: a DAP scopes container is frozen at the last pause, so re-reading it after a confirmed write shows the old value
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phase 8 (personal/tori, branch `wave-8`); `src/utils/debugVariables.ts:264`; commit 4d396a8"
---

# A DAP scope reference is a snapshot of its pause

Do NOT re-read a container to confirm a `setVariable`. After a write that `evaluate` confirms took (`count` → 42), the container answers the old value `3`, and so does a **freshly requested** `scopes` container. The write's own response body is the only current reading for that row, and a write's effect on sibling rows is invisible until the next stop. Why: a tree that re-reads shows the old number beside a write that succeeded, and the natural conclusion is that the write did not take.
