---
summary: the contrast gate cannot measure text drawn on an rgba surface, so a tint that carries text must be an opaque mix into card
status: current
updated: 2026-09-24
source: "plan \"Autopilot design (#201)\" (personal/tori, branch `orchestrator`); commit 30a046ea; `src/theme/contrast.ts` `ratioOn`, `src/theme/roles.ts` state tint roles"
---

# A translucent role cannot be a contrast surface

Do NOT derive a surface that carries text with `alpha()`. `ratioOn` returns null when the surface is translucent, since there is nothing opaque to composite onto, and the gate records "could not be measured" as a hard problem rather than a pass. Build it with `mix(p.card, hue, amount)` the way `brand.wash` and `blocking.surface` are, then name it in the text role's `on` list. The state tints (`progress.subtle`, `needsYou.subtle`, `danger.subtle`) are built that way for this reason. Why: the foreground side composites a wash onto its surface ([[gotcha_a_translucent_role_has_no_contrast_of_its_own]]), but the surface itself has to be opaque by declaration.

## Related

- [[concept_contrast_gate]]
- [[gotcha_a_translucent_role_has_no_contrast_of_its_own]]: the foreground half of the same rule
- [[component_autopilot_parts]]: the first surfaces built on the state tints
