---
summary: Solid's on() reruns when a tracked dependency invalidates even if the recomputed value is identical, wrap it in a memo
status: stale
updated: 2026-11-23
source: "Features phase 8: the right panel modes inside a Feature (personal/tori, branch `feature-workspace`, #160 phase 2, commit e01f0cf); `src/panels/Editor/Editor.tsx` (`wsKey`, `watchKey`); see [[concept_right_panel_member_scope]], [[lesson_a_reset_key_must_name_what_changed]]"
---

# Solid's `on()` re-runs on an invalidated dependency, not on a changed value

> Stale: Solid 2 has no `on()`. The same trap survives in `createEffect(compute, apply)`, where apply reruns whenever compute reruns, even on an equal value. The memo fix still works. See [[gotcha_solid_2_input_value_resets_when_its_attribute_group_reruns]].

Do NOT pass a bare accessor to `on()` and assume the effect only fires when the value differs. Why: `on` tracks the accessor's *dependencies*, so anything that invalidates them re-runs the effect even when the recomputed value is identical. `Editor.tsx`'s debug sweep keys on the workspace so that moving a Feature's active member does not kill the run; written as `on(ws, ...)` it still fired, because `ws()` reads `props.selected` and the shell rebuilds that object on every pointer move. `const wsKey = createMemo(ws)` fixes it: a memo's default equality stops the propagation at the memo. The watcher's `watchKey` memo carries the same note for the same reason, one ticket earlier, which is the tell that this is a shape rather than an incident.
