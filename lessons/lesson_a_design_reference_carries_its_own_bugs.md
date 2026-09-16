---
summary: a copied design reference can name a variable the real library never sets, verify claims against the dependency itself
status: current
updated: 2026-08-16
source: "plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (personal/sway, branch `130-re-audit-dialog-and-tooltip`, issue #130, part of #93); `src/components/Tooltip/Tooltip.module.css`, `@kobalte/core` 0.13.13; adversary pass on the plan draft"
---

# A design reference carries its own bugs, so verify it against the substrate

[[adr_solid_ui_reference]] adopts solid-ui as the answer to "how should this look", which is a real saving and also a quiet transfer of trust: values copied from a reference arrive pre-approved in a way values invented locally never do. #130 found the reference wrong on the first line it was asked about.

solid-ui's tooltip sets `origin-[var(--kb-popover-content-transform-origin)]`. Kobalte namespaces that property per component, and a tooltip is handed `--kb-tooltip-content-transform-origin`; the popover name is never set on a tooltip, so the declaration resolves to nothing, is dropped, and the zoom animates from the content's centre. It looks fine, because a centred zoom looks like a zoom. The reference has presumably shipped it that way for as long as the file has existed.

Copying it verbatim would have failed twice over: `check-tokens.mjs` check 3 rejects a bare `var(--kb-*)` outright, so the build would have broken on the *guard* rather than on the bug, and fixing the guard complaint (adding a fallback) would have left the wrong name in place and the bug shipped silently behind a passing build. The near-miss is the point: the mechanical gate would have been satisfied by a change that did not address the actual defect.

**The rule.** A reference gives you the *shape* - which parts, what proportions, which relationships. Anything it asserts about the substrate (a variable name, an attribute, a lifecycle guarantee) is a claim to check against the substrate itself, because the reference is a separate codebase with its own bugs and its own version drift. The check is cheap: one grep of the installed dependency. #130 ran it on three claims and one was wrong.

The same pass found two more substrate facts the reference could not have told us either way, both of which changed the plan: Kobalte's tooltip has no `createPresence` (so it can animate in and never out), and `solid-presence` skips an exit entirely when both directions share an animation name. Neither is discoverable from solid-ui's CSS; both are discoverable in ten seconds from `node_modules`.

## Related

- [[adr_solid_ui_reference]] - the decision this qualifies, not one it contradicts
- [[gotcha_solid_uis_tooltip_names_the_popovers_transform_origin_variable]] - the specific trap
- [[gotcha_kobaltes_tooltip_content_is_not_wrapped_in_presence_so_it_can_only_animate_in]]
- [[gotcha_solid_presence_decides_there_is_no_exit_when_both_directions_share_an_animation_name]]
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] - what a dropped declaration looks like from the outside
- [[component_tooltip]] - where the corrected value lives
