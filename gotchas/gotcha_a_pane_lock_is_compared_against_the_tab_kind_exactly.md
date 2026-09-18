---
summary: a pane lock refuses only its named kind, and homePane falls to the first pane when every pane is locked away
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Tori's own commands as tabs in a Shells workspace\" (personal/tori, branch `standalone-terminals`, issue #166), Phase 2; `src/layout/tabPlacement.ts` (`placementRefusal`), `src/layout/shellsWorkspace.ts:11`, `src/App.tsx` (`filePane`); commit `30f1ea9`"
---

# A pane lock is compared against the tab kind exactly

Do NOT lock a pane to a kind and assume every other kind is refused: `placementRefusal` answers only `lock !== tab.kind`, while `homePane` **falls back to the first pane** when every pane in a workspace is locked away from the kind it was asked about. In the one-pane Shells workspace that made `filePane()` answer the command pane, so the editor would have dressed a terminal column as its own. That workspace has since dropped its lock entirely (it holds two kinds now), which is the other half of the same lesson: a lock names exactly one kind, so it stops fitting the moment a pane holds two. Read the pane id back off the seeded tree rather than restating it, too: a lock written for an id the layout does not have silently admits everything.
