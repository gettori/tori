---
summary: a Show child with no declared parameter is not a render callback, so it memoizes forever and keyed does nothing
status: current
updated: 2026-08-16
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/tori, branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); `src/components/Combobox/Combobox.tsx:190`; commit `9d471b7`"
---

# A zero-parameter `Show` child is not a callback, so `keyed` does nothing

Do NOT write `<Show when={x} keyed>{() => <Thing />}</Show>`. Solid only treats a function child as a render callback when it **declares a parameter** (`typeof child === "function" && child.length > 0`); with none it hands the function straight back, which memoises to the same reference forever, so the children are never rebuilt and `keyed` is silently inert. It fails as "my remount is not happening" with no error and no type complaint, and it survives a `console.log` inside the function because the function still runs, just not again. Declare the parameter even when you do not want it: `{(_signature) => <Thing />}`. Third entry in this family, after [[gotcha_solids_show_callback_carries_the_when_value_so_a_boolean_guard_yields_true]] and [[gotcha_a_non_keyed_show_callback_read_once_at_mount_freezes_its_value]]; `Show`'s child contract has now cost time three separate ways.
