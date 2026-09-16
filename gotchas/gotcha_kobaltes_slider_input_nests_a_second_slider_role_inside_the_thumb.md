---
summary: composing Slider.Input inside Slider.Thumb nests a second range input carrying the slider role, axe fails it as nested
status: current
updated: 2026-08-15
source: "plan \"Checkbox, Switch and Slider wrappers and control migration\" (personal/sway, branch `107-checkbox-switch-slider`, issue #107); `src/lib/slider.ts:17`, `src/components/Slider/Slider.tsx`; commit 121f892"
---

# Kobalte's `Slider.Input` nests a second slider role inside the thumb

Do NOT compose `Slider.Input` inside `Slider.Thumb`, the arrangement Kobalte's own examples show. The part renders an `<input type="range">` for form submission, and that input carries the `slider` role itself, so the thumb ends up containing a second slider: axe fails it as `nested-interactive` and `getByRole("slider")` matches two elements instead of one. Sway's `slider.ts` does not re-export the part at all, because nothing here submits a form and the thumb already carries the value and the label association. See [[component_boolean_controls]].
