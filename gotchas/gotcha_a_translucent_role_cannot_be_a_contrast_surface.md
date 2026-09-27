---
summary: the contrast gate cannot measure text drawn on an rgba surface, so a tint that carries text must be an opaque mix into its surface
status: current
updated: 2026-09-27
source: "plan \"Autopilot design (#201)\" (personal/tori, branch `orchestrator`); commit 30a046ea; `src/theme/contrast.ts` `ratioOn`, `src/theme/roles.ts` state tint roles; plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`), commits 6cfe26b5, 2d139c7e, 4d8a5c5d, `src/theme/roles.ts:378`"
---

# A translucent role cannot be a contrast surface

Do NOT derive a surface that carries text with `alpha()`. `ratioOn` returns null when the surface is translucent, since there is nothing opaque to composite onto, and the gate records "could not be measured" as a hard problem rather than a pass. Build it with `mix(surface, hue, amount)` into the surface it actually sits on, then name it in the text role's `on` list: `card` for the chat's `brand.wash` and `blocking.surface`, `canvas` for the sidebar's `done.*` roles. The state tints (`progress.subtle`, `needsYou.subtle`, `danger.subtle`) are built that way for this reason. Why: the foreground side composites a wash onto its surface ([[gotcha_a_translucent_role_has_no_contrast_of_its_own]]), but the surface itself has to be opaque by declaration.

## Related

- [[concept_contrast_gate]]
- [[gotcha_a_translucent_role_has_no_contrast_of_its_own]]: the foreground half of the same rule
- [[component_autopilot_parts]]: the first surfaces built on the state tints
- [[concept_a_finished_pull_request_is_kept_by_relation]]: the done row wash, mixed into the canvas
