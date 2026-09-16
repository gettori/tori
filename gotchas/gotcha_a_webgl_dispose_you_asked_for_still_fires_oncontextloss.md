---
summary: a deliberate WebGL eviction still fires onContextLoss seconds later from an uncleared timer, so check slot identity
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 5, personal/sway, branch `unified-tab-bar`), `src/panels/Terminal/webglLru.ts`, commit 565dbf9, [[concept_webgl_context_lru]], _2026-08-20_
---

# A WebGL dispose you asked for still fires onContextLoss

Do NOT treat an `onContextLoss` callback as proof the GPU dropped the context. Why: the renderer arms a restoration timer on `webglcontextlost` and never clears it on dispose, so a deliberate eviction fires the loss callback about 3 seconds later. Without a guard, an eviction looks like a GPU loss and triggers a re-attach of the terminal you just evicted. The callback must check that the handle is still its own slot's before acting.
