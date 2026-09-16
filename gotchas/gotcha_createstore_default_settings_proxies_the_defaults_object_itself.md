---
summary: createStore on DEFAULT_SETTINGS proxies the object itself, the first save mutates it, origin resolution can't answer
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phases 4 and 13 (personal/sway, branch `wave-6`); `src/panels/Settings/settingsStore.ts`; commits 8342aee, 1ed1651"
---

# `createStore(DEFAULT_SETTINGS)` proxies the defaults object itself

Do NOT use `DEFAULT_SETTINGS` as the "default" layer in a resolution, and do NOT restore it in a test with `saveSettings(structuredClone(DEFAULT_SETTINGS))`. Solid's `createStore` proxies the object it is handed, so the first save rewrites `DEFAULT_SETTINGS` in place: the bottom two layers become the same data and origin resolution can never answer "user", while in tests each case passes alone and every case after the first mutation fails. Take a copy at import time (`BUILT_IN_EDITOR`) instead. Why: the repo already documented this for tests; wave 6 was the first time it bit as a production bug.
