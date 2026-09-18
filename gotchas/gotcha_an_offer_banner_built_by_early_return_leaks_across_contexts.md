---
summary: an early return that skips clearing a banner signal leaves the previous context's banner showing after a switch
status: current
updated: 2026-07-20
source: "Daily-driver polish: unseen badge, copy actions, tab peek, restore (personal/tori, branch `main`); Phase 2; `src/panels/Terminal/Terminal.tsx` (`restoreOffer` memo, `markOffered`); see [[component_tab_restore]]"
---

# An offer banner built by early-return leaks across contexts

Do NOT accumulate a "should I show this prompt" signal in an effect whose guard clauses `return` without clearing it. Why: each early return leaves the *previous* context's value in place, so a per-workspace restore banner raised for workspace A stays on screen after switching to workspace B (B's guard returns before assigning, and nothing ever set it back to null). The bug is structural, not a missing case: any new guard added later reintroduces it. Use a `createMemo` where **every** path assigns a value — return `null` from each rejection branch and the offer object from the accept branch — so the banner is derived from the current context rather than left over from an old one. Dismissal then works by adding to a `Set` the memo reads, rather than by a separate setter that can fall out of sync.
