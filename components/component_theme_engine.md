---
summary: a flat hex palette expands into 110 roles through one gate, structure validated in Rust, legibility gated in TypeScript
status: current
updated: 2026-07-24
source: "Native theming system: palette + roles generator (personal/tori, branch `terminal-editor-design`); Phases 1-7; commits 08c2307, ad31d34, 825c0bb, 809cbdc, db3abe9"
---

# Theme engine (palettes + role generator)

**Location:** `src/theme/` (`schema.ts`, `roles.ts`, `contrast.ts`, `admit.ts`, `resolver.ts`, `bundled.ts`, `userThemes.ts`, `index.ts`, `palettes/*.json`), `src-tauri/src/{palette,themes}.rs`, `scripts/{gen-tokens,check-tokens}.mjs`, `src/panels/Terminal/TerminalView.tsx` (`termColors`)

Tori's theming module. A theme is a **flat JSON palette of ~90 hex primitives**; one generator expands it into 110 semantic roles, which are painted onto `<html>` as inline custom properties. Five themes ship bundled (Tori Dark, Tori Light, Catppuccin Mocha, Tokyo Night, Rosé Pine Dawn), and a user drops more into `~/.config/tori/themes/`. Modelled on primer/github-vscode-theme's generator pattern; fixed by [[adr_theme_palette_roles]].

**Replaces the VS Code theme layer entirely.** `distill.ts`, `vscodeMap.ts`, `theme.rs`, `themes/{dark,light}-plus.json`, `get_theme_colors_from_path` and `pick_theme_file` are all deleted. Tori no longer imports VS Code themes, and no converter ships; an install that had one is migrated to a bundled palette and told once, by name, what it lost.

## The pipeline

```
palette JSON  ->  admit()  ->  buildRoles()  ->  applyResolved()  ->  inline props on <html>
 (primitives)     validate       derive           paint
                  + gate
```

- **`schema.ts`** - the file format. Primitives only: flat hex strings, no expressions, no references between keys. A user-authored file that cannot express computation cannot become an evaluator. `validatePalette` is the structural half.
- **`roles.ts`** - the only place derivation lives. `alpha()`, `mix()`, and `variants({dark,light})` expand the palette into 110 roles, each carrying a stable `id` and the `cssVar` CSS reads (see [[lesson_split_identity_from_consumed_name]]).
- **`contrast.ts`** - the legibility half, see [[concept_contrast_gate]].
- **`admit.ts`** - the single door. See below.
- **`resolver.ts`** - `paintRoles` writes exactly the owned key set; `applyResolved` also sets `data-theme` for the token layer's fallback.
- **`bundled.ts` / `userThemes.ts`** - the two sources; `index.ts` folds them into one `listSelectableThemes` / `getTheme` / `setTheme`.

## `admit()`: one door, two stages, in a fixed order

```ts
admit(value: unknown, source: string): { ok: true; palette: AdmittedPalette } | { ok: false; problems: string[] }
```

1. **Structural** (`validatePalette`): every key present, every value a hex colour.
2. **Legibility** (`checkPalette`): every role clears its declared floor on its declared surface.

The **order is load-bearing**. An incomplete palette does not throw - `buildRoleValues` yields `"rgba(undefined, ...)"` and `NaN`, which CSS drops silently - so running the gate first buries one missing key under a hundred unmeasurable pairs. See [[gotcha_buildroles_fails_as_strings_not_as_exceptions]].

`AdmittedPalette` is a **branded type** whose only producer is `admit()`, and the paint path accepts nothing else. So "a theme cannot reach the screen without passing the gate" is checked by `tsc` rather than remembered by callers.

## Rust validates, TypeScript gates, and the seam is deliberate

`src-tauri/src/themes.rs` reads `~/.config/tori/themes/*.json`, deserialises through `palette.rs` (`deny_unknown_fields`), runs `Palette::validate`, and hands over whatever survived plus a **named error per file that did not**. It knows nothing about contrast.

That is not an omission. The gate measures *roles*, and roles do not exist until `roles.ts` derives them, so a Rust gate would mean reimplementing `alpha()`, `mix()`, `variants()` and all 110 derivations: a second definition of the theme itself, free to drift from the first. Nothing paints until something calls `applyResolved`, so gating on the frontend still refuses a bad theme **before** the first paint rather than after it.

Bundled palettes never travel through Rust, so `admit()` is where the two paths become one. A test feeds all five bundled palettes through the user-theme code path to prove it.

## User themes on disk

