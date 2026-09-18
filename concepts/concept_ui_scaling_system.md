---
summary: one ui scale multiplier folds through the type ramp, spacing and control tokens so the whole chrome zooms as one piece
status: current
updated: 2026-07-27
source: plan "A font-driven scaling system + unified controls" (branch terminal-editor-design); Phases 1-6
---

# Font-driven UI scaling: one multiplier zooms the whole chrome

**Location:** `src/styles/tokens.css` (`--ui-scale`, `--tori-text-*`, `--tori-space-*`, `--control-*`), `src/panels/Settings/{scale.ts,settingsStore.ts}`, `src/panels/Editor/CodeEditor.tsx`

The chrome resizes as one piece. A single multiplier, `--ui-scale`, folds through every type step, every ≥2px spacing value, and every control dimension, so raising the UI font size (or zooming) is a true uniform zoom rather than a font-size-only change that leaves padding and controls stranded. The editor and terminal deliberately stay **out** of this: they carry their own independent font sizes.

## The one multiplier

`--ui-scale = (uiFontSize / 15) × zoom`, computed in the pure, DOM-free `scale.ts` (`uiScale`/`editorFontSizePx`/`terminalFontSizePx`) and painted by `settingsStore.applySettings`. The 15px design baseline means the default **rests at 1.0**, so every authored `base` px renders at its authored value at the default, and the tokens.css `--ui-scale: 1` fallback equals the runtime value at 15px (FOUC-free boot, no first-paint size flash).

Three token groups consume it, each `calc(base * var(--ui-scale))`:

- **Type ramp** `--tori-text-2xs..4xl` (9 steps: 10/11/12/13/14/15/16/18/21). Re-based from the old fixed ramp so chrome keeps its look (max rendered delta ≤0.77px) while Settings text now scales too.
- **Space scale** `--tori-space-1..8` (2/4/6/8/12/16/24/32). Every ≥2px padding/margin/gap/dimension is either a `--tori-space-*` token or an inline `calc(px * var(--ui-scale))`.
- **Control tokens** `--control-height{,-sm,-xs}` (28/24/20) + `--control-icon` (16), with **no floor** ([[component_button]] and its sibling primitives ride these).

## The one viewport exception

Every dimension above is a pure function of `--ui-scale`, which is what makes the zoom uniform. #98's `Dialog` opened the first deliberate exception: its `wide` size is `clamp(680px * var(--ui-scale), 52vw, 1040px * var(--ui-scale))`, so the panel also grows with the window.

The reasoning is content, not taste. `wide` is the size that holds grids and tables (the shortcut sheet, PR details, debug targets), where a larger window buys *columns*; the `confirm` and `sheet` sizes hold prose and a single form column, which read worse past roughly 75 characters and therefore stay fixed. The uniform-zoom invariant is unharmed because the `vw` term is bounded on both sides by scaled values: at any given window size the panel is still a fixed multiple, and nothing inside it clips relative to anything else. Treat it as a precedent for *content-shaped containers only*, not as permission to mix `vw` into the chrome. See [[component_dialog]].

## The scaling boundary

Only **≥2px spatial values scale**. Deliberately left fixed: 1px hairlines and all borders, `border-radius` (frozen to plain px, the radius token system is *not* scale-driven), box-shadow, outline, `text-underline-offset`, the `--editor-font-size`/xterm content fonts, and the macOS traffic-light ornament (its 13px dots + 8px inter-dot gap are a constant, not chrome). The guiding invariant is **uniform zoom**: scaling *all* spatial values by the one factor means nothing clips relative to anything else; partial conversion is what causes clipping, so over-inclusion is safe and under-inclusion is the bug.

## Icons are sized in CSS, never by the prop

Lucide's `size={N}` renders to the svg `width`/`height` *attributes*, where `var()`/`calc()` cannot reach, so a scaled icon must be sized by a CSS `width`/`height` on the svg (which overrides the attributes). Controls size their icons via `--control-icon`; standalone icons take a parent-scoped `svg { width/height: calc(N * var(--ui-scale)) }` rule. See [[gotcha_lucide_size_renders_to_svg_attributes_so_scale_icons_in_css]].

## Editor live-resize

The editor font reaches `.cm-content` through the `--editor-font-size` CSS var, but CodeMirror caches the char/line geometry it measured at the old size. So `CodeEditor` runs `createEffect(on(() => [settings.typography.editorFontSize, zoom()], () => view?.requestMeasure()))`: when either input changes, the cursor/gutter/scroll geometry reflows to the new font instead of lagging a frame. Zoom re-applies `--editor-font-size` (`setZoom` → `applySettings`), so both the slider and Cmd +/- paths produce a real reflow. The terminal needs no equivalent: xterm is canvas/WebGL and reads `terminalFontSize()` reactively, pushing size through its own API + refit.

## What was removed

**Zoom is reachable without the shortcut (2026-08-11).** It had been ⌘=/⌘-/⌘0 and
nothing else, so a user who never learned the keys could not find it. The
Appearance tab now shows it as a percentage, bounded by the exported `ZOOM_MIN`/
`ZOOM_MAX` so the row cannot offer a value `clampZoom` would refuse and then
display a number the app is not at. Both the row and the hotkeys go through the
now-exported `setZoom`, which is the one path that clamps to the 0.1 grid,
persists to localStorage and re-folds the result into the tokens - so the field
and the window cannot diverge. See [[concept_settings_tab_layer]].

The old `--ui-density` and `--ui-radius-scale` settings are **gone** (TS + Rust + UI): the uniform `--ui-scale` subsumes density, and radii are fixed px. This is an acknowledged one-time compat shift, `compact` users promote to comfortable, radius resets to the fixed look, and a persisted `zoom != 1` now also scales spacing. No migration codec and no global min-scale clamp (both out of scope). Because `settings.rs` has no `deny_unknown_fields`, an old `settings.json` carrying a `layout` key still loads (serde ignores it) and the next write drops it.

## Related

- [[concept_design_token_system]] — the two-tier token layer these scale-aware tokens live in
- [[component_button]] — the control family riding `--control-*`
- [[component_settings_store]] — where the formula is applied and the removed settings lived
- [[gotcha_lucide_size_renders_to_svg_attributes_so_scale_icons_in_css]]
