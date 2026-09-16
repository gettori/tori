---
summary: Kobalte's toast store is module global and only clears on close, so leftover toasts leak into the next test or region
status: current
updated: 2026-08-15
source: "plan \"Toasts onto Kobalte Toast\" (personal/sway, branch `105-toasts`, issue #105); `src/components/Toasts/Toasts.test.tsx`; `@kobalte/core@0.13.13` `dist/chunk/DX4MAOJL.js:259`; see [[component_toasts]]"
---

# Kobalte's toast store outlives the region that shows it

`toaster.show()` writes to a module-global store, and a toast leaves it only by closing (presence exit), never by its region unmounting. So a toast still alive when a test ends renders again in the next test's region, and two regions mounted at once show every toast twice, because both carry an undefined `regionId` and the filter compares it by equality. Call `toaster.clear()` in `afterEach` and in any Storybook decorator; mount exactly one region in the app.
