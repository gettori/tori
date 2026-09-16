---
summary: a backend event folding into an open modal needs an identity and still-open guard, or it resurrects a closed modal
status: current
updated: 2026-07-10
source: Unified Attach Existing Branch (personal/sway, branch code-mirror-6); `src/components/Sidebar.tsx` (`git://fetch-done` handler, `resolvePick`)
---

# A fire-and-forget backend event feeding a modal must be identity- and open-guarded

A background op that emits a completion event (`git_fetch` → `git://fetch-done{repo}`) consumed by a **global** listener to mutate an open modal (folding remote branches into the branch picker) will misfire without guards. Why: the event can arrive after the user cancelled the modal (**resurrecting** a closed one), after they reopened it for a **different** repo (folding the wrong data), or **twice** (duplicating rows). Guard the fold on both the identity (`ctx.repo === payload.repo`) **and** the modal still being open (`pickReq()`), dedupe by label into the shared map, wrap the signal update as `setPickReq(prev => prev ? … : prev)` so a race that closed it is a no-op, and clear the per-flow context (`attachCtx = null`) on submit / cancel / error. Related trap: [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]] (append, don't rebuild, so existing rows don't remount).
