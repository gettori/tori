---
summary: check-tokens fails any quoted CSS colour word like "blue"; hue ids live only in prLanes.ts and cards set --card-* vars inline
status: current
updated: 2026-11-07
source: plan "Sidebar lanes, custom groups and branch line controls" (branch left-sidebar-customization), phase 6; scripts/check-tokens.mjs:205 (CARD_HUE_FILE); src/utils/prLanes.ts (HUE_VARS)
---

# check-tokens reads a quoted hue name as a colour literal

Check 1 of `scripts/check-tokens.mjs` flags CSS named colours anywhere in `src/`, quoted strings and `[data-hue="blue"]` selectors included, tests and stories too. Card hues are identifiers (and a group's colour is stored in `tori.toml` as one of those words), so they live in one file: `src/utils/prLanes.ts`. There `HUE_VARS` maps each hue to its `--lane-<hue>-head/body` roles and icon colour, and cards set them inline, so no stylesheet, test or story spells a hue (tests compare against `LANE_HUE` and `GROUP_HUES`). The exemption is narrow, like the seti one: quoted names of hues the `lane.<hue>Head` roles declare, in that file only, after `|`, `:`, `[` or `,`. A hex, or `const x = "teal"`, still fails. Do not allowlist the whole file. A union's first member sits after `=`, so `CardHue` starts with `"accent"`, which is not a CSS colour.

## Related

- [[concept_sidebar_arrangement]]
- [[gotcha_a_translucent_role_cannot_be_a_contrast_surface]] why each hue's tints are opaque `mix()` roles
