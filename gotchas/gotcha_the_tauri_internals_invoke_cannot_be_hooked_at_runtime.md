---
summary: invoke on TAURI_INTERNALS is a readonly property on a non-configurable global, so wrapping it at runtime fails silently
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 1, personal/sway, branch `unified-tab-bar`), `src/utils/tracedCore.ts`, `vite.config.ts`, commit 4b8287f, [[concept_release_profile_tracing]], _2026-08-20_
---

# The Tauri internals invoke cannot be hooked at runtime

Do NOT try to wrap `invoke` by assigning to `__TAURI_INTERNALS__.invoke` or by shadowing the object it lives on. Why: `invoke` is a readonly property and `__TAURI_INTERNALS__` is itself a non-configurable global, so neither works and the failure is at runtime, not compile time. The seam that does work is build-time: alias every `@tauri-apps/api/core` import to your own module in `vite.config.ts`, production build only, which also leaves the ~300 suites that `vi.mock("@tauri-apps/api/core")` mocking exactly what they always did. Cost one full rebuild to discover.
