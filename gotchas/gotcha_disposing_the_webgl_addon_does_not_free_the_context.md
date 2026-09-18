---
summary: WebglRenderer's dispose only removes its canvas, the GL context leaks until garbage collection, call loseContext first
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 5, personal/tori, branch `unified-tab-bar`), `src/panels/Terminal/webglLru.ts`, commit 565dbf9, [[concept_webgl_context_lru]], _2026-08-20_
---

# Disposing the WebGL addon does not free the context

Do NOT assume `WebglRenderer`'s `dispose()` released the GL context. Why: dispose removes its canvas from the DOM and stops there, so the context lives until that canvas is garbage collected, which is exactly the leak a context cap exists to prevent. An eviction must record which canvases the attach added and call `WEBGL_lose_context.loseContext()` on them **before** disposing. Counting canvases cannot verify this either: an attached renderer contributes two (its own plus a 2d link layer), and a disposed renderer's canvas leaves the DOM while its context may not have, so the census counts live contexts via `getContext("webgl2")` instead.
