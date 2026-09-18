---
summary: a non-keyed Show callback that reads its accessor in the body snapshots it once, later changes never reach the DOM
status: current
updated: 2026-08-15
source: "plan \"Dedupe icon and swatch grids into one IconGrid\" (personal/tori, branch `109-dedupe-icon-and-swatch-grids`, issue #109); `src/components/IconGrid/IconGrid.tsx`, `src/components/Dialogs/SpaceDialog.test.tsx`; commit 8f86c77"
---

# A non-keyed `Show` callback read once at mount freezes its value

Do NOT call a non-keyed `<Show>`'s accessor in the callback body and pass the plain result on. `{(spec) => tile(spec())}` runs the body once, when `when` first turns truthy, so `spec()` is a snapshot: later changes to that object never reach the DOM, because nothing downstream reads a signal. The block is only rebuilt when `when` toggles falsy and back, which a steadily-truthy object never does. This froze `SpaceDialog`'s "Automatic" swatch on the hue derived from the empty name while the user typed, and the entire suite was green with it, since no test watched that preview. Pass the accessor down and read it inside the JSX (`style={spec().tint ...}`) so the compiled effect subscribes. Same shape as [[gotcha_a_for_over_an_array_rebuilt_from_props_recreates_every_row]] seen from the other side: there the identity changed too often, here it never propagates at all. See [[component_icon_grid]].
