---
summary: icons are lucide data made into components by createIcon, listed by hand in icons.ts, with lucide pinned exactly
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/components/Icon/createIcon.tsx; commit f2895a16
---

# Icons

`src/components/Icon/icons.ts` is the only place the app gets a glyph from. `createIcon` in `src/components/Icon/createIcon.tsx` turns a `lucide` `IconNode` into a component.

## Responsibility

- Call sites keep named components: `import { Settings } from ".../Icon/icons"`. The types are `IconGlyph` and `IconGlyphProps`.
- A new icon needs one line in `icons.ts`.
- `createIcon` carries `@__NO_SIDE_EFFECTS__`, so a build drops every icon it never imports. The desktop bundle does not contain the mobile only `QrCode`.
- `lucide` is pinned to an exact version. `gitMarks.module.css` selects on element order inside two glyphs, so a version bump can break it silently.
- The classes match what `lucide-solid` emitted, including the second class on digit names (`lucide-trash2` beside `lucide-trash-2`).

## Related

- [[adr_own_primitives_on_native_layers]] why Solid coupled packages left
- [[gotcha_vitests_node_env_gives_solid_js_its_server_build]] why a test importing icons must be `.tsx`
