---
summary: a deleted file's stashed text is the falsy empty string, so a truthy payload check silently drops the conflict banner
status: current
updated: 2026-07-20
source: "Status deepening: checkpoint timeline, tree revert, touched markers, live indicator (personal/sway, branch `main`); Phase 1; `src/panels/Editor/CodeEditor.tsx` (`pendingKind`); see [[component_turn_checkpoints]]"
---

# An empty-string payload reads as "no pending state"

Do NOT use a truthy check on a **payload** to mean "a deferred state exists". Why: a deleted file's stashed buffer text is `""`, which is falsy, so a truthy `pendingExternal` check concluded "no conflict pending" and silently dropped the conflict banner when the tab was reactivated — for exactly the case (deletion) where losing the banner is most destructive, since the next save would recreate the file and undo a revert. Carry an explicit discriminant (`pendingKind`) alongside the payload and branch on that. Generalizes to any "is something staged here?" test over a value whose legitimate empty case is falsy: `""`, `0`, and empty collections all lie in that position.
