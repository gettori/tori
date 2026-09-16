---
summary: Kobalte's tooltip content skips solid-presence unlike its dialog, so it unmounts instantly and data-closed hits nothing
status: current
updated: 2026-08-16
source: "plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (personal/sway, branch `130-re-audit-dialog-and-tooltip`, issue #130); `@kobalte/core` 0.13.13 `dist/tooltip/index.js` vs `dist/chunk/IN725QRS.js`; `src/components/Tooltip/Tooltip.module.css`"
---

# Kobalte's tooltip content is not wrapped in presence, so it can only animate in

Do NOT write a `[data-closed]` rule for a Kobalte tooltip. The dialog routes its content through `solid-presence` and a tooltip does not - `dist/tooltip/index.js` never calls `createPresence` - so tooltip content is unmounted the instant the tooltip closes and there is no closing frame for an exit keyframe to land on. The rule is not merely ineffective, it is a rule that matches nothing, which reads in review as motion that exists and does not ([[lesson_a_rule_that_matches_nothing_passes_every_guard]]). The attribute itself is a red herring: `data-closed` appears throughout the Kobalte bundle, so grepping for it proves the string exists, not that anything is mounted long enough to use it. Check `createPresence` per component instead. solid-ui reached the same conclusion by omission: its tooltip ships `animate-in fade-in-0 zoom-in-95` and no `animate-out`.