- **Discovery** mirrors [[component_agent_adapter_registry]]: read the directory, validate each file, log a broken one loudly rather than swallowing it. It differs in having **no `OnceLock`** - themes are live-watched, so every call re-reads.
- **Hot reload** via `themes_watch_start`, emitting `themes://changed`, mirroring [[component_settings_store]]'s watcher. Re-applying is guarded on the active theme's *source*, so saving an unrelated theme file does not repaint the app and re-emit `THEME_APPLIED` for nothing.
- **A user theme may not claim a bundled id**, and two user files may not claim one id (the second is refused, naming both files). Last-wins would make the result depend on filename order, which nothing in the UI shows.
- **A refused theme is kept in the registry, not dropped.** `listSelectableThemes` filters it out so the picker never offers a theme that selecting would refuse, but `getTheme` still finds it - which is what lets `setTheme` answer *"cannot apply theme X: fg.default on canvas.default is 1.00"* instead of the useless *"no such theme"*.
- The Settings picker groups by source (`Bundled` / `From ~/.config/tori/themes`), and omits the user group entirely when the folder is empty rather than showing it empty.

### The two failure modes are deliberately different

| Situation | Behaviour |
|---|---|
| An id nothing provides (deleted file, typo in settings.json) | Fall back to Tori Dark **and say so**. An app with no theme at all is worse than a named error. |
| A theme that exists but fails the gate | Paint **nothing**. The app stays on what it was showing. Replacing a legible theme with the default, over an edit the user is still making, is the wrong answer. |

Problems surface as toasts, **capped at three plus a count**: the gate reports every failing pair, and a hand-edited palette can fail dozens at once.

## The `<html>` key-ownership contract

Inline props on `<html>` outrank every rule in the token layer, including `:root[data-theme="light"]`. Three writers set them, so each owns a **disjoint key set**, only ever overwrites its own keys, and never clears the element's style wholesale:

- this module owns exactly the role `cssVar`s;
- [[component_settings_store]]'s `applySettings` owns `--ui-*` and `--editor-font-*`;
- the themes watcher writes *through* this module and owns nothing of its own.

`paintRoles` **removes** an owned key the theme omits rather than leaving the previous theme's value stranded above the fallback. `applyCachedTheme` filters the FOUC cache to the owned set for the same reason: a key written by some other build would otherwise be pinned where no theme could dislodge it.

## Boot, cache, and the token layer

`tokens.css`'s two theme blocks are **generated** from the two Tori palettes into a marker-delimited region inside `@layer tokens` (`gen-tokens.mjs`, with `--check` in the guard). They are the pre-theme fallback only; the generator is the source of truth. Generating dark alone would kill light mode; regenerating the whole file would destroy the primitives, spacing, radii, motion, and `--ui-*` defaults that share it.

`applyCachedTheme` paints the last resolved map synchronously before first render. The cache is `tori.theme.v2`: the token map is namespaced by `cssVar` and every name changed in the rename, so a v1 map is discarded rather than migrated - but the *selection* (`{ kind, bundledId }`) holds no token names and is read once from v1, which is what makes a Light install boot light on the first launch after the upgrade.

## Terminal and syntax

- **The 16 ANSI slots plus cursor and selection are palette-owned roles.** They cannot be derived from the canvas and the foreground because a *program* picks the slot. `termColors()` reads 20 names via `getComputedStyle` as TS string literals, invisible to every CSS tool - so the guard has a dedicated check that asserts its own extractor (an empty scan result is an error, not a pass). `TerminalView` reassigns `term.options.theme` on `THEME_APPLIED`, no remount.
- **Syntax is 20 authored categories**, not 7 derived ones. A derived sibling ("parameter is variable, 20% toward the foreground") is a rule a port will want to break, and then the rule reads as a bug. The cost is 20 of the palette's keys, paid by every port. `HighlightStyle` order is load-bearing: CodeMirror applies every matching rule, so `t.function(t.propertyName)` must come after `t.propertyName`.

## Ports keep their hues, not Tori's fixed families

The champagne gold brand, the four session status indicators, and the two agent marks are identical across all five palettes, preserving [[adr_premium_design_system]]: an imported look must never repaint "the agent needs you". Six-way syntax distinctness is asserted for Tori's own two palettes only - Catppuccin and Tokyo Night both give `keyword` and `control` one colour, and forcing them apart would mean inventing a hue their design never chose. What every bundled palette *is* held to is completeness and the gate.

## Boundaries

- Feeds [[component_cm6_editor]] its syntax palette but does not own CM6.
- Feeds [[component_seti_icons]] the 11 icon hues; the mapping emits hue *names*, not hexes.
- Does **not** persist the chosen theme - that is [[component_settings_store]] (`appearance.theme`). This module keeps only the FOUC cache.
- One theme at a time; no per-role user overrides on top of a palette.
- `Styleguide.tsx` is the authoring workbench (live picker, ANSI row, syntax sample, icon row, gate readout). It paints through `applyResolved` directly rather than `setTheme`, so clicking through themes in a dev surface never rewrites which theme the app boots into. It lists bundled themes only.

Recorded in [[adr_theme_palette_roles]], which supersedes the importable-VS-Code-theme half of [[adr_ui_config_system]].
