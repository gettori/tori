---
summary: caps always mounted terminals at 8 live WebGL contexts, evicting least recently visible since the browser cap fell back
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/tori, branch `unified-tab-bar`), Phase 5, commit 565dbf9, `src/panels/Terminal/webglLru.ts`, `src/panels/Terminal/TerminalView.tsx`
---

# WebGL context LRU for always-mounted terminals

Tori keeps every terminal mounted (see [[concept_workspace_tab_grouping]]), so
without a cap the number of live WebGL contexts grows with every terminal ever
opened. Browsers cap contexts at roughly 16 and evict silently, which meant a
long session drifted into a **permanent DOM-renderer fallback**: measurably
slower terminals, with nothing in the UI saying so. The fix is a page-wide LRU
that makes the cap ours, at 8, and reversible.

## How it works

`acquireWebgl(term, host)` returns a slot with `reveal` / `conceal` /
`release`. TerminalView attaches **nothing at mount** and attaches on the
activation edge, so a tab that mounts hidden pays nothing.

- **Eviction is by least-recently-*visible*, with visible pinned.** Not
  visible-only: an A/B flip between two worktrees would otherwise churn the two
  terminals it flips between, taxing the exact switch being optimised. A state
  with more visible terminals than the cap stays over cap rather than blanking
  one.
- **Eviction calls `WEBGL_lose_context.loseContext()` before disposing**,
  because disposing the addon does not free the context. `WebglRenderer`'s
  dispose removes its canvas from the DOM and stops there; the GL context lives
  until that canvas is collected. See
  [[gotcha_disposing_the_webgl_addon_does_not_free_the_context]].
- **Context loss re-attaches on the next task**, bounded at 3 losses per
  terminal, instead of falling back to the DOM renderer permanently. A failed
  attach (no WebGL2 at all) counts as a loss, so such a machine pays three
  failed constructions per terminal over a session rather than one per reveal.

Measured with 24 terminal hosts across 6 worktrees: **exactly 8 live contexts**
in all three samples of every run. Phase 1's census recorded 32 canvases at the
same shape, which was 16 attached renderers, i.e. the browser doing the capping
at its own limit.

## Why it's this way

Counting canvases cannot tell you the truth, so the census counts contexts:
`liveWebglContexts` filters xterm canvases by whether `getContext("webgl2")`
answers a context that is not lost. An attached renderer contributes two
canvases (its own and a 2d link layer), and a disposed renderer's canvas leaves
the DOM while its context may not have.

## Related

- [[component_pty_host]] - the terminals this caps
- [[concept_workspace_tab_grouping]] - why every terminal stays mounted
- [[gotcha_a_webgl_dispose_you_asked_for_still_fires_oncontextloss]] - the eviction-vs-loss ambiguity
- [[component_perf_trace_harness]] - where `liveWebglContexts` is recorded
