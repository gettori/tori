---
summary: a fresh options array resets a Kobalte select's list state and closes an open listbox, swap only while closed
status: current
updated: 2026-08-15
source: "plan \"Select wrapper and native select migration\" (personal/tori, branch `106-select`, issue #106); `src/components/Select/Select.tsx`, `Select.test.tsx` (\"an options list swapped after mount reaches the next open\"); `@kobalte/core@0.13.13`; see [[component_select]]"
---

# A Kobalte select closes when its options array identity changes

Do NOT assert that a new `options` array reaches an **open** listbox. Handing `Select.Root` a fresh array resets its list state and closes the surface, so a test that swaps while open finds `aria-expanded="false"` and no rows, which reads as "the wrapper snapshotted its options" when it did not. Swap while closed and assert on the next open, which is the real sequence anyway (AppearancePane's list arrives from a themes-folder watcher, not mid-interaction). The reactive normalization still matters and is still worth a test: without a `createMemo` the wrapper would pin the list it mounted with.
